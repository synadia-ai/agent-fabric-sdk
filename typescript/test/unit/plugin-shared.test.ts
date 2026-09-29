// What the harness add-ons under `plugins/` share, on its own: the `409`
// loop guard behind the fabric's tracing interceptor, and the one setting.
// The add-ons' own suites drive both through their factories and a fake of
// their plugin; here there is no plugin at all.

import { describe, expect, it } from "vitest";
import type { RequestInterceptorContext } from "@synadia-ai/agent-service";
import type { PromptInterceptorContext } from "@synadia-ai/agents";
import {
  activeTrace,
  bindActiveTrace,
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

describe("loopGuard: the mark falls when the request's calls have settled", () => {
  const OTHER_ROOT = "5".repeat(32);
  let threads = 0;
  const nextThread = (): string => (++threads).toString(16).padStart(32, "0");

  /** A served request held open until `end()`, and its model's agent-tool calls. */
  function harness() {
    const tracing = fabricTracing({ edgeSubject: null });
    const guard = loopGuard();
    const serve = (rootId: string, handler: () => Promise<void>): Promise<void> => {
      const threadId = nextThread();
      return tracing.requestInterceptor.aroundRequest(ctxFor(threadId, rootId), () =>
        guard.requestInterceptor.aroundRequest(ctxFor(threadId, rootId), handler),
      );
    };
    const open = async (rootId = ROOT) => {
      let end!: () => void;
      const ended = new Promise<void>((r) => (end = r));
      let scope: TraceScope | undefined;
      let started!: () => void;
      const running = new Promise<void>((r) => (started = r));
      const done = serve(rootId, async () => {
        scope = activeTrace();
        started();
        await ended;
      });
      await running;
      /**
       * One agent-tool call, bound to the request's scope as the add-ons bind
       * it: `prompts` when it sends a prompt, `result` what it returns.
       */
      const toolCall = <T>(result: Promise<T> | T, prompts = false): Promise<T> =>
        Promise.resolve(
          bindActiveTrace(scope!, () =>
            guard.aroundToolCall(scope, () => {
              if (prompts) {
                void guard.promptInterceptor.beforePrompt({} as PromptInterceptorContext);
              }
              return result;
            }),
          ),
        );
      return {
        toolCall,
        end: async () => {
          end();
          await done;
        },
      };
    };
    const admitted = (rootId = ROOT) => serve(rootId, () => Promise.resolve());
    const refused = (rootId = ROOT) =>
      expect(admitted(rootId)).rejects.toMatchObject({ code: LOOP_GUARD_CODE });
    return { guard, open, admitted, refused };
  }

  it("a blocking call: refused while it runs, admitted once it returned, the request still open", async () => {
    const { guard, open, admitted, refused } = harness();
    const served = await open();
    let settle!: (r: unknown) => void;
    const call = served.toolCall(new Promise((r) => (settle = r)), true);
    await refused();
    expect(guard.waiting(ROOT)).toBe(true);
    settle({ status: "completed", call_id: "c1", text: "done" });
    await call;
    expect(guard.waiting(ROOT)).toBe(false);
    expect(guard.serving(ROOT)).toBe(true);
    await admitted();
    await served.end();
  });

  it.each([
    ["wait_agent returned it", { status: "completed", call_id: "c1" }],
    ["cancel_agent cancelled it", { cancelled: ["c1"] }],
    ["wait_agent found it failed", { status: "failed", call_id: "c1", error: "boom" }],
    ["list_agent_calls found it expired", { calls: [{ call_id: "c1", status: "expired" }] }],
  ])("a call with wait: false: refused while it is open, admitted after %s", async (_, settled) => {
    const { open, admitted, refused } = harness();
    const served = await open();
    await served.toolCall({ status: "running", call_id: "c1", open_calls: 1 }, true);
    await refused();
    // Another tool result that still counts it open keeps the mark.
    await served.toolCall({ agents: [], open_calls: 1 });
    await refused();
    await served.toolCall(settled);
    await admitted();
    await served.end();
  });

  it("keeps the mark while another agent-tool call of the request still runs", async () => {
    const { open, admitted, refused } = harness();
    const served = await open();
    let settle!: (r: unknown) => void;
    const blocking = served.toolCall(new Promise((r) => (settle = r)), true);
    // A result computed before the blocking call was tracked says none is open.
    await served.toolCall({ agents: [] });
    await refused();
    settle({ status: "completed", call_id: "c2" });
    await blocking;
    await admitted();
    await served.end();
  });

  it("keeps the mark on a result it cannot read, until the request ends", async () => {
    const { open, admitted, refused } = harness();
    const served = await open();
    await expect(served.toolCall(Promise.reject(new Error("aborted")), true)).rejects.toThrow();
    await refused();
    await served.toolCall("not a tool result");
    await refused();
    await served.end();
    await admitted();
  });

  it("two served requests of one root: refused until the waiting one's calls have settled", async () => {
    const { open, admitted, refused } = harness();
    const a = await open();
    const b = await open();
    await a.toolCall({ status: "running", call_id: "c1", open_calls: 1 }, true);
    await refused();
    // The other request's results say nothing of `a`'s calls.
    await b.toolCall({ agents: [] });
    await refused();
    await b.end();
    await refused();
    await a.toolCall({ status: "completed", call_id: "c1" });
    await admitted();
    await a.end();
  });

  it("never refuses a prompt of another tree", async () => {
    const { open, admitted } = harness();
    const served = await open();
    let settle!: (r: unknown) => void;
    const call = served.toolCall(new Promise((r) => (settle = r)), true);
    await admitted(OTHER_ROOT);
    await served.toolCall({ status: "running", call_id: "c2", open_calls: 2 }, true);
    await admitted(OTHER_ROOT);
    settle({ status: "completed", call_id: "c1" });
    await call;
    await served.end();
  });

  it("only runs a tool call of a scope it does not serve, and returns its value as is", () => {
    const { guard } = harness();
    const value = Promise.resolve({ status: "completed" });
    expect(guard.aroundToolCall(undefined, () => value)).toBe(value);
    const foreign: TraceScope = { threadId: "6".repeat(32), rootId: ROOT, turnCountHint: 0 };
    expect(guard.aroundToolCall(foreign, () => value)).toBe(value);
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
