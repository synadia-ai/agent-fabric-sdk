// The `409` loop guard (the fabric's design of the agent tools, §2.3). A
// harness serves one turn at a time and cannot serve a prompt while its
// model waits inside a call to another agent, so a prompt of a tree the
// harness is waiting in would wait until the turn ends, which is never when
// the turn is what it waits for. The guard refuses such a prompt at once
// with `409` instead.
//
// A served request is *waiting* from the moment its model sends a prompt to
// another agent until every call it has open has settled — completed,
// failed, cancelled or expired:
//
//   - a blocking `prompt_agent`: from its send until it returns;
//   - a call started with `wait: false`: for as long as it is open, since
//     the model may `wait_agent` on it at any moment;
//   - no open call: not waiting, and a prompt of the tree is admitted.
//
// Built from the SDK's two hooks, the add-ons' `aroundToolCall` and the
// fabric's scope, nothing else:
//
//   - the request interceptor, placed after the fabric's tracing interceptor
//     so it runs inside the scope tracing bound, keeps the served request by
//     that scope object for the handler's duration; an arriving request
//     whose root a served request is waiting in is refused before `next()`
//     — the caller gets no ack and a §9 error with code 409;
//   - the prompt interceptor, on the plugin's `Agents` client, runs in the
//     async context `prompt()` was called in — the tool call's, which the
//     add-on binds to the served request's scope — and marks that request
//     as waiting;
//   - `aroundToolCall`, which the add-on calls around every agent-tool call
//     of the served request, lifts the mark when a tool result says no call
//     is open (`AgentTools` puts `open_calls` on every result while one is)
//     and no other agent-tool call of the request is still running;
//   - the marks live no longer than the served request: its entry is
//     removed when `next()` settles.
//
// The mark falls at a tool result, so a call that settles while the model
// runs no agent tool — one started with `wait: false` that fails or expires
// meanwhile — keeps it until the model's next agent-tool result or the end
// of the served request, whichever comes first. `AgentTools` asks the model
// to collect its open calls before it answers, and ends them with the
// served prompt; how long a call can stay open is its own runtime limit.
//
// A result the guard cannot read — a tool call that threw, or a wrapper that
// returned something other than the tool's result object — leaves the mark
// as it was: refusing a prompt the harness could have served costs the
// caller a retry, admitting one it cannot serve costs both sides the wait.
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
// guard's two interceptors after tracing's and calls its `aroundToolCall`
// in its own. TypeScript only: the plugins are, and the guard puts nothing
// on the wire but the SDK's §9 error.

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
  /** Set by a prompt sent from the request; lifted when its calls have settled. */
  waiting: boolean;
  /** The request's agent-tool calls still running. */
  running: number;
  /** The open calls the last readable tool result counted. */
  open: number;
}

export interface LoopGuard {
  /** For the service, after the fabric's tracing interceptor. */
  readonly requestInterceptor: RequestInterceptor;
  /** For the plugin's client, next to the fabric's prompt interceptor. */
  readonly promptInterceptor: PromptInterceptor;
  /**
   * For the add-on's `aroundToolCall`: runs `run` once, synchronously, and
   * returns its value untouched, a promise included. `scope` is the served
   * request's, the one tracing bound around its handler; with another or
   * none the call is only run.
   */
  aroundToolCall<T>(scope: TraceScope | undefined, run: () => T): T;
  /** `true` while a served request of tree `rootId` is open. */
  serving(rootId: string): boolean;
  /** `true` while a served request of tree `rootId` waits on a call it made. */
  waiting(rootId: string): boolean;
}

/** `open_calls` of an `AgentTools` result: `0` when absent, `undefined` when unreadable. */
function openCalls(result: unknown): number | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const open = (result as { open_calls?: unknown }).open_calls;
  if (open === undefined) return 0;
  return typeof open === "number" && Number.isInteger(open) && open >= 0 ? open : undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
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

  // One agent-tool call of `entry` has ended, with `result` when it returned.
  const toolCallEnded = (entry: Served, returned: boolean, result?: unknown): void => {
    entry.running -= 1;
    const open = returned ? openCalls(result) : undefined;
    if (open === undefined) return;
    entry.open = open;
    if (entry.running === 0 && entry.open === 0) entry.waiting = false;
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
        const entry: Served = { rootId, waiting: false, running: 0, open: 0 };
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
    aroundToolCall(scope, run) {
      const entry = scope === undefined ? undefined : byScope.get(scope);
      if (entry === undefined) return run();
      entry.running += 1;
      let value: ReturnType<typeof run>;
      try {
        value = run();
      } catch (err) {
        toolCallEnded(entry, false);
        throw err;
      }
      if (isThenable(value)) {
        void value.then(
          (result) => toolCallEnded(entry, true, result),
          () => toolCallEnded(entry, false),
        );
      } else {
        toolCallEnded(entry, true, value);
      }
      return value;
    },
    serving: (rootId) => byRoot.has(rootId),
    waiting,
  };
}
