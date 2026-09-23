// The add-on's hooks on a real `AgentService` and `Agents`, over a local
// nats-server in operator mode (real account NKEYs, so `agent` has the
// `{account}.{user}` form `edge.json` requires). The service and the client
// are wired as the PI plugin wires them — the extension's request
// interceptors before the tools' own, its prompt interceptors on the client
// the tools prompt through, its heartbeat extras — and the handler drives
// the events in the plugin's order, standing in for PI: `promptAccepted`,
// the turn inside `aroundInject`, two provider requests asking
// `providerHeaders`, one `prompt_agent` through `AgentTools` inside
// `aroundToolCall`, the reply, `promptEnded`.
//
// A traced caller (alice) prompts PI (carol); PI's "model" prompts a traced
// host C (carol too: the tools refuse to prompt the caller's identity back,
// and the fixture has two users on the account), whose handler prompts PI
// back in the same tree, which the loop guard refuses with 409. Every edge
// on the wire validates against `edge.json`, verifies as its writer's, and
// PI's own is filed under the served thread with the tool-call ID.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import {
  Agents,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  newAgentId,
  ServiceError,
  signerFromCredsFile,
  verifySender,
  type AgentToolResult,
  type SenderSigner,
} from "@synadia-ai/agents";
import {
  activeTrace,
  fabricTracing,
  ROOT_ID_HEADER,
  THREAD_ID_HEADER,
  traceHeaders,
  traceRecordCounts,
} from "@synadia-ai/agent-fabric";
import createExtension, { EXTENSION_NAME, type ServedRequest } from "../../src/index.js";
import { extensionContext, recordingLogger } from "../support/fake-plugin.js";
import {
  dec,
  drain,
  edgeSchemaErrors,
  enc,
  findNatsServerBinary,
  handleOf,
  identityFixture,
  NatsServerProcess,
  parse,
  sleep,
} from "../support/harness.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}
const bin = await findNatsServerBinary();
const opKeys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const idOf = (user: string): string =>
  newAgentId(opKeys.accounts[opKeys.users[user]!.account]!.public, opKeys.users[user]!.public);
const ALICE_ID = idOf("alice");
const CAROL_ID = idOf("carol");

describe.skipIf(!bin)(
  "PI on the fabric: a traced caller, PI's model delegating, a loop refused",
  () => {
    const server = new NatsServerProcess();
    const connections: NatsConnection[] = [];
    const services: AgentService[] = [];
    const clients: Agents[] = [];
    const { logger, lines } = recordingLogger();
    const ext = createExtension(extensionContext({ logger }), {});

    // What happened, in the order the observer saw it.
    const wire: Array<{ what: "edge" | "PI" | "C"; msg: Msg }> = [];
    const piHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
    const piToolResults: AgentToolResult[] = [];
    const seenByC: Array<Record<string, string>> = [];
    let loopBack: unknown = "not attempted";
    let answer: string[] = [];
    let piStatus: Record<string, unknown> = {};
    let countsBefore = traceRecordCounts();
    let piThreadSeenInHandler: string | undefined;

    beforeAll(async () => {
      await server.start({ configPath: identityFixture("operator/operator.conf") });
      const as = async (user: string): Promise<{ nc: NatsConnection; signer: SenderSigner }> => {
        const creds = identityFixture(`operator/${user}.creds`);
        const nc = await connect({
          servers: server.url,
          authenticator: credsAuthenticator(enc.encode(await readFile(creds, "utf8"))),
          reconnect: false,
        });
        connections.push(nc);
        return { nc, signer: await signerFromCredsFile(creds) };
      };
      const alice = await as("alice");
      const carol = await as("carol");
      const observer = await as("alice");

      // --- PI, wired as the plugin wires it ---------------------------------
      const piClient = new Agents({
        nc: carol.nc,
        identity: { signer: carol.signer },
        interceptors: ext.promptInterceptors!,
      });
      clients.push(piClient);
      const piAddress = "agents.prompt.pi.fabric.editor";
      const tools = new AgentTools({
        agents: piClient,
        tools: BLOCKING_AGENT_TOOLS,
        selfAddress: piAddress,
      });
      let nextId = 0;
      const pi = new AgentService({
        nc: carol.nc,
        agent: "pi",
        owner: "fabric",
        name: "editor",
        identity: { signer: carol.signer },
        heartbeatIntervalS: 30,
        keepaliveIntervalS: null,
        interceptors: [...ext.requestInterceptors!, tools.requestInterceptor],
        heartbeatExtras: ext.heartbeatExtras!,
      });
      services.push(pi);
      expect(pi.subject.prompt).toBe(piAddress);

      // --- C, an SDK-built agent whose handler prompts PI back ---------------
      const cTracing = fabricTracing();
      const cClient = new Agents({
        nc: carol.nc,
        identity: { signer: carol.signer },
        interceptors: [cTracing.promptInterceptor],
      });
      clients.push(cClient);
      const c = new AgentService({
        nc: carol.nc,
        agent: "fabric-c",
        owner: "fabric",
        name: "main",
        identity: { signer: carol.signer },
        heartbeatIntervalS: 30,
        keepaliveIntervalS: null,
        interceptors: [cTracing.requestInterceptor],
      });
      services.push(c);
      c.onPrompt(async (_envelope, response) => {
        seenByC.push(traceHeaders());
        try {
          const toPi = await handleOf(cClient, pi);
          await drain(await toPi.prompt("and back to PI", { maxWaitMs: 5_000 }));
          loopBack = "admitted";
        } catch (err) {
          loopBack = err;
        }
        await response.send("c-ok");
      });

      pi.onPrompt((envelope, response) => {
        const sender = response.sender;
        const served: ServedRequest = Object.freeze({
          id: `pi-${++nextId}`,
          extras: Object.freeze({ ...(envelope.extras ?? {}) }),
          ...(sender?.trust === "verified" ? { caller: String(sender.id) } : {}),
        });
        // Synchronous, in the handler's context, after every interceptor.
        ext.events!.promptAccepted!(served);
        piThreadSeenInHandler = activeTrace()?.threadId;
        // The hand-over to PI's loop: the turn runs in the context bound here.
        const completion = ext.events!.aroundInject!(served, async () => {
          // Two provider requests, then the model's tool call, then the reply.
          piHeaders.push(ext.events!.providerHeaders!(served));
          piHeaders.push(ext.events!.providerHeaders!(served));
          const result = await ext.events!.aroundToolCall!(served, "prompt_agent", () =>
            tools.execute(
              "prompt_agent",
              { address: c.subject.prompt, prompt: "one fact" },
              { toolCallId: "toolu_pi_01" },
            ),
          );
          piToolResults.push(result);
          await response.send(`edited(${JSON.stringify(result)})`);
        });
        return completion.finally(() => ext.events!.promptEnded!(served, "ok", Date.now()));
      });

      await c.start();
      await pi.start();
      await ext.started!({ agents: piClient, service: pi });

      for (const [subject, what] of [
        ["TRACE.edges", "edge"],
        [pi.subject.prompt, "PI"],
        [c.subject.prompt, "C"],
      ] as const) {
        const sub = observer.nc.subscribe(subject);
        void (async () => {
          for await (const msg of sub) wire.push({ what, msg });
        })();
      }
      await observer.nc.flush();

      // --- A, the traced caller --------------------------------------------
      const a = new Agents({
        nc: alice.nc,
        identity: { signer: alice.signer },
        interceptors: [fabricTracing().promptInterceptor],
      });
      clients.push(a);
      const toPi = await handleOf(a, pi);
      countsBefore = traceRecordCounts();
      answer = [];
      for await (const m of await toPi.prompt("edit this", {
        context: { toolCallId: "toolu_A" },
      })) {
        if (m.type === "response") answer.push(m.text);
      }
      piStatus = (await toPi.status()).extras;
      await sleep(300);
    });

    afterAll(async () => {
      for (const client of clients) await client.close();
      for (const svc of services) await svc.stop();
      for (const nc of connections) await nc.close();
      await server.stop();
    });

    const edges = (): Msg[] => wire.filter((w) => w.what === "edge").map((w) => w.msg);
    const records = (): Array<Record<string, unknown>> => edges().map(parse);

    it("answers the caller through PI's delegation", () => {
      expect(answer).toHaveLength(1);
      expect(answer[0]).toContain('"reply":"c-ok"');
      expect(piToolResults).toHaveLength(1);
      expect(piToolResults[0]).toMatchObject({ state: "completed", reply: "c-ok" });
    });

    it("puts every edge on the wire before the prompt it describes, the refused one included", () => {
      expect(wire.map((w) => w.what)).toEqual(["edge", "PI", "edge", "C", "edge", "PI"]);
    });

    it("writes records that validate against edge.json, each signed by its writer", async () => {
      expect(records()).toHaveLength(3);
      for (const msg of edges()) {
        const record = parse(msg);
        expect(edgeSchemaErrors(record)).toEqual([]);
        const sender = await verifySender(msg, "stored");
        expect(sender?.trust).toBe("verified");
        expect(sender?.trust === "verified" ? sender.id : undefined).toBe(record["agent"]);
        expect(msg.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
      }
      const [fromA, fromPi, fromC] = records();
      expect(fromA!["agent"]).toBe(ALICE_ID);
      expect(fromPi!["agent"]).toBe(CAROL_ID);
      expect(fromC!["agent"]).toBe(CAROL_ID);
    });

    it("serves the caller's thread: the handler and the provider requests see the pair, the hint counts the requests", () => {
      const [root] = records();
      const threadId = root!["thread_id"] as string;
      expect(root).toMatchObject({ parent_id: null, root_id: threadId, tool_call_id: "toolu_A" });
      expect(piThreadSeenInHandler).toBe(threadId);
      expect(piHeaders).toEqual([
        { [THREAD_ID_HEADER]: threadId, [ROOT_ID_HEADER]: threadId },
        { [THREAD_ID_HEADER]: threadId, [ROOT_ID_HEADER]: threadId },
      ]);
    });

    it("files PI's delegation under the served thread, with the model's tool-call ID and the two calls before it", () => {
      const [root, child] = records();
      const threadId = root!["thread_id"] as string;
      expect(child).toMatchObject({
        parent_id: threadId,
        root_id: threadId,
        tool_call_id: "toolu_pi_01",
        turn_count_hint: 2,
      });
      expect(child!["thread_id"]).not.toBe(threadId);
      const [toC] = wire.filter((w) => w.what === "C");
      expect(dec.decode(toC!.msg.data)).toBe(
        `{"prompt":"one fact","thread_id":"${child!["thread_id"] as string}","root_id":"${threadId}"}`,
      );
      expect(seenByC).toEqual([
        { [THREAD_ID_HEADER]: child!["thread_id"], [ROOT_ID_HEADER]: threadId },
      ]);
    });

    it("refuses the prompt back into the tree PI waits in with 409, before any ack", () => {
      const [root, , back] = records();
      expect(back).toMatchObject({ root_id: root!["thread_id"], tool_call_id: null });
      expect(loopBack).toBeInstanceOf(ServiceError);
      expect((loopBack as ServiceError).code).toBe(409);
      expect((loopBack as ServiceError).message).toContain(root!["thread_id"] as string);
    });

    it("counts the records and reports them on PI's status", () => {
      const after = traceRecordCounts();
      expect(after.published - countsBefore.published).toBe(3);
      expect(after.dropped - countsBefore.dropped).toBe(0);
      expect(piStatus["records_published"]).toBe(after.published);
      expect(piStatus["records_dropped"]).toBe(after.dropped);
    });

    it("logged the definitive address at start, and no identity warning", () => {
      expect(lines.filter((l) => l.level === "warn")).toEqual([]);
      expect(lines.map((l) => l.message)).toContain(
        `${EXTENSION_NAME}: tracing agents.prompt.pi.fabric.editor, edge records on TRACE.edges`,
      );
    });
  },
);
