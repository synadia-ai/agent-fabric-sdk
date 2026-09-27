// converse(): the model loop, with a scripted model and scripted tools. What
// is asserted here is when a turn ends: an empty answer while a call the
// model started is still open is not the reply; the model is told what
// waits and asked again, a bounded number of times, and then the turn
// fails instead of answering with nothing.

import { describe, expect, it } from "vitest";
import {
  converse,
  EmptyReplyError,
  type ChatMessage,
  type ModelClient,
  type ToolDefinitionLike,
  type ToolRunner,
} from "../src/model.js";

const ASKER = "agents.prompt.asker.test.target";

/** A model that answers with the scripted messages in order, recording what it was sent. */
function scriptedModel(script: ChatMessage[]): ModelClient & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  return {
    seen,
    label: "scripted",
    async complete(messages) {
      seen.push(messages.map((m) => ({ ...m })));
      const message = script.shift();
      if (message === undefined) throw new Error("the model was called more often than scripted");
      return { message, usage: undefined };
    },
  };
}

/** Tools that answer each call with the next scripted result, as JSON. */
function scriptedTools(results: Record<string, unknown>[]): ToolRunner & { calls: string[] } {
  const calls: string[] = [];
  const definitions: ToolDefinitionLike[] = ["prompt_agent", "answer_agent", "wait_agent"].map((name) => ({
    type: "function",
    function: { name },
  }));
  return {
    calls,
    definitions,
    async call(name) {
      calls.push(name);
      const result = results.shift();
      if (result === undefined) throw new Error("a tool was called more often than scripted");
      return JSON.stringify(result);
    },
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

const empty: ChatMessage = { role: "assistant", content: null };
const words = (text: string): ChatMessage => ({ role: "assistant", content: text });

const asked = {
  call_id: "call_1",
  state: "input_required",
  question: "may I read the file?",
  open_calls: 1,
  open_calls_note: "1 call you started is still open.",
};

function start(): ChatMessage[] {
  return [
    { role: "system", content: "You are under test." },
    { role: "user", content: "ask the asker" },
  ];
}

describe("converse: an empty answer while a call is open", () => {
  it("is not the reply: the model is told what waits and asked again, and its answer_agent goes through", async () => {
    const model = scriptedModel([
      toolCall("t1", "prompt_agent", { address: ASKER, prompt: "read it" }),
      empty,
      toolCall("t2", "answer_agent", { call_id: "call_1", answer: "yes" }),
      words("the asker read it"),
    ]);
    const tools = scriptedTools([asked, { call_id: "call_1", state: "completed", reply: "done" }]);
    const messages = start();
    const result = await converse({ model, tools, messages, traceHeaders: () => ({}) });

    expect(result).toEqual({ reply: "the asker read it", modelCalls: 4, toolCalls: 2 });
    expect(tools.calls).toEqual(["prompt_agent", "answer_agent"]);
    // The third model call saw the word in place of the empty answer.
    const third = model.seen[2]!;
    const nudge = third[third.length - 1]!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toContain(`call_1 to ${ASKER} waits for an answer to "may I read the file?"`);
    expect(nudge.content).toContain("answer it with answer_agent");
    // The empty answer is not in the history.
    expect(messages.some((m) => m.role === "assistant" && m.content === null && m.tool_calls === undefined)).toBe(false);
  });

  it("fails the turn after the bound, saying which calls were open, never an empty reply", async () => {
    const model = scriptedModel([toolCall("t1", "prompt_agent", { address: ASKER, prompt: "read it" }), empty, empty, empty]);
    const tools = scriptedTools([asked]);
    const failure = await converse({ model, tools, messages: start(), traceHeaders: () => ({}) }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(EmptyReplyError);
    const err = failure as EmptyReplyError;
    expect(err.emptyReplies).toBe(3);
    expect(err.openCalls).toEqual([
      { callId: "call_1", state: "input_required", address: ASKER, question: "may I read the file?" },
    ]);
    expect(err.message).toBe(
      "the model returned an empty reply 3 times while 1 call it started was still open " +
        `(call_1 to ${ASKER} waits for an answer to "may I read the file?"); no reply was produced`,
    );
    expect(model.seen).toHaveLength(4);
  });

  it("takes the bound from maxEmptyReplies; whitespace counts as empty", async () => {
    const model = scriptedModel([toolCall("t1", "prompt_agent", { address: ASKER, prompt: "x" }), words("  \n")]);
    const failure = await converse({
      model,
      tools: scriptedTools([asked]),
      messages: start(),
      traceHeaders: () => ({}),
      maxEmptyReplies: 0,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(EmptyReplyError);
    expect((failure as EmptyReplyError).emptyReplies).toBe(1);
  });

  it("counts a running call as open, and tells the model to collect it", async () => {
    const model = scriptedModel([
      toolCall("t1", "prompt_agent", { address: ASKER, prompt: "x", wait: false }),
      empty,
      toolCall("t2", "wait_agent", { call_ids: ["call_1"] }),
      words("collected"),
    ]);
    const tools = scriptedTools([
      { call_id: "call_1", state: "running" },
      { calls: [{ call_id: "call_1", state: "completed", reply: "r" }] },
    ]);
    const result = await converse({ model, tools, messages: start(), traceHeaders: () => ({}) });
    expect(result.reply).toBe("collected");
    const nudge = model.seen[2]!.at(-1)!;
    expect(nudge.content).toContain(`call_1 to ${ASKER} is still running: collect its result before you answer`);
  });
});

describe("converse: an empty answer with nothing open", () => {
  it("is the reply, as before", async () => {
    const result = await converse({
      model: scriptedModel([empty]),
      tools: scriptedTools([]),
      messages: start(),
      traceHeaders: () => ({}),
    });
    expect(result).toEqual({ reply: "", modelCalls: 1, toolCalls: 0 });
  });

  it("is the reply once the call it started has ended", async () => {
    const model = scriptedModel([
      toolCall("t1", "prompt_agent", { address: ASKER, prompt: "x" }),
      toolCall("t2", "answer_agent", { call_id: "call_1", answer: "yes" }),
      empty,
    ]);
    const tools = scriptedTools([asked, { call_id: "call_1", state: "failed", error: "gone" }]);
    const result = await converse({ model, tools, messages: start(), traceHeaders: () => ({}) });
    expect(result).toEqual({ reply: "", modelCalls: 3, toolCalls: 2 });
  });
});
