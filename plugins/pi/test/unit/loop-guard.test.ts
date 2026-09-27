// The `409` loop guard, through the extension's own interceptors and the
// fake plugin: a prompt of a tree PI's model waits in is refused at once, a
// prompt of another tree is admitted, and the mark goes with the request.

import { describe, expect, it } from "vitest";
import { activeTrace, bindActiveTrace, type TraceScope } from "@synadia-ai/agent-fabric";
import {
  createFabricExtension as createExtension,
  LOOP_GUARD_CODE,
  loopGuard,
  loopGuardDescription,
} from "../../src/index.js";
import { extensionContext, phaseOne, serve } from "../support/fake-plugin.js";

const T1 = "1".repeat(32);
const R = "2".repeat(32);
const S = "3".repeat(32);
const NO_ENV: NodeJS.ProcessEnv = {};

/** PI's model calls `prompt_agent` inside the served request: phase one of the client's interceptors. */
async function modelPrompts(
  ext: ReturnType<typeof createExtension>,
  request: Parameters<NonNullable<NonNullable<typeof ext.events>["aroundToolCall"]>>[0],
): Promise<void> {
  await ext.events!.aroundToolCall!(request, "prompt_agent", () =>
    phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_pi" }),
  );
}

describe("the loop guard", () => {
  it("refuses a prompt of the tree PI waits in with 409, and admits it once the wait is over", async () => {
    const ext = createExtension(extensionContext(), NO_ENV);
    const first = serve(ext, "r1", { thread_id: T1, root_id: R }, "ACME.coordinator");
    await first.accepted;

    // Before the model prompts anyone, a second prompt of the tree is served.
    const early = serve(ext, "r2", { thread_id: "4".repeat(32), root_id: R });
    await early.accepted;
    await early.end();

    await modelPrompts(ext, first.request);

    // Now the callee prompts PI back, in the same tree: refused, no ack.
    const back = serve(ext, "r3", { thread_id: "5".repeat(32), root_id: R }, "ACME.researcher");
    await expect(back.accepted).rejects.toMatchObject({
      name: "RequestRejectedError",
      code: LOOP_GUARD_CODE,
      description: loopGuardDescription(R),
    });
    await expect(back.done).rejects.toMatchObject({ code: 409 });
    expect(ext.events!.providerHeaders!(back.request)).toBeUndefined();

    // A prompt of another tree queues as it always did.
    const other = serve(ext, "r4", { thread_id: "6".repeat(32), root_id: S });
    await other.accepted;
    await other.end();

    // The served prompt ends; its mark goes with it.
    await first.end();
    const later = serve(ext, "r5", { thread_id: "7".repeat(32), root_id: R });
    await later.accepted;
    await later.end();
  });

  it("keeps the description on one line, under the SDK's cap", () => {
    const description = loopGuardDescription(R);
    expect(description).not.toMatch(/[\r\n]/);
    expect(description.length).toBeLessThanOrEqual(200);
  });

  it("marks nothing for a prompt sent outside a served request", async () => {
    const ext = createExtension(extensionContext(), NO_ENV);
    // A prompt from PI's own client with a scope of someone else's bound —
    // not one the guard serves — and one from no scope at all.
    const foreign: TraceScope = { threadId: T1, rootId: R, turnCountHint: 0 };
    await bindActiveTrace(foreign, () => phaseOne(ext.promptInterceptors!));
    await phaseOne(ext.promptInterceptors!);
    const served = serve(ext, "r1", { thread_id: "8".repeat(32), root_id: R });
    await served.accepted;
    await served.end();
  });

  it("marks the request the tool call belongs to, not another of the same tree", async () => {
    const ext = createExtension(extensionContext(), NO_ENV);
    const a = serve(ext, "a", { thread_id: T1, root_id: R });
    const b = serve(ext, "b", { thread_id: "9".repeat(32), root_id: R });
    await a.accepted;
    await b.accepted;
    await modelPrompts(ext, a.request);
    // Ending `b` does not lift `a`'s mark.
    await b.end();
    await expect(
      serve(ext, "c", { thread_id: "a".repeat(32), root_id: R }).accepted,
    ).rejects.toMatchObject({
      code: 409,
    });
    await a.end();
    const after = serve(ext, "d", { thread_id: "b".repeat(32), root_id: R });
    await after.accepted;
    await after.end();
  });

  it("stands alone: admits everything when no scope is bound before it", async () => {
    const guard = loopGuard();
    let ran = 0;
    await guard.requestInterceptor.aroundRequest({} as never, () => {
      ran++;
      expect(activeTrace()).toBeUndefined();
      return Promise.resolve();
    });
    expect(ran).toBe(1);
    expect(guard.serving(R)).toBe(false);
    expect(guard.waiting(R)).toBe(false);
  });
});
