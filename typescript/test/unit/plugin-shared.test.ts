// What the harness add-ons under `plugins/` share, on its own: the `409`
// loop guard behind the fabric's tracing interceptor, and the one setting.
// The add-ons' own suites drive both through their factories and a fake of
// their plugin; here there is no plugin at all.

import { describe, expect, it } from "vitest";
import type { RequestInterceptorContext } from "@synadia-ai/agent-service";
import type { PromptInterceptorContext } from "@synadia-ai/agents";
import {
  activeTrace,
  DEFAULT_EDGE_SUBJECT,
  EDGE_SUBJECT_OPTION,
  EDGE_SUBJECT_VAR,
  fabricTracing,
  LOOP_GUARD_CODE,
  loopGuard,
  loopGuardDescription,
  resolveEdgeSubject,
  type TraceScope,
} from "../../src/index.js";

const ROOT = "2".repeat(32);

function ctxFor(threadId: string, rootId: string): RequestInterceptorContext {
  return {
    envelope: { prompt: "hi", extras: { thread_id: threadId, root_id: rootId } },
    sender: undefined,
    subject: "agents.prompt.x.team.y",
    headers: undefined,
  };
}

describe("loopGuard", () => {
  it("refuses a prompt of a tree a served request waits in, and only while it waits", async () => {
    const tracing = fabricTracing({ edgeSubject: null });
    const guard = loopGuard();
    const serve = (threadId: string, handler: () => Promise<void>): Promise<void> =>
      tracing.requestInterceptor.aroundRequest(ctxFor(threadId, ROOT), () =>
        guard.requestInterceptor.aroundRequest(ctxFor(threadId, ROOT), handler),
      );

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let served: TraceScope | undefined;
    const first = serve("1".repeat(32), async () => {
      served = activeTrace();
      // The model prompts someone from inside the served request.
      await guard.promptInterceptor.beforePrompt({} as PromptInterceptorContext);
      await held;
    });
    await Promise.resolve();
    expect(served?.rootId).toBe(ROOT);
    expect(guard.serving(ROOT)).toBe(true);
    expect(guard.waiting(ROOT)).toBe(true);

    await expect(serve("3".repeat(32), () => Promise.resolve())).rejects.toMatchObject({
      name: "RequestRejectedError",
      code: LOOP_GUARD_CODE,
      description: loopGuardDescription(ROOT),
    });

    release();
    await first;
    expect(guard.serving(ROOT)).toBe(false);
    await serve("4".repeat(32), () => Promise.resolve());
  });

  it("admits everything when no scope is bound before it", async () => {
    const guard = loopGuard();
    let ran = 0;
    await guard.requestInterceptor.aroundRequest({} as never, () => {
      ran++;
      return Promise.resolve();
    });
    expect(ran).toBe(1);
    expect(guard.waiting(ROOT)).toBe(false);
  });
});

describe("resolveEdgeSubject", () => {
  it("prefers the option, then the variable, then the default", () => {
    expect(resolveEdgeSubject({}, {})).toBe(DEFAULT_EDGE_SUBJECT);
    expect(resolveEdgeSubject({}, { [EDGE_SUBJECT_VAR]: "TRACE.v" })).toBe("TRACE.v");
    expect(
      resolveEdgeSubject({ [EDGE_SUBJECT_OPTION]: "TRACE.o" }, { [EDGE_SUBJECT_VAR]: "TRACE.v" }),
    ).toBe("TRACE.o");
    expect(resolveEdgeSubject({ [EDGE_SUBJECT_OPTION]: null }, {})).toBeNull();
  });
});
