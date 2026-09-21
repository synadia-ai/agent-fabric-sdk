import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { AgentService } from "@synadia-ai/agent-service";
import type { Agents } from "@synadia-ai/agents";
import { fabricTracing, traceRecordCounts, type TraceOptions } from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import { ALICE, caller, capture, drain, enc, handleOf, host, sleep } from "../support/fixtures.js";

const bin = await findNatsServerBinary();

/**
 * A record that was never published leaves nothing behind, so the fabric
 * counts what it published and what it could not, for the whole process,
 * and the host reports both on its heartbeat. The counters are
 * process-wide, so every assertion here is on the delta across one prompt.
 */
describe.skipIf(!bin)("trace record counts", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let svc: AgentService;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    nc = await connect({
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    });
    ({ svc } = await host(nc, { agent: "count" }));
  });
  afterAll(async () => {
    await svc.stop();
    await nc.close();
    await server.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function traced(signed: boolean, options: TraceOptions = {}): Agents {
    return caller(nc, { signed, interceptors: [fabricTracing(options).promptInterceptor] });
  }

  async function promptOnce(agents: Agents): Promise<void> {
    await drain(await (await handleOf(agents, svc)).prompt("hi"));
    await agents.close();
  }

  it("counts a record handed to the connection as published", async () => {
    const before = traceRecordCounts();
    await promptOnce(traced(true));
    const after = traceRecordCounts();
    expect(after.published - before.published).toBe(1);
    expect(after.dropped - before.dropped).toBe(0);
  });

  it("counts a record due without an identity to sign it as dropped, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const edges = capture(nc, "TRACE.>");
    await nc.flush();
    const before = traceRecordCounts();
    await promptOnce(traced(false));
    await promptOnce(traced(false));
    const after = traceRecordCounts();
    await sleep(200);
    edges.stop();
    expect(after.published - before.published).toBe(0);
    expect(after.dropped - before.dropped).toBe(2);
    expect(edges.msgs).toHaveLength(0);
    // One warning per connection: a per-prompt log would itself disturb the agent.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("no identity signer"))).toHaveLength(
      1,
    );
  });

  it("counts nothing for an unsigned prompt that never goes out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const agents = traced(false);
    const before = traceRecordCounts();
    await (await handleOf(agents, svc)).prompt("hi"); // returned, never iterated
    await sleep(100);
    expect(traceRecordCounts()).toEqual(before);
    await agents.close();
  });

  it("counts a record whose publish threw as dropped, and the prompt still goes out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realPublish = nc.publish.bind(nc);
    vi.spyOn(nc, "publish").mockImplementation((subject, data, opts) => {
      if (subject === "TRACE.edges") throw new Error("connection draining");
      return realPublish(subject, data, opts);
    });
    const agents = traced(true);
    const handle = await handleOf(agents, svc);
    const before = traceRecordCounts();
    const texts: string[] = [];
    for await (const m of await handle.prompt("hi")) if (m.type === "response") texts.push(m.text);
    await agents.close();
    const after = traceRecordCounts();
    expect(texts).toEqual(["ok"]);
    expect(after.published - before.published).toBe(0);
    expect(after.dropped - before.dropped).toBe(1);
  });

  it("counts nothing in propagate-only mode, where no record is due", async () => {
    const before = traceRecordCounts();
    await promptOnce(traced(true, { edgeSubject: null }));
    await promptOnce(traced(false, { edgeSubject: null }));
    expect(traceRecordCounts()).toEqual(before);
  });

  it("publishes to a configured subject", async () => {
    const custom = capture(nc, "acme.TRACE.edges.v2");
    await nc.flush();
    await promptOnce(traced(true, { edgeSubject: "acme.TRACE.edges.v2" }));
    await sleep(200);
    custom.stop();
    expect(custom.msgs).toHaveLength(1);
  });

  it("returns a frozen snapshot", () => {
    expect(Object.isFrozen(traceRecordCounts())).toBe(true);
  });
});
