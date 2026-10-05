// The durable agent in process: a tool call made on the worker, in the
// run's tool scope and the prompt's trace, and a question from the prompted
// agent parked on a durable signal and relayed to the caller.
//
//   server  — JetStream, one account
//   engine  — `durable-engine serve` on that account (`harness/engine.ts`)
//   agent   — `startDurableAgent()`, pointed at the fake
//   asker   — an agent that asks its caller a question before it answers
//   fake    — the model: a prompt "delegate to <address>" asks for
//             `prompt_agent`; a tool result is answered "done: …"
//   caller  — an SDK client with tracing on; it answers the question "yes"
//
// Asserted: the question reached the caller, its answer reached the asker,
// and the model saw the call's final result; the journal parked on
// `ask-0-0`, took the signal and carried the answer back in `answer-0-0`;
// the edge `prompt_agent` wrote from the worker has the served thread as its
// parent and the model's tool call as its call, and the asker's thread is
// in the same tree.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { fabricTracing } from "@synadia-ai/agent-fabric";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, signerFromSeed } from "@synadia-ai/agents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunningAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { startDurableAgent } from "../src/durable-agent.js";
import type { ChatMessage } from "../src/model.js";
import { engineUnavailable, TestEngine } from "./harness/engine.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

const binary = await natsServerOnPath();
const DELEGATE = /delegate to (\S+)/;

interface EdgeRecord {
  readonly thread_id: string;
  readonly parent_id: string | null;
  readonly root_id: string;
  readonly tool_call_id: string | null;
  readonly turn_count_hint: number;
}

describe.skipIf(binary === undefined || engineUnavailable !== undefined)("the durable agent's tools and questions", () => {
  let server: TestNatsServer;
  let engine: TestEngine;
  let fake: Server;
  let dir: string;
  let ncTenant: NatsConnection;
  let ncCaller: NatsConnection;
  let ncAsker: NatsConnection;
  let caller: Agents;
  let asker: AgentService;
  let agent: RunningAgent;
  const seen: { headers: Record<string, unknown>; messages: ChatMessage[] }[] = [];
  const edges: EdgeRecord[] = [];
  const told: string[] = [];
  const tracing = fabricTracing();

  beforeAll(async () => {
    const [callerUser, agentUser, askerUser, tenantUser] = [newUser(), newUser(), newUser(), newUser()];
    server = await TestNatsServer.start(binary!, [callerUser, agentUser, askerUser, tenantUser], { maxStreams: 7 });
    dir = await mkdtemp(join(tmpdir(), "fabric-examples-durable-q-"));
    const agentSeed = join(dir, "agent.nk");
    await writeFile(agentSeed, `${agentUser.seed}\n`);
    const enc = new TextEncoder();
    const open = (seed: string): Promise<NatsConnection> =>
      connect({ servers: server.url, authenticator: nkeyAuthenticator(enc.encode(seed)) });
    [ncTenant, ncCaller, ncAsker] = await Promise.all([open(tenantUser.seed), open(callerUser.seed), open(askerUser.seed)]);
    engine = await TestEngine.start(server.engineUrl);
    const sub = ncTenant.subscribe("TRACE.edges");
    void (async () => {
      for await (const m of sub) edges.push(m.json<EdgeRecord>());
    })();

    asker = new AgentService({
      nc: ncAsker,
      agent: "asker",
      owner: "test",
      name: "a",
      interceptors: [tracing.requestInterceptor],
      identity: { signer: signerFromSeed(askerUser.seed) },
      keepaliveIntervalS: null,
    });
    asker.onPrompt(async (_envelope, response) => {
      const answer = await response.ask("may I read the file?", { timeoutMs: 10_000 });
      told.push(answer.prompt);
      await response.send(`asked, and was told: ${answer.prompt}`);
    });
    await asker.start();

    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as { messages: ChatMessage[] };
        seen.push({ headers: req.headers, messages: body.messages });
        const last = body.messages[body.messages.length - 1]!;
        const delegate = DELEGATE.exec(last.content ?? "");
        let message: ChatMessage;
        if (last.role === "tool") {
          message = { role: "assistant", content: `done: ${last.content}` };
        } else if (delegate !== null) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_ask_1",
                type: "function",
                function: { name: "prompt_agent", arguments: JSON.stringify({ address: delegate[1], prompt: "go" }) },
              },
            ],
          };
        } else {
          message = { role: "assistant", content: `plain answer to: ${last.content}` };
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ index: 0, message }], usage: {} }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const addr = fake.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");

    const cfg: AgentConfig = {
      nats: { url: server.url, nkey: agentSeed },
      agent: {
        kind: "assistant",
        owner: "test",
        name: "durable",
        description: "the durable agent under test",
        systemPrompt: "You are under test.",
        minSenderTrust: "any",
        tools: "blocking",
        heartbeatIntervalS: undefined,
        maxHistoryExchanges: 0,
        readyFile: undefined,
      },
      model: { proxyUrl: `http://127.0.0.1:${addr.port}`, virtualKey: "vk-test", model: "fake-1", timeoutMs: undefined },
      tools: { replyTimeoutMs: 20_000 },
    };
    agent = await startDurableAgent(cfg, () => {}, { env: {} });
    caller = new Agents({
      nc: ncCaller,
      identity: { signer: signerFromSeed(callerUser.seed) },
      interceptors: [tracing.promptInterceptor],
    });
  }, 30_000);

  afterAll(async () => {
    await caller?.close();
    await agent?.stop();
    await asker?.stop();
    await Promise.all([ncCaller?.close(), ncAsker?.close(), ncTenant?.close()]);
    await new Promise<void>((r) => fake?.close(() => r()));
    await engine?.stop();
    await server?.stop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("relays a prompted agent's question to the caller and carries the answer back", async () => {
    const [found] = await caller.discover({ filter: { agent: "assistant" }, timeoutMs: 2_000 });
    expect(found).toBeDefined();
    const questions: string[] = [];
    let reply = "";
    for await (const msg of await found!.prompt(`please delegate to ${asker.subject.prompt}`)) {
      if (msg.type === "query") {
        questions.push(msg.prompt);
        await msg.reply("yes");
      } else if (msg.type === "response") {
        reply += msg.text;
      }
    }

    expect(questions).toEqual([`${asker.subject.prompt} asks: may I read the file?`]);
    expect(told).toEqual(["yes"]);
    const result = JSON.parse(reply.replace(/^done: /, "")) as Record<string, unknown>;
    expect(result).toMatchObject({ state: "completed", reply: "asked, and was told: yes" });

    // The journal: parked on the question, the signal, the answer carried back.
    const thread = seen[0]!.headers["x-synadia-thread-id"] as string;
    const runId = `${thread}-prompt`;
    const kinds: string[] = [];
    for (let seq = 1; ; ) {
      const got = (
        await ncTenant.request(
          "$JS.API.STREAM.MSG.GET.DE_JOURNAL",
          JSON.stringify({ seq, next_by_subj: `de.journal.${runId}` }),
        )
      ).json<{ message?: { seq: number; data: string } }>();
      if (got.message === undefined) break;
      const e = JSON.parse(Buffer.from(got.message.data, "base64").toString()) as { kind: string; name?: string };
      kinds.push(`${e.kind}${e.name !== undefined ? ` ${e.name}` : ""}`);
      seq = got.message.seq + 1;
    }
    expect(kinds).toEqual([
      "start",
      "step-begin llm-0",
      "step-end llm-0",
      "step-begin tool-0-0",
      "step-end tool-0-0",
      "step-begin ask-request-0-0",
      "step-end ask-request-0-0",
      "await ask-0-0",
      "signal ask-0-0",
      "step-begin answer-0-0",
      "step-end answer-0-0",
      "step-begin llm-1",
      "step-end llm-1",
      "result",
    ]);

    // The edge prompt_agent wrote on the worker: under the served thread,
    // under the model's call, after one model turn.
    await ncTenant.flush();
    const root = seen[0]!.headers["x-synadia-root-id"] as string;
    const child = edges.find((e) => e.tool_call_id === "call_ask_1");
    expect(child).toMatchObject({ parent_id: thread, root_id: root, turn_count_hint: 1 });
    for (const s of seen) expect(s.headers["x-synadia-thread-id"]).toBe(thread);
    console.log(JSON.stringify({ run_id: runId, journal: kinds, edge: child }));
  }, 60_000);
});
