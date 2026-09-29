// The `409` loop guard (the fabric's design of the agent tools, §2.3: a
// harness refuses a prompt of a tree it is waiting in). A harness serves one turn at a time and cannot serve a
// prompt while its model waits inside a blocking tool call, so a prompt of a
// tree the harness is waiting in would wait until the turn ends, which is
// never when the turn is what it waits for. The guard refuses such a prompt
// at once with `409` instead.
//
// Built from the SDK's two hooks and the fabric's scope, nothing else:
//
//   - the request interceptor, placed after the fabric's tracing interceptor
//     so it runs inside the scope tracing bound, keeps the served request by
//     that scope object for the handler's duration; an arriving request
//     whose root a served request is *waiting* in is refused before `next()`
//     — the caller gets no ack and a §9 error with code 409;
//   - the prompt interceptor, on the plugin's `Agents` client, runs in the
//     async context `prompt()` was called in — the tool call's, which the
//     add-on binds to the served request's scope — and marks that request
//     as waiting;
//   - the marks live exactly as long as the served request: its entry is
//     removed when `next()` settles.
//
// The root is read from the scope tracing bound, never from the envelope:
// tracing already validated and adopted (or minted) it, so the guard sees
// one value with one meaning. Without tracing's interceptor before it the
// guard sees no scope and admits everything.
//
// Stated honestly: the guard refuses a legitimate second prompt of the same
// tree that arrives while the harness waits in it, a sibling delegation the
// same coordinator issues with `wait: false`. The harness serves one turn at
// a time anyway, so that prompt would have queued behind the wait; the guard
// turns the queue into a refusal the caller sees at once.
//
// For the harness add-ons under `plugins/`, every one of which returns the
// guard's two interceptors after tracing's. TypeScript only: the plugins
// are, and the guard puts nothing on the wire but the SDK's §9 error.

import { RequestRejectedError, type RequestInterceptor } from "@synadia-ai/agent-service";
import type { PromptInterceptor } from "@synadia-ai/agents";
import { activeTrace, type TraceScope } from "./trace.js";

/** The §9 code the guard refuses with. */
export const LOOP_GUARD_CODE = 409;

/** The description the refused caller sees, for `rootId`. */
export function loopGuardDescription(rootId: string): string {
  return (
    `the agent's model is waiting inside a prompt of this tree (root ${rootId}); ` +
    "a prompt of the same tree cannot be served until that call returns"
  );
}

interface Served {
  readonly rootId: string;
  waiting: boolean;
}

export interface LoopGuard {
  /** For the service, after the fabric's tracing interceptor. */
  readonly requestInterceptor: RequestInterceptor;
  /** For the plugin's client, next to the fabric's prompt interceptor. */
  readonly promptInterceptor: PromptInterceptor;
  /** `true` while a served request of tree `rootId` is open. */
  serving(rootId: string): boolean;
  /** `true` while a served request of tree `rootId` waits inside a prompt. */
  waiting(rootId: string): boolean;
}

export function loopGuard(): LoopGuard {
  // Every open served request, by the scope object tracing bound around its
  // handler — the same object `aroundToolCall` rebinds, so a prompt sent
  // from the tool call finds its request here — and by root for the check.
  const byScope = new Map<TraceScope, Served>();
  const byRoot = new Map<string, Set<Served>>();

  const waiting = (rootId: string): boolean => {
    const entries = byRoot.get(rootId);
    if (entries === undefined) return false;
    for (const entry of entries) if (entry.waiting) return true;
    return false;
  };

  return {
    requestInterceptor: {
      async aroundRequest(_ctx, next) {
        const scope = activeTrace();
        if (scope === undefined) {
          // No tracing before this interceptor: nothing to key on, nothing to guard.
          await next();
          return;
        }
        const { rootId } = scope;
        if (waiting(rootId)) {
          throw new RequestRejectedError(LOOP_GUARD_CODE, loopGuardDescription(rootId));
        }
        const entry: Served = { rootId, waiting: false };
        byScope.set(scope, entry);
        let ofRoot = byRoot.get(rootId);
        if (ofRoot === undefined) byRoot.set(rootId, (ofRoot = new Set()));
        ofRoot.add(entry);
        try {
          await next();
        } finally {
          byScope.delete(scope);
          ofRoot.delete(entry);
          if (ofRoot.size === 0) byRoot.delete(rootId);
        }
      },
    },
    promptInterceptor: {
      beforePrompt() {
        // The scope in the tool call's context is the served request's own
        // object; a prompt from any other context marks nothing.
        const scope = activeTrace();
        const entry = scope === undefined ? undefined : byScope.get(scope);
        if (entry !== undefined) entry.waiting = true;
      },
    },
    serving: (rootId) => byRoot.has(rootId),
    waiting,
  };
}
