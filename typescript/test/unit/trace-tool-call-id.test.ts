import { describe, expect, it } from "vitest";
import { newAgentId } from "@synadia-ai/agents";
import {
  buildEdgeRecord,
  EDGE_RECORD_VERSION,
  TOOL_CALL_ID_MAX,
  validToolCallId,
} from "../../src/index.js";
import { edgeSchemaErrors } from "../support/fixtures.js";

const THREAD = "a".repeat(32);
const PARENT = "b".repeat(32);
const ROOT = "c".repeat(32);
// alice in ACME, from test-fixtures/identity/operator/keys.json: the
// operator-mode `{account NKEY}.{user NKEY}` form the schema requires.
const ACME = "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS";
const ALICE = "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA";
const AGENT = newAgentId(ACME, ALICE);

const decode = (payload: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;

/**
 * Both packages label an edge with the tool call id a caller passes, and
 * both bound it the same way — in Unicode code points, not UTF-16 units —
 * so a mixed-language fleet accepts exactly the same ids. A lone surrogate
 * has no UTF-8 form and is rejected on both sides.
 */
describe("validToolCallId", () => {
  it("accepts an ordinary id", () => {
    expect(validToolCallId("call_1")).toBe(true);
    expect(validToolCallId("toolu_01A09q90qw90lq917835lq9")).toBe(true);
  });

  it("rejects an empty id", () => {
    expect(validToolCallId("")).toBe(false);
  });

  it("bounds the length at TOOL_CALL_ID_MAX code points", () => {
    expect(validToolCallId("a".repeat(TOOL_CALL_ID_MAX))).toBe(true);
    expect(validToolCallId("a".repeat(TOOL_CALL_ID_MAX + 1))).toBe(false);
  });

  it("counts an astral character as one, like Python's len()", () => {
    expect("\u{1F642}".length).toBe(2); // two UTF-16 units …
    expect(validToolCallId("\u{1F642}".repeat(TOOL_CALL_ID_MAX))).toBe(true); // … one code point
    expect(validToolCallId("\u{1F642}".repeat(TOOL_CALL_ID_MAX + 1))).toBe(false);
  });

  it("rejects a lone surrogate half", () => {
    expect(validToolCallId("\ud83d")).toBe(false);
    expect(validToolCallId("call_\ude42")).toBe(false);
    expect(validToolCallId("a\ud83db")).toBe(false);
  });
});

describe("buildEdgeRecord", () => {
  it("writes a non-ASCII tool call id raw, as Python does", () => {
    const { payload } = buildEdgeRecord(AGENT, THREAD, null, THREAD, "call_\u00e9\u{1F642}", 0);
    const text = new TextDecoder().decode(payload);
    expect(text).toContain('"tool_call_id":"call_\u00e9\u{1F642}"');
    expect(text).not.toContain("\\u");
  });

  it("names its writer in canonical {account}.{user} form", () => {
    const { payload } = buildEdgeRecord(AGENT, THREAD, null, THREAD, null, 0);
    const record = decode(payload);
    expect(record["agent"]).toBe(`${ACME}.${ALICE}`);
    // The writer sits where the design's table puts it: after `ts`, before the ids.
    expect(Object.keys(record)).toEqual([
      "version",
      "kind",
      "record_id",
      "ts",
      "agent",
      "thread_id",
      "parent_id",
      "root_id",
      "tool_call_id",
      "turn_count_hint",
    ]);
  });

  it("returns the record id it wrote, shaped like a thread id and a valid nonce", () => {
    const { recordId, payload } = buildEdgeRecord(AGENT, THREAD, null, THREAD, null, 0);
    expect(recordId).toMatch(/^[0-9a-f]{32}$/);
    expect(decode(payload)["record_id"]).toBe(recordId);
  });

  it("is version 1 of kind edge, stamped in unix seconds", () => {
    const before = Math.floor(Date.now() / 1000);
    const record = decode(buildEdgeRecord(AGENT, THREAD, PARENT, ROOT, "call_1", 7).payload);
    expect(EDGE_RECORD_VERSION).toBe(1);
    expect(record).toMatchObject({
      version: 1,
      kind: "edge",
      thread_id: THREAD,
      parent_id: PARENT,
      root_id: ROOT,
      tool_call_id: "call_1",
      turn_count_hint: 7,
    });
    expect(record["ts"]).toBeGreaterThanOrEqual(before);
    expect(record["ts"]).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  /** The contract: `docs/schemas/edge.json`, vendored under `test-fixtures/schemas/`. */
  it.each([
    ["a root", [THREAD, null, THREAD, null, 0]],
    ["a child", [THREAD, PARENT, ROOT, "call_1", 7]],
    ["a non-ASCII tool call id", [THREAD, PARENT, ROOT, "call_\u00e9\u{1F642}", 1]],
  ] as const)("validates against edge.json: %s", (_label, [t, p, r, c, n]) => {
    const record = decode(buildEdgeRecord(AGENT, t, p, r, c, n).payload);
    expect(edgeSchemaErrors(record)).toEqual([]);
  });

  it("the schema would refuse a record that broke the contract", () => {
    const record = decode(buildEdgeRecord(AGENT, THREAD, null, THREAD, null, 0).payload);
    expect(edgeSchemaErrors({ ...record, thread_id: "A".repeat(32) })).not.toEqual([]);
    expect(edgeSchemaErrors({ ...record, extra: 1 })).not.toEqual([]);
  });
});
