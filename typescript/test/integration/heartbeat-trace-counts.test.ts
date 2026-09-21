import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import { decodeHeartbeatPayload, type HeartbeatPayload } from "@synadia-ai/agents";
import {
  countTraceRecordDropped,
  countTraceRecordPublished,
  fabricTracing,
  traceRecordCounts,
  type TraceOptions,
} from "../../src/index.js";
import { findNatsServerBinary, NatsServerProcess } from "../harness/nats-server.js";
import { dec } from "../support/fixtures.js";

const bin = await findNatsServerBinary();
// The §8.3 fields a service with no `session` publishes: nothing else.
const REQUIRED = ["agent", "owner", "instance_id", "ts", "interval_s"];

/**
 * A host that runs the fabric's heartbeat extras reports how many trace
 * records its process has published and dropped since it started, as
 * `records_published` and `records_dropped` on every heartbeat and on the
 * status reply — so whoever consumes the heartbeat knows how many records
 * the process failed to publish. A host without them reports neither: its
 * heartbeat stays byte-identical to plain protocol 0.3.
 */
describe.skipIf(!bin)("heartbeat trace record counts", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  beforeAll(async () => {
    await server.start();
    nc = await connect({ servers: server.url, reconnect: false });
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  interface Beat {
    readonly payload: HeartbeatPayload;
    readonly keys: ReadonlyArray<string>;
  }

  async function firstHeartbeatAndStatus(
    trace: TraceOptions | undefined,
    agent: string,
    betweenBeatAndStatus: () => void = () => undefined,
  ): Promise<{ heartbeat: Beat; status: Beat }> {
    const svc = new AgentService({
      nc,
      agent,
      owner: "p",
      name: `${agent}-1`,
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      ...(trace !== undefined ? { heartbeatExtras: fabricTracing(trace).heartbeatExtras } : {}),
    });
    svc.onPrompt(async (_e, r) => {
      await r.send("ok");
    });
    const sub = nc.subscribe(svc.subject.heartbeat);
    await nc.flush();
    await svc.start();
    const beat = (data: Uint8Array): Beat => {
      const raw = JSON.parse(dec.decode(data)) as Record<string, unknown>;
      const payload = decodeHeartbeatPayload(raw);
      if (!payload) throw new Error("malformed heartbeat payload");
      return { payload, keys: Object.keys(raw) };
    };
    try {
      const first = await (async () => {
        for await (const m of sub) return m;
        throw new Error("heartbeat subscription closed");
      })();
      const heartbeat = beat(first.data);
      betweenBeatAndStatus();
      const reply = await nc.request(svc.subject.status, new Uint8Array(0), { timeout: 2000 });
      return { heartbeat, status: beat(reply.data) };
    } finally {
      sub.unsubscribe();
      await svc.stop();
    }
  }

  it("carries the process-wide counts when the host runs the extras", async () => {
    // The counters are process-wide and cumulative; move both so the
    // heartbeat provably reads them rather than a constant.
    countTraceRecordPublished();
    countTraceRecordDropped();
    const expected = traceRecordCounts();
    const { heartbeat, status } = await firstHeartbeatAndStatus({}, "hb-traced");
    for (const { payload } of [heartbeat, status]) {
      expect(payload.extras["records_published"]).toBe(expected.published);
      expect(payload.extras["records_dropped"]).toBe(expected.dropped);
    }
  });

  it("reads the counts fresh on every beat", async () => {
    // One service: a drop counted after its first heartbeat shows on the
    // status reply that follows.
    const { heartbeat, status } = await firstHeartbeatAndStatus({}, "hb-fresh", () =>
      countTraceRecordDropped(),
    );
    expect(status.payload.extras["records_dropped"]).toBe(
      (heartbeat.payload.extras["records_dropped"] as number) + 1,
    );
  });

  it("carries neither count when the host runs no fabric extras", async () => {
    const { heartbeat, status } = await firstHeartbeatAndStatus(undefined, "hb-untraced");
    for (const { payload, keys } of [heartbeat, status]) {
      expect(payload.extras).toEqual({});
      expect([...keys].sort()).toEqual([...REQUIRED].sort());
    }
  });

  it("carries neither count in propagate-only mode, which publishes no records", async () => {
    const { heartbeat, status } = await firstHeartbeatAndStatus(
      { edgeSubject: null },
      "hb-propagate",
    );
    for (const { payload, keys } of [heartbeat, status]) {
      expect(payload.extras).toEqual({});
      expect([...keys].sort()).toEqual([...REQUIRED].sort());
    }
  });
});
