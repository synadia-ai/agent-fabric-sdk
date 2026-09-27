// The add-on's hooks on a real `AgentService` and `Agents`, over a local
// nats-server in operator mode (real account NKEYs, so `agent` has the
// `{account}.{user}` form `edge.json` and `served.json` require). The
// service and the client are wired as the OpenClaw gateway wires them —
// the extension's request interceptors before the tools' own, its prompt
// interceptors on the client the tools prompt through, its heartbeat
// extras, `started` once the service is up — and the handler drives the
// events in the gateway's order, standing in for OpenClaw:
// `promptAccepted`, the turn inside `aroundDispatch`, one `prompt_agent`
// through `AgentTools` inside `aroundToolCall`, the reply, `promptEnded`
// once the dispatch settled.
//
// A traced caller (alice) prompts OpenClaw (carol); OpenClaw's "model"
// prompts a traced host, the researcher (carol too: the fixture has two
// users on the account, and the tools refuse to prompt the caller's
// identity back). On the edge subject: alice's edge, OpenClaw's signed
// `served` pair naming the served thread and the trace id its turn ran
// under, and OpenClaw's own edge under the served thread with the
// tool-call ID. Every record validates against its schema and verifies as
// its writer's, one id three ways.

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
  signerFromCredsFile,
  verifySender,
  type AgentToolResult,
  type SenderSigner,
} from "@synadia-ai/agents";
import {
  activeTrace,
  fabricTracing,
  traceRecordCounts,
  type Outcome,
  type ServedRequest,
} from "@synadia-ai/agent-fabric";
import { createFabricExtension, EXTENSION_NAME, openClawTraceScope } from "../../src/index.js";
import { extensionContext, recordingLogger } from "../support/fake-plugin.js";
import {
  dec,
  edgeSchemaErrors,
  enc,
  findNatsServerBinary,
  handleOf,
  identityFixture,
  NatsServerProcess,
  parse,
  servedSchemaErrors,
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
const OC_ADDRESS = "agents.prompt.oc.team.summarizer";

describe.skipIf(!bin)(
  "OpenClaw on the fabric: a traced caller, the served pair, OpenClaw's model delegating",
  () => {
    const server = new NatsServerProcess();
    const connections: NatsConnection[] = [];
    const services: AgentService[] = [];
    const clients: Agents[] = [];
    const { logger, lines } = recordingLogger();
    const ext = createFabricExtension(extensionContext({ logger }), {});

    const wire: Array<{ what: "trace" | "OC" | "R"; msg: Msg }> = [];
    const toolResults: AgentToolResult[] = [];
    const inDispatch: Array<{ traceId: string | undefined; threadId: string | undefined }> = [];
    const outcomes: Outcome[] = [];
    let answer: string[] = [];
    let ocStatus: Record<string, unknown> = {};
    let countsBefore = traceRecordCounts();

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

      // --- the researcher, an SDK-built agent -----------------------------
      const rTracing = fabricTracing();
      const researcher = new AgentService({
        nc: carol.nc,
        agent: "fabric-r",
        owner: "team",
        name: "researcher",
        identity: { signer: carol.signer },
        heartbeatIntervalS: 30,
        keepaliveIntervalS: null,
        interceptors: [rTracing.requestInterceptor],
      });
      services.push(researcher);
      researcher.onPrompt(async (_envelope, response) => {
        await response.send("NATS subjects are hierarchical.");
      });

      // --- OpenClaw, wired as the gateway wires it -------------------------
      const ocClient = new Agents({
        nc: carol.nc,
        identity: { signer: carol.signer },
        interceptors: ext.promptInterceptors!,
      });
      clients.push(ocClient);
      const tools = new AgentTools({
        agents: ocClient,
        tools: BLOCKING_AGENT_TOOLS,
        selfAddress: OC_ADDRESS,
      });
      let nextId = 0;
      const oc = new AgentService({
        nc: carol.nc,
        agent: "oc",
        owner: "team",
        name: "summarizer",
        identity: { signer: carol.signer },
        heartbeatIntervalS: 30,
        keepaliveIntervalS: null,
        interceptors: [...ext.requestInterceptors!, tools.requestInterceptor],
        heartbeatExtras: ext.heartbeatExtras!,
      });
      services.push(oc);
      expect(oc.subject.prompt).toBe(OC_ADDRESS);

      oc.onPrompt(async (envelope, response) => {
        const sender = response.sender;
        const served: ServedRequest = Object.freeze({
          id: String(++nextId),
          extras: Object.freeze({ ...(envelope.extras ?? {}) }),
          ...(sender?.trust === "verified" ? { caller: String(sender.id) } : {}),
        });
        // Synchronous, in the handler's context, after every interceptor.
        ext.events!.promptAccepted!(served);
        let outcome: Outcome = "ok";
        try {
          // The dispatch: OpenClaw's turn, its model calls, its tool runner.
          await ext.events!.aroundDispatch!(served, async () => {
            inDispatch.push({
              traceId: openClawTraceScope()?.getStore()?.traceId,
              threadId: activeTrace()?.threadId,
            });
            const result = await ext.events!.aroundToolCall!(served, "prompt_agent", () =>
              tools.execute(
                "prompt_agent",
                { address: researcher.subject.prompt, prompt: "one fact about NATS" },
                { toolCallId: "call_oc_01" },
              ),
            );
            toolResults.push(result);
            await response.send(`summary(${JSON.stringify(result)})`);
          });
        } catch (err) {
          outcome = "error";
          throw err;
        } finally {
          outcomes.push(outcome);
          ext.events!.promptEnded!(served, outcome, Date.now());
        }
      });

      await researcher.start();
      await oc.start();
      await ext.started!({ agents: ocClient, service: oc });

      for (const [subject, what] of [
        ["TRACE.edges", "trace"],
        [oc.subject.prompt, "OC"],
        [researcher.subject.prompt, "R"],
      ] as const) {
        const sub = observer.nc.subscribe(subject);
        void (async () => {
          for await (const msg of sub) wire.push({ what, msg });
        })();
      }
      await observer.nc.flush();

      // --- the traced caller ----------------------------------------------
      const a = new Agents({
        nc: alice.nc,
        identity: { signer: alice.signer },
        interceptors: [fabricTracing().promptInterceptor],
      });
      clients.push(a);
      const toOc = await handleOf(a, oc);
      countsBefore = traceRecordCounts();
      answer = [];
      for await (const m of await toOc.prompt("summarize this", {
        context: { toolCallId: "toolu_coordinator" },
      })) {
        if (m.type === "response") answer.push(m.text);
      }
      await ext.stopping!();
      ocStatus = (await toOc.status()).extras;
      await sleep(300);
    });

    afterAll(async () => {
      for (const client of clients) await client.close();
      for (const svc of services) await svc.stop();
      for (const nc of connections) await nc.close();
      await server.stop();
    });

    const traceMsgs = (): Msg[] => wire.filter((w) => w.what === "trace").map((w) => w.msg);
    const ofKind = (kind: string): Msg[] => traceMsgs().filter((m) => parse(m)["kind"] === kind);

    it("answers the caller through OpenClaw's delegation, the dispatch ending ok", () => {
      expect(answer).toHaveLength(1);
      expect(answer[0]).toContain("NATS subjects are hierarchical.");
      expect(toolResults).toEqual([
        expect.objectContaining({ state: "completed", reply: "NATS subjects are hierarchical." }),
      ]);
      expect(outcomes).toEqual(["ok"]);
    });

    it("puts on the edge subject the caller's edge, the pair around OpenClaw's own edge", () => {
      const seq = traceMsgs().map((m) => {
        const r = parse(m);
        return r["kind"] === "served" ? `served:${r["phase"] as string}` : `${r["kind"] as string}`;
      });
      expect(seq[0]).toBe("edge");
      expect(seq[seq.length - 1]).toBe("served:end");
      expect(seq.slice().sort()).toEqual(["edge", "edge", "served:end", "served:start"]);
      expect(seq.indexOf("served:start")).toBeLessThan(seq.indexOf("served:end"));
    });

    it("publishes the pair signed as OpenClaw, valid against served.json, one id three ways", async () => {
      const pair = ofKind("served");
      expect(pair).toHaveLength(2);
      for (const msg of pair) {
        const record = parse(msg);
        expect(servedSchemaErrors(record)).toEqual([]);
        const sender = await verifySender(msg, "stored");
        expect(sender?.trust).toBe("verified");
        expect(sender?.trust === "verified" ? sender.id : undefined).toBe(CAROL_ID);
        expect(sender?.header.nonce).toBe(record["record_id"]);
        expect(msg.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
        expect(record["agent"]).toBe(CAROL_ID);
      }
    });

    it("names the served thread and the trace id OpenClaw's turn ran under", () => {
      const [rootEdge] = ofKind("edge").map(parse);
      const threadId = rootEdge!["thread_id"] as string;
      expect(rootEdge).toMatchObject({ agent: ALICE_ID, root_id: threadId, parent_id: null });
      const [start, end] = ofKind("served").map(parse);
      expect(inDispatch).toHaveLength(1);
      const { traceId, threadId: servedThread } = inDispatch[0]!;
      expect(servedThread).toBe(threadId);
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(start).toMatchObject({
        thread_id: threadId,
        root_id: threadId,
        harness: "openclaw",
        harness_thread_id: traceId,
        phase: "start",
      });
      expect(end).toMatchObject({
        thread_id: threadId,
        root_id: threadId,
        harness: "openclaw",
        harness_thread_id: traceId,
        phase: "end",
        status: "ok",
      });
      expect(end!["ts"] as number).toBeGreaterThanOrEqual(start!["ts"] as number);
    });

    it("files OpenClaw's delegation under the served thread, with the model's tool-call ID", async () => {
      const edges = ofKind("edge");
      expect(edges).toHaveLength(2);
      for (const msg of edges) {
        expect(edgeSchemaErrors(parse(msg))).toEqual([]);
        const sender = await verifySender(msg, "stored");
        expect(sender?.trust === "verified" ? sender.id : undefined).toBe(parse(msg)["agent"]);
      }
      const [root, child] = edges.map(parse);
      const threadId = root!["thread_id"] as string;
      expect(child).toMatchObject({
        agent: CAROL_ID,
        parent_id: threadId,
        root_id: threadId,
        tool_call_id: "call_oc_01",
      });
      const [toR] = wire.filter((w) => w.what === "R");
      expect(dec.decode(toR!.msg.data)).toBe(
        `{"prompt":"one fact about NATS","thread_id":"${child!["thread_id"] as string}","root_id":"${threadId}"}`,
      );
    });

    it("counts the records, the pair included, and reports them on OpenClaw's status", () => {
      const after = traceRecordCounts();
      expect(after.published - countsBefore.published).toBe(4);
      expect(after.dropped - countsBefore.dropped).toBe(0);
      expect(ocStatus["records_published"]).toBe(after.published);
      expect(ocStatus["records_dropped"]).toBe(after.dropped);
    });

    it("logged the definitive address at start, and no warning", () => {
      expect(lines.filter((l) => l.level === "warn")).toEqual([]);
      expect(lines.map((l) => l.message)).toContain(
        `${EXTENSION_NAME}: tracing ${OC_ADDRESS}, edge and served records on TRACE.edges`,
      );
    });
  },
);
