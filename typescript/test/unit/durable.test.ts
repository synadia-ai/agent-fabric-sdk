import { NatsAgentError } from "@synadia-ai/agents";
import { describe, expect, it } from "vitest";
import {
  bindActiveTrace,
  durableHeaders,
  durableRunId,
  durableTrace,
  ROOT_ID_HEADER,
  THREAD_ID_HEADER,
  TOOL_CALL_ID_MAX,
  type DurableTrace,
  type TraceScope,
} from "../../src/index.js";

const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);
const scope = (): TraceScope => ({ threadId: THREAD, rootId: ROOT, turnCountHint: 0 });

/**
 * A durable run joins the task that started it by its id and by the trace
 * its input carries; these three build both and turn the trace back into
 * the proxy's headers inside a step.
 */
describe("durableRunId", () => {
  it("names the served thread and the tool call", () => {
    expect(bindActiveTrace(scope(), () => durableRunId("call_Ab-9"))).toBe(`${THREAD}-call_Ab-9`);
  });

  it("replaces every character outside [A-Za-z0-9_-] with _, one per code point", () => {
    const id = bindActiveTrace(scope(), () => durableRunId("toolu.1*>x yé🙂"));
    expect(id).toBe(`${THREAD}-toolu_1__x_y__`);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is undefined outside a traced handler: the run joins no task", () => {
    expect(durableRunId("call_1")).toBeUndefined();
  });

  it("refuses an empty, an overlong or an invalid tool-call id", () => {
    for (const bad of ["", "x".repeat(TOOL_CALL_ID_MAX + 1), "a\uD800"]) {
      expect(() => bindActiveTrace(scope(), () => durableRunId(bad))).toThrow(NatsAgentError);
      expect(() => durableRunId(bad)).toThrow(NatsAgentError);
    }
  });
});

describe("durableTrace", () => {
  it("is the active pair, thread_id then root_id", () => {
    const trace = bindActiveTrace(scope(), () => durableTrace());
    expect(JSON.stringify(trace)).toBe(`{"thread_id":"${THREAD}","root_id":"${ROOT}"}`);
  });

  it("counts no model turn", () => {
    const s = scope();
    bindActiveTrace(s, () => durableTrace());
    expect(s.turnCountHint).toBe(0);
  });

  it("is undefined outside a traced handler", () => {
    expect(durableTrace()).toBeUndefined();
  });
});

describe("durableHeaders", () => {
  it("gives the proxy's two headers for the trace, outside any scope", () => {
    expect(durableHeaders({ thread_id: THREAD, root_id: ROOT })).toEqual({
      [THREAD_ID_HEADER]: THREAD,
      [ROOT_ID_HEADER]: ROOT,
    });
  });

  it("round-trips the trace a run's input carried as JSON", () => {
    const input = JSON.parse(
      JSON.stringify({ task: "t", trace: bindActiveTrace(scope(), () => durableTrace()) }),
    ) as { trace: DurableTrace };
    expect(durableHeaders(input.trace)).toEqual({
      [THREAD_ID_HEADER]: THREAD,
      [ROOT_ID_HEADER]: ROOT,
    });
  });

  it("is {} for no trace, and for one not shaped like thread ids", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "x",
      {},
      { thread_id: THREAD },
      { thread_id: THREAD, root_id: 7 },
      { thread_id: THREAD.toUpperCase(), root_id: ROOT },
      { thread_id: `${THREAD}\r\nX-Evil: 1`, root_id: ROOT },
    ];
    for (const trace of bad) expect(durableHeaders(trace as never)).toEqual({});
  });
});
