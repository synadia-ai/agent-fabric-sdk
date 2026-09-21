import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { Msg } from "@nats-io/nats-core";
import type { PromptInterceptor } from "@synadia-ai/agents";
import type { RequestInterceptor } from "@synadia-ai/agent-service";
import { fabricTracing, traceHeaders } from "../../src/index.js";
import { findNatsServerBinary, NatsServerProcess } from "../harness/nats-server.js";
import { caller, dec, drain, handleOf, host, sleep } from "../support/fixtures.js";

const bin = await findNatsServerBinary();

/** Everything a discovery, a prompt, a status probe and shutdown put on the wire. */
async function lifecycle(
  url: string,
  agent: string,
  hostSide: ReadonlyArray<RequestInterceptor>,
  callerSide: ReadonlyArray<PromptInterceptor>,
  heartbeatExtras?: () => Readonly<Record<string, unknown>>,
): Promise<Msg[]> {
  const nc = await connect({ servers: url, reconnect: false });
  const seen: Msg[] = [];
  const all = nc.subscribe(">");
  void (async () => {
    for await (const m of all) seen.push(m);
  })();
  await nc.flush();
  const { svc } = await host(nc, {
    agent,
    interceptors: hostSide,
    ...(heartbeatExtras ? { heartbeatExtras } : {}),
    onPrompt: async (_env, reply) => {
      traceHeaders(); // what a harness calls before every model request
      await reply("ok");
    },
  });
  const client = caller(nc, { interceptors: callerSide });
  const handle = await handleOf(client, svc);
  await drain(await handle.prompt("hello"));
  await handle.status();
  await sleep(200);
  await svc.stop();
  await client.close();
  await nc.close();
  return seen;
}

const onlyExpectedSubjects = (seen: ReadonlyArray<Msg>): string[] =>
  [
    ...new Set(
      seen
        .map((m) => m.subject)
        .filter(
          (s) => !(s.startsWith("_INBOX.") || s.startsWith("$SRV.") || s.startsWith("agents.")),
        ),
    ),
  ].sort();

/**
 * With tracing off, the fabric must leave no trace on the wire — even when
 * the package is loaded and a tracing object built but not installed.
 *
 * Not "no edge records" — nothing at all: the prompt envelope stays
 * byte-identical to plain protocol 0.3, no subject outside the normal set
 * is touched, and no message carries the JetStream de-duplication header
 * the edge publisher uses. This is the guard that fails the moment
 * someone adds an unconditional publish.
 */
describe.skipIf(!bin)("an untraced run is silent on the wire", () => {
  const server = new NatsServerProcess();
  let seen: Msg[] = [];
  const AGENT = "silent-ts";

  beforeAll(async () => {
    await server.start();
    fabricTracing(); // built, never installed
    seen = await lifecycle(server.url, AGENT, [], []);
  });
  afterAll(async () => {
    await server.stop();
  });

  it("reaches no trace subject", () => {
    expect(seen.filter((m) => m.subject.startsWith("TRACE")).map((m) => m.subject)).toEqual([]);
  });

  it("stamps no de-duplication header", () => {
    expect(seen.filter((m) => m.headers?.get("Nats-Msg-Id")).map((m) => m.subject)).toEqual([]);
  });

  it("sends a plain v0.3 prompt envelope", () => {
    const prompts = seen.filter((m) => m.subject.startsWith(`agents.prompt.${AGENT}.`));
    expect(prompts).toHaveLength(1);
    expect(dec.decode(prompts[0]!.data)).toBe('{"prompt":"hello"}');
  });

  it("touches no unexpected subject", () => {
    expect(onlyExpectedSubjects(seen)).toEqual([]);
  });
});

/**
 * Propagate-only mode (`edgeSubject: null`) forwards lineage and nothing
 * else: the two envelope fields, no record, no de-duplication header, no
 * record counts on the heartbeat.
 */
describe.skipIf(!bin)("a propagate-only run adds the two fields and nothing else", () => {
  const server = new NatsServerProcess();
  let seen: Msg[] = [];
  const AGENT = "propagate-ts";

  beforeAll(async () => {
    await server.start();
    const tracing = fabricTracing({ edgeSubject: null });
    seen = await lifecycle(
      server.url,
      AGENT,
      [tracing.requestInterceptor],
      [tracing.promptInterceptor],
      tracing.heartbeatExtras,
    );
  });
  afterAll(async () => {
    await server.stop();
  });

  it("reaches no trace subject and stamps no de-duplication header", () => {
    expect(seen.filter((m) => m.subject.startsWith("TRACE")).map((m) => m.subject)).toEqual([]);
    expect(seen.filter((m) => m.headers?.get("Nats-Msg-Id")).map((m) => m.subject)).toEqual([]);
    expect(onlyExpectedSubjects(seen)).toEqual([]);
  });

  it("sends the envelope with thread_id and root_id after the prompt", () => {
    const prompts = seen.filter((m) => m.subject.startsWith(`agents.prompt.${AGENT}.`));
    expect(prompts).toHaveLength(1);
    expect(dec.decode(prompts[0]!.data)).toMatch(
      /^\{"prompt":"hello","thread_id":"([0-9a-f]{32})","root_id":"\1"\}$/,
    );
  });

  it("reports no record counts", () => {
    const beats = seen.filter((m) => m.subject.startsWith(`agents.hb.${AGENT}.`));
    expect(beats.length).toBeGreaterThan(0);
    for (const m of beats) {
      const beat = JSON.parse(dec.decode(m.data)) as Record<string, unknown>;
      expect(beat).not.toHaveProperty("records_published");
      expect(beat).not.toHaveProperty("records_dropped");
    }
  });
});
