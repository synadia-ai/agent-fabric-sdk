import { describe, expect, it } from "vitest";
import type { PromptInterceptorContext } from "@synadia-ai/agents";
import {
  bindActiveTrace,
  fabricTracing,
  isThreadId,
  TOOL_CALL_ID_MAX,
  type TraceScope,
} from "../../src/index.js";

const PARENT = "c".repeat(32);
const ROOT = "d".repeat(32);

/** Phase one needs nothing but the caller's `context`; the rest is never touched. */
function ctxWith(context: Record<string, unknown> = {}): PromptInterceptorContext {
  return { context } as unknown as PromptInterceptorContext;
}

async function phaseOne(context: Record<string, unknown> = {}) {
  const { promptInterceptor } = fabricTracing();
  const extras = await promptInterceptor.beforePrompt(ctxWith(context));
  if (!extras) throw new Error("beforePrompt returned nothing");
  return extras as {
    fields: Record<string, unknown>;
    headers?: unknown;
    state: {
      threadId: string;
      parentId: string | null;
      rootId: string;
      toolCallId: string | null;
      turnCountHint: number;
    };
  };
}

/**
 * The caller's first phase decides everything the prompt carries and the
 * record its second phase publishes, and has no side effects of its own.
 */
describe("the prompt interceptor's first phase", () => {
  it("adds exactly thread_id and root_id, in that order, and no headers", async () => {
    const extras = await phaseOne();
    expect(Object.keys(extras.fields)).toEqual(["thread_id", "root_id"]);
    expect(extras.headers).toBeUndefined();
  });

  it("starts a tree of its own outside a handler", async () => {
    const { fields, state } = await phaseOne();
    expect(isThreadId(fields["thread_id"] as string)).toBe(true);
    expect(fields["root_id"]).toBe(fields["thread_id"]);
    expect(state).toMatchObject({ parentId: null, turnCountHint: 0, toolCallId: null });
  });

  it("inherits root and parent from the ambient scope, and its turn count", async () => {
    const scope: TraceScope = { threadId: PARENT, rootId: ROOT, turnCountHint: 3 };
    const { fields, state } = await bindActiveTrace(scope, () => phaseOne());
    expect(fields["root_id"]).toBe(ROOT);
    expect(fields["thread_id"]).not.toBe(PARENT);
    expect(isThreadId(fields["thread_id"] as string)).toBe(true);
    expect(state).toMatchObject({ parentId: PARENT, rootId: ROOT, turnCountHint: 3 });
  });

  it("mints a fresh thread for every prompt", async () => {
    const a = await phaseOne();
    const b = await phaseOne();
    expect(a.fields["thread_id"]).not.toBe(b.fields["thread_id"]);
  });

  it("takes the tool call id from the prompt's context", async () => {
    const { state } = await phaseOne({ toolCallId: "toolu_01" });
    expect(state.toolCallId).toBe("toolu_01");
  });

  /** Tracing is best-effort: a bad tool call id never stops a prompt. */
  it.each([
    ["an empty id", ""],
    ["an overlong id", "a".repeat(TOOL_CALL_ID_MAX + 1)],
    ["a lone surrogate", "call_\ud83d"],
    ["a number", 42],
    ["null", null],
  ])("drops %s and still prompts", async (_label, toolCallId) => {
    const { fields, state } = await phaseOne({ toolCallId });
    expect(state.toolCallId).toBeNull();
    expect(isThreadId(fields["thread_id"] as string)).toBe(true);
  });

  it("ignores the snake_case key, which is Python's", async () => {
    const { state } = await phaseOne({ tool_call_id: "toolu_01" });
    expect(state.toolCallId).toBeNull();
  });
});
