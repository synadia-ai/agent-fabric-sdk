// End to end, in operator mode (real account NKEYs, so the `agent` field is
// the `{account}.{user}` form the edge schema requires): a traced caller A
// prompts a traced host B, whose handler — as a model tool call would —
// prompts a traced host C. Every edge lands before the prompt it
// describes, validates against `edge.json`, verifies as alice's signed
// record, and carries one id three ways; each host sees its thread and
// root through `traceHeaders()`; the child is filed under its parent.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import type { AgentService } from "@synadia-ai/agent-service";
import {
  newAgentId,
  signerFromCredsFile,
  verifySender,
  type Agent,
  type Agents,
  type SenderSigner,
} from "@synadia-ai/agents";
import { fabricTracing, traceHeaders, traceRecordCounts } from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import {
  caller,
  dec,
  drain,
  edgeSchemaErrors,
  enc,
  handleOf,
  host,
  parse,
  sleep,
} from "../support/fixtures.js";

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

describe.skipIf(!bin)("a traced caller prompts a traced host, which prompts another", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let observer: NatsConnection;
  let signer: SenderSigner;
  const tracing = fabricTracing();
  const services: AgentService[] = [];
  const clients: Agents[] = [];

  // What happened, in the order the observer saw it.
  const wire: Array<{ what: "edge" | "B" | "C"; msg: Msg }> = [];
  const seenByB: Array<Record<string, string>> = [];
  const seenByC: Array<Record<string, string>> = [];
  let answer: string[] = [];
  let countsBefore = traceRecordCounts();
  let statusOfB: Record<string, unknown> = {};

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

    const c = await host(nc, {
      agent: "fabric-c",
      interceptors: [tracing.requestInterceptor],
      heartbeatExtras: tracing.heartbeatExtras,
      onPrompt: async (_env, reply) => {
        seenByC.push(traceHeaders());
        await reply("c-ok");
      },
    });
    services.push(c.svc);

    // B's own client, the one its "tool" prompts C with: traced, signed.
    const tool = caller(nc, { signer, interceptors: [tracing.promptInterceptor] });
    clients.push(tool);
    const toC: Agent = await handleOf(tool, c.svc);

    const b = await host(nc, {
      agent: "fabric-b",
      interceptors: [tracing.requestInterceptor],
      heartbeatExtras: tracing.heartbeatExtras,
      onPrompt: async (_env, reply) => {
        seenByB.push(traceHeaders()); // two model calls before the tool call …
        traceHeaders();
        await drain(await toC.prompt("to C", { context: { toolCallId: "toolu_B" } })); // … then C
        await reply("b-ok");
      },
    });
    services.push(b.svc);

    for (const [subject, what] of [
      ["TRACE.edges", "edge"],
      [b.svc.subject.prompt, "B"],
      [c.svc.subject.prompt, "C"],
    ] as const) {
      const sub = observer.subscribe(subject);
      void (async () => {
        for await (const msg of sub) wire.push({ what, msg });
      })();
    }
    await observer.flush();

    const a = caller(nc, { signer, interceptors: [tracing.promptInterceptor] });
    clients.push(a);
    const toB = await handleOf(a, b.svc);
    countsBefore = traceRecordCounts();
    answer = [];
    for await (const m of await toB.prompt("to B", { context: { toolCallId: "toolu_A" } })) {
      if (m.type === "response") answer.push(m.text);
    }
    statusOfB = (await toB.status()).extras;
    await sleep(300);
  });

  afterAll(async () => {
    for (const c of clients) await c.close();
    for (const s of services) await s.stop();
    await observer.close();
    await nc.close();
    await server.stop();
  });

  const edges = (): Msg[] => wire.filter((w) => w.what === "edge").map((w) => w.msg);
  const records = (): Array<Record<string, unknown>> => edges().map(parse);

  it("answers the caller through both hops", () => {
    expect(answer).toEqual(["b-ok"]);
  });

  it("publishes each edge before the prompt it describes", () => {
    expect(wire.map((w) => w.what)).toEqual(["edge", "B", "edge", "C"]);
  });

  it("writes records that validate against edge.json", () => {
    expect(records()).toHaveLength(2);
    for (const record of records()) expect(edgeSchemaErrors(record)).toEqual([]);
  });

  it("signs every record as its writer, with one id three ways", async () => {
    for (const msg of edges()) {
      const record = parse(msg);
      // Stored mode, as the reader verifies: the signature over the short
      // form the writer published to.
      const sender = await verifySender(msg, "stored");
      expect(sender?.trust).toBe("verified");
      expect(sender?.trust === "verified" ? sender.id : undefined).toBe(ALICE_ID);
      expect(record["agent"]).toBe(ALICE_ID);
      expect(sender?.header.nonce).toBe(record["record_id"]);
      expect(msg.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
    }
  });

  it("roots the caller's prompt: a null parent, root = thread, the caller's tool call", () => {
    const [root] = records();
    expect(root).toMatchObject({
      version: 1,
      kind: "edge",
      parent_id: null,
      root_id: root!["thread_id"],
      tool_call_id: "toolu_A",
      turn_count_hint: 0,
    });
  });

  it("carries exactly the two fields after the prompt, byte for byte", () => {
    const [root, child] = records();
    const [toB] = wire.filter((w) => w.what === "B");
    const [toC] = wire.filter((w) => w.what === "C");
    expect(dec.decode(toB!.msg.data)).toBe(
      `{"prompt":"to B","thread_id":"${root!["thread_id"] as string}","root_id":"${root!["thread_id"] as string}"}`,
    );
    expect(dec.decode(toC!.msg.data)).toBe(
      `{"prompt":"to C","thread_id":"${child!["thread_id"] as string}","root_id":"${root!["thread_id"] as string}"}`,
    );
  });

  it("lets the host stamp its thread and root on its model calls", () => {
    const [root] = records();
    expect(seenByB).toEqual([
      { "X-Synadia-Thread-ID": root!["thread_id"], "X-Synadia-Root-ID": root!["thread_id"] },
    ]);
  });

  it("files the child under its parent: the parent's thread, the tree's root, the turn count", () => {
    const [root, child] = records();
    expect(child!["thread_id"]).not.toBe(root!["thread_id"]);
    expect(child).toMatchObject({
      parent_id: root!["thread_id"],
      root_id: root!["thread_id"],
      tool_call_id: "toolu_B",
      turn_count_hint: 2,
    });
    expect(seenByC).toEqual([
      { "X-Synadia-Thread-ID": child!["thread_id"], "X-Synadia-Root-ID": root!["thread_id"] },
    ]);
  });

  it("counts both records and reports them on the host's status", () => {
    const after = traceRecordCounts();
    expect(after.published - countsBefore.published).toBe(2);
    expect(after.dropped - countsBefore.dropped).toBe(0);
    expect(statusOfB["records_published"]).toBe(after.published);
    expect(statusOfB["records_dropped"]).toBe(after.dropped);
  });
});
