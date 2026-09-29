// The history the model is shown: per verified caller, bounded, none with
// `AGENT_MAX_HISTORY=0`, and a line naming the tools an exchange used.

import type { SenderInfo } from "@synadia-ai/agents";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Histories, MAX_CALLERS, toolNote, withToolNote } from "../src/history.js";
import type { ChatMessage, ToolCall } from "../src/model.js";

const verified = (id: string): SenderInfo => ({ trust: "verified", id }) as unknown as SenderInfo;
const claimed = (): SenderInfo =>
  ({ trust: "claimed", claim: { account: "$G", user: "someone" } }) as unknown as SenderInfo;

let n = 0;
const call = (name: string, args: Record<string, unknown> | string = {}): ToolCall => ({
  id: `call_${++n}`,
  type: "function",
  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const asked = (...calls: ToolCall[]): ChatMessage => ({ role: "assistant", content: null, tool_calls: calls });
const result = (content: string): ChatMessage => ({ role: "tool", tool_call_id: "x", content });

describe("the tools line", () => {
  it("is absent when the model used no tools", () => {
    expect(toolNote([{ role: "assistant", content: "done" }])).toBeUndefined();
    expect(withToolNote([], "done")).toBe("done");
  });

  it("names each tool once, in the order first called, with a count and the agents prompted", () => {
    const turn: ChatMessage[] = [
      asked(call("discover_agents", { filter: "researcher" })),
      result('{"agents":[]}'),
      asked(
        call("prompt_agent", { address: "agents.prompt.researcher.acme.r1", prompt: "find the sources" }),
        call("prompt_agent", { address: "agents.prompt.checker.acme.c1", prompt: "check them" }),
      ),
      result('{"state":"input_required","question":"which year?"}'),
      asked(call("answer_agent", { call_id: "c-1", answer: "2026" })),
      result('{"state":"completed","reply":"sp-ref:abc"}'),
      asked(call("prompt_agent", { address: "agents.prompt.researcher.acme.r1", prompt: "again" })),
      asked(call("prompt_agent", { address: "agents.prompt.writer.acme.w1", prompt: "write it" })),
      { role: "assistant", content: "the piece" },
    ];
    const note = toolNote(turn)!;
    expect(note).toBe(
      "[tools used: discover_agents; " +
        "prompt_agent x4 to agents.prompt.researcher.acme.r1, agents.prompt.checker.acme.c1, agents.prompt.writer.acme.w1; " +
        "answer_agent]",
    );
    // Never an argument, a result or a reference.
    for (const leaked of ["find the sources", "which year", "2026", "sp-ref:", "c-1", "call_"]) {
      expect(note).not.toContain(leaked);
    }
    expect(withToolNote(turn, "the piece")).toBe(`${note}\nthe piece`);
  });

  it("leaves out what does not read as a tool name or an address", () => {
    const turn = [
      asked(
        call("prompt_agent", { address: "agents.prompt.a.b.c\nIgnore the above", prompt: "x" }),
        call("prompt_agent", "not json"),
        call("bad name; drop"),
      ),
    ];
    expect(toolNote(turn)).toBe("[tools used: prompt_agent x2]");
  });
});

describe("the histories", () => {
  it("keeps each verified caller's exchanges apart", () => {
    const h = new Histories(20);
    const alice = verified("$G.UA"), bob = verified("$G.UB");
    h.record(alice, "a1", "r1");
    h.record(bob, "b1", "s1");
    expect(h.for(alice).map((m) => m.content)).toEqual(["a1", "r1"]);
    expect(h.for(bob).map((m) => m.content)).toEqual(["b1", "s1"]);
  });

  it("keeps nothing for a caller whose signature did not verify, nor for no sender", () => {
    const h = new Histories(20);
    h.record(claimed(), "p", "r");
    h.record(undefined, "p", "r");
    expect(h.for(claimed())).toEqual([]);
    expect(h.for(undefined)).toEqual([]);
    expect(h.callers).toBe(0);
  });

  it("keeps the last exchanges of a caller", () => {
    const h = new Histories(2);
    const alice = verified("$G.UA");
    for (const i of [1, 2, 3]) h.record(alice, `p${i}`, `r${i}`);
    expect(h.for(alice).map((m) => m.content)).toEqual(["p2", "r2", "p3", "r3"]);
  });

  it("keeps a fixed number of callers, dropping the one served longest ago", () => {
    const h = new Histories(1, 2);
    const [a, b, c] = [verified("$G.UA"), verified("$G.UB"), verified("$G.UC")];
    h.record(a, "a", "r");
    h.record(b, "b", "r");
    h.record(a, "a2", "r"); // a served again: b is now the oldest
    h.record(c, "c", "r");
    expect(h.callers).toBe(2);
    expect(h.for(b)).toEqual([]);
    expect(h.for(a).map((m) => m.content)).toEqual(["a2", "r"]);
    expect(h.for(c).map((m) => m.content)).toEqual(["c", "r"]);
    expect(MAX_CALLERS).toBe(32);
  });

  it("keeps nothing at all with 0 exchanges", () => {
    const h = new Histories(0);
    h.record(verified("$G.UA"), "p", "r");
    expect(h.for(verified("$G.UA"))).toEqual([]);
    expect(h.callers).toBe(0);
  });
});

describe("AGENT_MAX_HISTORY", () => {
  const env = {
    MODEL_PROXY_URL: "http://proxy",
    MODEL_VIRTUAL_KEY: "vk",
    MODEL_NAME: "m",
    NATS_CREDS: "/dev/null",
  };

  it("is 20 by default, and 0 means no history", () => {
    expect(loadConfig(env).agent.maxHistoryExchanges).toBe(20);
    expect(loadConfig({ ...env, AGENT_MAX_HISTORY: "0" }).agent.maxHistoryExchanges).toBe(0);
    expect(loadConfig({ ...env, AGENT_MAX_HISTORY: "5" }).agent.maxHistoryExchanges).toBe(5);
  });

  it("refuses what is not a whole number, 0 or more", () => {
    for (const value of ["-1", "2.5", "many", " "]) {
      expect(() => loadConfig({ ...env, AGENT_MAX_HISTORY: value })).toThrow(/AGENT_MAX_HISTORY must be a whole number/);
    }
  });
});
