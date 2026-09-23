// The add-on's hooks on a real `AgentService` and `Agents`, over a local
// nats-server in operator mode (real account NKEYs, so `agent` has the
// `{account}.{user}` form `edge.json` and `served.json` require). The
// service and the client are wired as the Claude Code channel's MCP server
// wires them (`server.ts` at `85a69c8`) — the extension's request
// interceptors before the tools' own, its prompt interceptors on the client
// the tools prompt through, its heartbeat extras, `started` once the
// service is up — and the handler drives the events in the server's order,
// standing in for Claude Code: `sessionStarted` from the hook's file before
// the prompt, `promptAccepted` in the handler, which takes a snapshot of its
// context and stays open; one `prompt_agent` arriving as a separate MCP
// call, re-entered through the snapshot and run inside `aroundToolCall`;
// the reply; `promptEnded` with the reply's time; then the `Stop` hook's
// `turnStopped` a moment later, the closing call written in between.
//
// A traced caller (alice) prompts Claude Code (carol); Claude Code's
// "model" prompts a traced host, the researcher (carol too: the fixture has
// two users on the account, and the tools refuse to prompt the caller's
// identity back). On the edge subject: alice's edge, Claude Code's signed
// `served` pair naming the served thread and the session, its `end` at the
// stop, and Claude Code's own edge under the served thread with the
// tool-call ID. Every record validates against its schema and verifies as
// its writer's, one id three ways.

import { AsyncLocalStorage } from "node:async_hooks";
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
import createExtension, { EXTENSION_NAME } from "../../src/index.js";
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
const CC_ADDRESS = "agents.prompt.cc.team.claude";
const SESSION = "0b5e7c0e-3f0a-4c55-9d0e-8b2f6a1d4c21";
// The Stop hook runs this long after the reply: the closing call in between.
const CLOSING_MS = 1_500;

describe.skipIf(!bin)(
  "Claude Code on the fabric: a traced caller, the served pair on the session, its model delegating",
  () => {
    const server = new NatsServerProcess();
    const connections: NatsConnection[] = [];
    const services: AgentService[] = [];
    const clients: Agents[] = [];
    const { logger, lines } = recordingLogger();
    const ext = createExtension(extensionContext({ logger }), {});

    const wire: Array<{ what: "trace" | "CC" | "R"; msg: Msg }> = [];
    const toolResults: AgentToolResult[] = [];
    const inToolCall: Array<string | undefined> = [];
    const outcomes: Outcome[] = [];
    let repliedAtMs = 0;
    let stoppedAtMs = 0;
    let answer: string[] = [];
    let ccStatus: Record<string, unknown> = {};
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

      // --- Claude Code, wired as the channel's MCP server wires it ---------
      const ccClient = new Agents({
        nc: carol.nc,
        identity: { signer: carol.signer },
        interceptors: ext.promptInterceptors!,
      });
      clients.push(ccClient);
      const tools = new AgentTools({
        agents: ccClient,
        tools: BLOCKING_AGENT_TOOLS,
        selfAddress: CC_ADDRESS,
      });
      let nextId = 0;
      const cc = new AgentService({
        nc: carol.nc,
        agent: "cc",
        owner: "team",
        name: "claude",
        identity: { signer: carol.signer },
        heartbeatIntervalS: 30,
        keepaliveIntervalS: null,
        interceptors: [...ext.requestInterceptors!, tools.requestInterceptor],
        heartbeatExtras: ext.heartbeatExtras!,
      });
      services.push(cc);
      expect(cc.subject.prompt).toBe(CC_ADDRESS);

      // The MCP transport's context, outside every request: an agent-tool
      // call arrives here as an MCP request of its own, later than the
      // handler's, and the plugin re-enters the handler's context from it.
      const fromMcp = AsyncLocalStorage.snapshot();

      cc.onPrompt(async (envelope, response) => {
        const sender = response.sender;
        const served: ServedRequest = Object.freeze({
          id: String(++nextId),
          extras: Object.freeze({ ...(envelope.extras ?? {}) }),
          ...(sender?.trust === "verified" ? { caller: String(sender.id) } : {}),
          sessionId: SESSION,
        });
        const enter = AsyncLocalStorage.snapshot();
        // Synchronous, in the handler's context, after every interceptor.
        ext.events!.promptAccepted!(served);
        let outcome: Outcome = "ok";
        let endedAt: number | undefined;
        try {
          // The channel notification goes to Claude Code; the handler stays
          // open until the model calls `reply` with `done`. First the model
          // calls `prompt_agent`.
          const result = await new Promise<AgentToolResult>((resolve, reject) => {
            setImmediate(() =>
              fromMcp(() => {
                inToolCall.push(activeTrace()?.threadId);
                enter(() =>
                  ext.events!.aroundToolCall!(served, "prompt_agent", () => {
                    inToolCall.push(activeTrace()?.threadId);
                    return tools.execute(
                      "prompt_agent",
                      { address: researcher.subject.prompt, prompt: "one fact about NATS" },
                      { toolCallId: "toolu_01CCfabric" },
                    );
                  }),
                ).then(resolve, reject);
              }),
            );
          });
          toolResults.push(result);
          // `reply` with done: the request completes.
          await response.send(`fact(${JSON.stringify(result)})`);
          endedAt = Date.now();
        } catch (err) {
          outcome = "error";
          throw err;
        } finally {
          outcomes.push(outcome);
          repliedAtMs = endedAt ?? Date.now();
          ext.events!.promptEnded!(served, outcome, repliedAtMs);
        }
      });

      await researcher.start();
      await cc.start();
      await ext.started!({ agents: ccClient, service: cc });
      // The SessionStart hook's file, read once at start.
      ext.events!.sessionStarted!(SESSION, "startup");

      for (const [subject, what] of [
        ["TRACE.edges", "trace"],
        [cc.subject.prompt, "CC"],
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
      const toCc = await handleOf(a, cc);
      countsBefore = traceRecordCounts();
      answer = [];
      for await (const m of await toCc.prompt("one fact about NATS, please", {
        context: { toolCallId: "toolu_coordinator" },
      })) {
        if (m.type === "response") answer.push(m.text);
      }
      // The closing call, then the Stop hook.
      await sleep(CLOSING_MS);
      stoppedAtMs = Date.now();
      ext.events!.turnStopped!(SESSION, stoppedAtMs);
      ccStatus = (await toCc.status()).extras;
      await ext.stopping!();
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

    it("answers the caller through Claude Code's delegation, the request ending ok", () => {
      expect(answer).toHaveLength(1);
      expect(answer[0]).toContain("NATS subjects are hierarchical.");
      expect(toolResults).toEqual([
        expect.objectContaining({ state: "completed", reply: "NATS subjects are hierarchical." }),
      ]);
      expect(outcomes).toEqual(["ok"]);
    });

    it("puts on the edge subject the caller's edge, the pair around Claude Code's own edge", () => {
      const seq = traceMsgs().map((m) => {
        const r = parse(m);
        return r["kind"] === "served" ? `served:${r["phase"] as string}` : `${r["kind"] as string}`;
      });
      expect(seq[0]).toBe("edge");
      expect(seq[seq.length - 1]).toBe("served:end");
      expect(seq.slice().sort()).toEqual(["edge", "edge", "served:end", "served:start"]);
      expect(seq.indexOf("served:start")).toBeLessThan(seq.indexOf("served:end"));
    });

    it("publishes the pair signed as Claude Code, valid against served.json, one id three ways", async () => {
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

    it("names the served thread and the session, and ends at the stop, not the reply", () => {
      const [rootEdge] = ofKind("edge").map(parse);
      const threadId = rootEdge!["thread_id"] as string;
      expect(rootEdge).toMatchObject({ agent: ALICE_ID, root_id: threadId, parent_id: null });
      const [start, end] = ofKind("served").map(parse);
      expect(start).toMatchObject({
        thread_id: threadId,
        root_id: threadId,
        harness: "claude",
        harness_thread_id: SESSION,
        phase: "start",
      });
      expect(end).toMatchObject({
        thread_id: threadId,
        root_id: threadId,
        harness: "claude",
        harness_thread_id: SESSION,
        phase: "end",
        status: "ok",
        ts: Math.floor(stoppedAtMs / 1000),
      });
      expect(stoppedAtMs - repliedAtMs).toBeGreaterThanOrEqual(CLOSING_MS);
      expect(end!["ts"] as number).toBeGreaterThanOrEqual(start!["ts"] as number);
    });

    it("files Claude Code's delegation under the served thread, with the model's tool-call ID", async () => {
      const edges = ofKind("edge");
      expect(edges).toHaveLength(2);
      for (const msg of edges) {
        expect(edgeSchemaErrors(parse(msg))).toEqual([]);
        const sender = await verifySender(msg, "stored");
        expect(sender?.trust === "verified" ? sender.id : undefined).toBe(parse(msg)["agent"]);
      }
      const [root, child] = edges.map(parse);
      const threadId = root!["thread_id"] as string;
      // Outside the handler, no scope; re-entered, the served thread.
      expect(inToolCall).toEqual([undefined, threadId]);
      expect(child).toMatchObject({
        agent: CAROL_ID,
        parent_id: threadId,
        root_id: threadId,
        tool_call_id: "toolu_01CCfabric",
      });
      const [toR] = wire.filter((w) => w.what === "R");
      expect(dec.decode(toR!.msg.data)).toBe(
        `{"prompt":"one fact about NATS","thread_id":"${child!["thread_id"] as string}","root_id":"${threadId}"}`,
      );
    });

    it("counts the records, the pair included, and reports them on Claude Code's status", () => {
      const after = traceRecordCounts();
      expect(after.published - countsBefore.published).toBe(4);
      expect(after.dropped - countsBefore.dropped).toBe(0);
      expect(ccStatus["records_published"]).toBe(after.published);
      expect(ccStatus["records_dropped"]).toBe(after.dropped);
    });

    it("logged the definitive address at start, and no warning", () => {
      expect(lines.filter((l) => l.level === "warn")).toEqual([]);
      expect(lines.map((l) => l.message)).toContain(
        `${EXTENSION_NAME}: tracing ${CC_ADDRESS}, edge and served records on TRACE.edges`,
      );
    });
  },
);
