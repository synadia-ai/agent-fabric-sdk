import { describe, expect, it } from "vitest";
import { newAgentId, type Agents, type Logger } from "@synadia-ai/agents";
import {
  buildServedRecord,
  HARNESS_THREAD_ID_MAX,
  SERVED_RECORD_VERSION,
  servedPublisher,
  traceRecordCounts,
  unixSeconds,
  validHarnessThreadId,
} from "../../src/index.js";
import { servedSchemaErrors } from "../support/fixtures.js";

const THREAD = "a".repeat(32);
const ROOT = "c".repeat(32);
// alice in ACME, from test-fixtures/identity/operator/keys.json: the
// operator-mode `{account NKEY}.{user NKEY}` form the schema requires.
const ACME = "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS";
const ALICE = "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA";
const AGENT = newAgentId(ACME, ALICE);
/** OpenClaw's harness thread id: the 32-hex trace id of its `traceparent`. */
const TRACE_ID = "9f2c4b1e8a7d33051c6e0b42d78a91f0";
/** Claude Code's: the session id. */
const SESSION = "317f624b-c7c6-4b27-936b-c0de80892e6d";

const decode = (payload: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;

/**
 * Both packages hold the harness thread id to the same rule — the SDK's
 * subject-token class, bounded in Unicode code points, no lone surrogate —
 * so a mixed-language fleet accepts exactly the same ids.
 */
describe("validHarnessThreadId", () => {
  it("accepts the two harnesses' ids", () => {
    expect(validHarnessThreadId(TRACE_ID)).toBe(true);
    expect(validHarnessThreadId(SESSION)).toBe(true);
  });

  it("refuses what a header value can never hold", () => {
    for (const bad of [undefined, null, 42, "", " ", "has space", "a\nb", "a\tb", "a\u0000b"]) {
      expect(validHarnessThreadId(bad)).toBe(false);
    }
    expect(validHarnessThreadId("a\u2028b")).toBe(false);
    expect(validHarnessThreadId("a\ufeffb")).toBe(false);
  });

  it("bounds the length at HARNESS_THREAD_ID_MAX code points, like Python's len()", () => {
    expect(validHarnessThreadId("a".repeat(HARNESS_THREAD_ID_MAX))).toBe(true);
    expect(validHarnessThreadId("a".repeat(HARNESS_THREAD_ID_MAX + 1))).toBe(false);
    expect(validHarnessThreadId("\u{1F642}".repeat(HARNESS_THREAD_ID_MAX))).toBe(true);
    expect(validHarnessThreadId("\u{1F642}".repeat(HARNESS_THREAD_ID_MAX + 1))).toBe(false);
  });

  it("rejects a lone surrogate half, which has no UTF-8 form", () => {
    expect(validHarnessThreadId("\ud83d")).toBe(false);
    expect(validHarnessThreadId("s_\ude42")).toBe(false);
  });
});

describe("buildServedRecord", () => {
  it("writes the start record in the schema's key order, with no status", () => {
    const before = unixSeconds();
    const { recordId, payload } = buildServedRecord(
      AGENT,
      THREAD,
      ROOT,
      "openclaw",
      TRACE_ID,
      "start",
    );
    const record = decode(payload);
    expect(Object.keys(record)).toEqual([
      "version",
      "kind",
      "record_id",
      "ts",
      "agent",
      "thread_id",
      "root_id",
      "harness",
      "harness_thread_id",
      "phase",
    ]);
    const { ts, ...rest } = record;
    expect(rest).toEqual({
      version: SERVED_RECORD_VERSION,
      kind: "served",
      record_id: recordId,
      agent: `${ACME}.${ALICE}`,
      thread_id: THREAD,
      root_id: ROOT,
      harness: "openclaw",
      harness_thread_id: TRACE_ID,
      phase: "start",
    });
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(unixSeconds());
    expect(SERVED_RECORD_VERSION).toBe(1);
  });

  it("returns the record id it wrote, shaped like a thread id and a valid nonce", () => {
    const { recordId, payload } = buildServedRecord(
      AGENT,
      THREAD,
      ROOT,
      "claude",
      SESSION,
      "start",
    );
    expect(recordId).toMatch(/^[0-9a-f]{32}$/);
    expect(decode(payload)["record_id"]).toBe(recordId);
  });

  it.each(["ok", "error", "timeout"] as const)(
    "writes the end record with status %s, last, and the moment given as ts",
    (status) => {
      const { payload } = buildServedRecord(
        AGENT,
        THREAD,
        ROOT,
        "claude",
        SESSION,
        "end",
        status,
        1_700_000_000,
      );
      const record = decode(payload);
      expect(record).toMatchObject({ harness: "claude", phase: "end", status, ts: 1_700_000_000 });
      expect(Object.keys(record).at(-1)).toBe("status");
    },
  );

  it("writes a non-ASCII harness thread id raw, as Python does", () => {
    const { payload } = buildServedRecord(
      AGENT,
      THREAD,
      ROOT,
      "claude",
      "s\u00e9\u{1F642}",
      "start",
    );
    const text = new TextDecoder().decode(payload);
    expect(text).toContain('"harness_thread_id":"s\u00e9\u{1F642}"');
    expect(text).not.toContain("\\u");
  });

  it("refuses an end record without a status and a start record with one", () => {
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "end")).toThrow(
      /status/,
    );
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start", "ok"),
    ).toThrow(/status/);
  });

  it("refuses an unusable harness thread id, a bad ts, and names it does not know", () => {
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, "openclaw", "has space", "start")).toThrow(
      /harnessThreadId/,
    );
    expect(() => buildServedRecord(AGENT, THREAD, ROOT, "openclaw", "", "start")).toThrow(
      /harnessThreadId/,
    );
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start", undefined, 1.5),
    ).toThrow(/ts/);
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start", undefined, -1),
    ).toThrow(/ts/);
    // Off the types, as JavaScript would call it.
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "pi" as "openclaw", TRACE_ID, "start"),
    ).toThrow(/harness/);
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "middle" as "start"),
    ).toThrow(/phase/);
    expect(() =>
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "end", "cancelled" as "ok"),
    ).toThrow(/status/);
  });

  /** The contract: `docs/schemas/served.json`, vendored under `test-fixtures/schemas/`. */
  it.each([
    ["an OpenClaw start", ["openclaw", TRACE_ID, "start", undefined]],
    ["an OpenClaw end", ["openclaw", TRACE_ID, "end", "error"]],
    ["a Claude Code start", ["claude", SESSION, "start", undefined]],
    ["a Claude Code end", ["claude", SESSION, "end", "ok"]],
    ["a timed-out end", ["claude", SESSION, "end", "timeout"]],
    ["a non-ASCII harness thread id", ["claude", "s\u00e9\u{1F642}", "start", undefined]],
  ] as const)("validates against served.json: %s", (_label, [h, id, phase, status]) => {
    const record = decode(buildServedRecord(AGENT, THREAD, ROOT, h, id, phase, status).payload);
    expect(servedSchemaErrors(record)).toEqual([]);
  });

  it("the schema would refuse a record that broke the contract", () => {
    const start = decode(
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start").payload,
    );
    const end = decode(
      buildServedRecord(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "end", "ok").payload,
    );
    expect(servedSchemaErrors({ ...start, harness: "pi" })).not.toEqual([]);
    expect(servedSchemaErrors({ ...start, thread_id: "A".repeat(32) })).not.toEqual([]);
    expect(servedSchemaErrors({ ...start, harness_thread_id: "" })).not.toEqual([]);
    expect(servedSchemaErrors({ ...start, extra: 1 })).not.toEqual([]);
    const { status: _status, ...endWithout } = end;
    expect(servedSchemaErrors(endWithout)).not.toEqual([]);
  });
});

describe("servedPublisher over another copy of the SDK", () => {
  it("recognizes the missing signer by name: one warning, every record owed dropped", async () => {
    // A harness plugin's `Agents` runs on the plugin's copy of the SDK, so
    // its refusal is that copy's class, which `instanceof` here would miss.
    class SenderSignatureRequiredError extends Error {
      constructor() {
        super("TRACE.edges requires a signed Agent-Sender header");
        this.name = "SenderSignatureRequiredError";
      }
    }
    const agents = {
      selfId: () => Promise.resolve(AGENT),
      publishSigned: () => Promise.reject(new SenderSignatureRequiredError()),
    } as unknown as Agents;
    const warnings: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg) => void warnings.push(msg),
      error: () => undefined,
    };
    const p = servedPublisher({ agents, logger });
    const before = traceRecordCounts();
    for (const id of ["1", "2"]) {
      const turn = p.beginTurn(
        { threadId: id.repeat(32), rootId: ROOT, turnCountHint: 0 },
        "openclaw",
      );
      turn.bind(TRACE_ID);
      turn.settle("ok");
    }
    await p.flush();
    expect(traceRecordCounts().dropped - before.dropped).toBe(4);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/no identity signer/);
  });
});
