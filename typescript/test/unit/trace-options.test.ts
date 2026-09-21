import { describe, expect, it } from "vitest";
import { NatsAgentError } from "@synadia-ai/agents";
import { assertValidTraceOptions, fabricTracing } from "../../src/index.js";

/**
 * Edge publishing is fail-open, so a subject that can never be published
 * to would otherwise surface only as a warning on every prompt. The
 * options are checked where they are accepted, so the misconfiguration
 * fails at construction.
 */
describe("assertValidTraceOptions", () => {
  it.each([
    ["omitted", undefined],
    ["empty (all defaults)", {}],
    ["propagate-only", { edgeSubject: null }],
    ["a plain subject", { edgeSubject: "TRACE.edges" }],
    ["a deeper subject", { edgeSubject: "acme.TRACE.edges.v2" }],
  ])("accepts %s", (_label, options) => {
    expect(() => assertValidTraceOptions(options)).not.toThrow();
  });

  it.each([
    ["an empty subject", ""],
    ["an empty token", "TRACE..edges"],
    ["a trailing dot", "TRACE.edges."],
    ["whitespace", "TRACE edges"],
    ["a NUL", "TRACE\0edges"],
    // The two characters the languages' own `\s` disagree about: JavaScript
    // matches U+FEFF and Python does not, Python matches the C0 separators
    // and JavaScript does not. Both packages must reject both.
    ["a byte-order mark", "TRACE.\ufeffedges"],
    ["a C0 separator", "TRACE.\u001cedges"],
    ["a star wildcard", "TRACE.*"],
    ["a full wildcard", "TRACE.>"],
    ["a wildcard inside a token", "TRACE.ed>ges"],
  ])("rejects %s", (_label, edgeSubject) => {
    expect(() => assertValidTraceOptions({ edgeSubject })).toThrow(NatsAgentError);
  });
});

/**
 * `fabricTracing()` is where an agent — caller or host — hands its options
 * over, the place the pre-split SDK's `Agents`, `Agent` and `AgentService`
 * each checked them.
 */
describe("fabricTracing checks its options at construction", () => {
  it.each([
    ["an empty subject", ""],
    ["a wildcard", "TRACE.>"],
    ["whitespace", "TRACE edges"],
  ])("rejects %s", (_label, edgeSubject) => {
    expect(() => fabricTracing({ edgeSubject })).toThrow(NatsAgentError);
    expect(() => fabricTracing({ edgeSubject })).toThrow(/edgeSubject/);
  });

  it("accepts the defaults and propagate-only mode", () => {
    expect(() => fabricTracing()).not.toThrow();
    expect(() => fabricTracing({})).not.toThrow();
    expect(() => fabricTracing({ edgeSubject: null })).not.toThrow();
  });
});
