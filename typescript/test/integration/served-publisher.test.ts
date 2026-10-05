// The served publisher on a real `Agents` client, over a local nats-server
// in operator mode (real account NKEYs, so `agent` has the
// `{account}.{user}` form `served.json` requires). A turn's pair goes out
// signed by the client's identity, one id three ways, `start` then `end`,
// every record validating against the vendored schema and counted on the
// process-wide trace record counts. The counters are process-wide, so
// every assertion on them is on the delta across one test.

import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import {
  newAgentId,
  signerFromCredsFile,
  verifySender,
  type Agents,
  type Logger,
  type SenderSigner,
} from "@synadia-ai/agents";
import {
  DEFAULT_EDGE_SUBJECT,
  servedPublisher,
  traceRecordCounts,
  unixSeconds,
  type ServedPublisher,
  type TraceScope,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import { caller, capture, enc, parse, servedSchemaErrors, sleep } from "../support/fixtures.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}
const bin = await findNatsServerBinary();
const opKeys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const ALICE_ID = newAgentId(opKeys.accounts["ACME"]!.public, opKeys.users["alice"]!.public);
const credsPath = identityFixture("operator/alice.creds");

const THREAD = "a".repeat(32);
const ROOT = "c".repeat(32);
const TRACE_ID = "9f2c4b1e8a7d33051c6e0b42d78a91f0";
const SESSION = "317f624b-c7c6-4b27-936b-c0de80892e6d";

function scope(threadId = THREAD): TraceScope {
  return { threadId, rootId: ROOT, turnCountHint: 0 };
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg) => {
        warnings.push(msg);
      },
      error: () => undefined,
    },
  };
}

describe.skipIf(!bin)("the served publisher", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let observer: NatsConnection;
  let signer: SenderSigner;
  const clients: Agents[] = [];
  let wire: { msgs: Msg[]; stop: () => void };

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    const opts = {
      servers: server.url,
      authenticator: credsAuthenticator(enc.encode(await readFile(credsPath, "utf8"))),
      reconnect: false,
    };
    nc = await connect(opts);
    observer = await connect(opts);
    signer = await signerFromCredsFile(credsPath);
    wire = capture(observer, "TRACE.>");
    await observer.flush();
  });
  afterAll(async () => {
    wire.stop();
    for (const c of clients) await c.close();
    await observer.close();
    await nc.close();
    await server.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    wire.msgs.length = 0;
  });

  function publisher(opts: { signed?: boolean; subject?: string } = {}): {
    p: ServedPublisher;
    warnings: string[];
  } {
    const agents = caller(nc, opts.signed === false ? {} : { signer });
    clients.push(agents);
    const { logger, warnings } = recordingLogger();
    const p = servedPublisher({
      agents,
      logger,
      ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    });
    return { p, warnings };
  }

  /** The records the observer saw, in arrival order, after the publisher flushed. */
  async function settled(p: ServedPublisher): Promise<Array<Record<string, unknown>>> {
    await p.flush();
    await sleep(200);
    return wire.msgs.map(parse);
  }

  it("publishes the pair on the edge subject, start then end, signed as its writer with one id three ways", async () => {
    const { p, warnings } = publisher();
    expect(p.subject).toBe(DEFAULT_EDGE_SUBJECT);
    const before = traceRecordCounts();
    const arrived = unixSeconds();
    const turn = p.beginTurn(scope(), "openclaw");
    turn.bind(TRACE_ID);
    turn.settle("ok");
    const records = await settled(p);

    expect(wire.msgs.map((m) => m.subject)).toEqual(["TRACE.edges", "TRACE.edges"]);
    expect(records.map((r) => r["phase"])).toEqual(["start", "end"]);
    const [start, end] = records;
    expect(start).toMatchObject({
      version: 1,
      kind: "served",
      agent: ALICE_ID,
      thread_id: THREAD,
      root_id: ROOT,
      harness: "openclaw",
      harness_thread_id: TRACE_ID,
      phase: "start",
    });
    expect(start!["status"]).toBeUndefined();
    expect(start!["ts"]).toBeGreaterThanOrEqual(arrived);
    expect(end).toMatchObject({
      agent: ALICE_ID,
      thread_id: THREAD,
      root_id: ROOT,
      harness: "openclaw",
      harness_thread_id: TRACE_ID,
      phase: "end",
      status: "ok",
    });
    expect(end!["ts"]).toBeGreaterThanOrEqual(start!["ts"] as number);
    expect(start!["record_id"]).not.toBe(end!["record_id"]);
    for (const record of records) expect(servedSchemaErrors(record)).toEqual([]);
    for (const msg of wire.msgs) {
      const record = parse(msg);
      // Stored mode, as the reader verifies: the signature over the short
      // form the writer published to.
      const sender = await verifySender(msg, "stored");
      expect(sender?.trust).toBe("verified");
      expect(sender?.trust === "verified" ? sender.id : undefined).toBe(ALICE_ID);
      expect(sender?.header.nonce).toBe(record["record_id"]);
      expect(msg.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
    }
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(2);
    expect(after.dropped - before.dropped).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("stamps start with the arrival however late the id is bound, and end with the moment given", async () => {
    const { p } = publisher();
    const arrived = unixSeconds();
    const turn = p.beginTurn(scope(), "claude");
    await sleep(1_100);
    turn.bind(SESSION);
    turn.settle("error", 1_700_000_500_999);
    const [start, end] = await settled(p);
    expect(start!["ts"]).toBeLessThanOrEqual(arrived + 1);
    expect(end).toMatchObject({ harness: "claude", status: "error", ts: 1_700_000_500 });
  });

  it("settles with a reason: end carries it as version 2, signed and valid; start stays version 1", async () => {
    const { p, warnings } = publisher();
    const answered = p.beginTurn(scope("1".repeat(32)), "claude");
    answered.bind(SESSION);
    answered.settle("ok", 1_700_000_600_000, "final_text");
    const failed = p.beginTurn(scope("2".repeat(32)), "claude");
    failed.bind(SESSION);
    failed.settle("error", undefined, "no_reply");
    const plain = p.beginTurn(scope("3".repeat(32)), "claude");
    plain.bind(SESSION);
    plain.settle("ok");
    const records = await settled(p);
    const ends = records.filter((r) => r["phase"] === "end");
    expect(ends.map((r) => [r["version"], r["status"], r["reason"]])).toEqual([
      [2, "ok", "final_text"],
      [2, "error", "no_reply"],
      [1, "ok", undefined],
    ]);
    expect(ends[0]!["ts"]).toBe(1_700_000_600);
    for (const record of records.filter((r) => r["phase"] === "start")) {
      expect(record["version"]).toBe(1);
      expect("reason" in record).toBe(false);
    }
    for (const record of records) expect(servedSchemaErrors(record)).toEqual([]);
    for (const msg of wire.msgs) {
      const sender = await verifySender(msg, "stored");
      expect(sender?.trust).toBe("verified");
    }
    expect(warnings).toEqual([]);
  });

  it("keeps the records in the order they were due, across interleaved turns", async () => {
    const { p } = publisher();
    const a = p.beginTurn(scope("1".repeat(32)), "openclaw");
    const b = p.beginTurn(scope("2".repeat(32)), "openclaw");
    a.bind("a".repeat(32));
    b.bind("b".repeat(32));
    a.settle("ok");
    b.settle("timeout");
    const records = await settled(p);
    expect(records.map((r) => [r["thread_id"], r["phase"]])).toEqual([
      ["1".repeat(32), "start"],
      ["2".repeat(32), "start"],
      ["1".repeat(32), "end"],
      ["2".repeat(32), "end"],
    ]);
  });

  it("binds once, refuses an unusable, repeated or late binding, and owes nothing for an unbound turn", async () => {
    const { p, warnings } = publisher();
    const before = traceRecordCounts();
    const turn = p.beginTurn(scope(), "openclaw");
    turn.bind("has space");
    turn.bind("first");
    turn.bind("first");
    turn.bind("second");
    turn.settle("ok");
    turn.settle("error");
    turn.bind("third");
    const unbound = p.beginTurn(scope(), "openclaw");
    unbound.settle("ok");
    const records = await settled(p);
    expect(records.map((r) => [r["harness_thread_id"], r["phase"], r["status"]])).toEqual([
      ["first", "start", undefined],
      ["first", "end", "ok"],
    ]);
    expect(warnings.filter((w) => /unusable/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /already bound/.test(w))).toHaveLength(1);
    expect(warnings.filter((w) => /after the turn ended/.test(w))).toHaveLength(1);
    expect(traceRecordCounts().published - before.published).toBe(2);
  });

  it("publishes nothing without a signer, warns once, and counts every record owed as dropped", async () => {
    const { p, warnings } = publisher({ signed: false });
    const before = traceRecordCounts();
    for (const id of ["one", "two"]) {
      const turn = p.beginTurn(scope(), "openclaw");
      turn.bind(id);
      turn.settle("ok");
    }
    const records = await settled(p);
    expect(records).toEqual([]);
    expect(warnings.filter((w) => /no identity signer/.test(w))).toHaveLength(1);
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(0);
    expect(after.dropped - before.dropped).toBe(4);
  });

  it("counts a record whose publish threw as dropped, warns, and keeps the next one in order", async () => {
    let failures = 0;
    const realPublish = nc.publish.bind(nc);
    vi.spyOn(nc, "publish").mockImplementation((subject, data, opts) => {
      if (subject === "TRACE.edges" && failures++ === 0) throw new Error("connection draining");
      return realPublish(subject, data, opts);
    });
    const { p, warnings } = publisher();
    const before = traceRecordCounts();
    const turn = p.beginTurn(scope(), "claude");
    turn.bind(SESSION);
    turn.settle("ok");
    const records = await settled(p);
    expect(records.map((r) => r["phase"])).toEqual(["end"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/failed to publish/);
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(1);
    expect(after.dropped - before.dropped).toBe(1);
  });

  it("publishes to a configured subject", async () => {
    const custom = capture(observer, "acme.TRACE.edges.v2");
    await observer.flush();
    const { p } = publisher({ subject: "acme.TRACE.edges.v2" });
    const turn = p.beginTurn(scope(), "openclaw");
    turn.bind(TRACE_ID);
    turn.settle("ok");
    const onDefault = await settled(p);
    custom.stop();
    expect(onDefault).toEqual([]);
    expect(custom.msgs.map((m) => parse(m)["phase"])).toEqual(["start", "end"]);
    const sender = await verifySender(custom.msgs[0]!, "stored");
    expect(sender?.trust).toBe("verified");
  });
});
