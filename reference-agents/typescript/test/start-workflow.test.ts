// Durable work delegated (5): a workflow started by the model's
// `start_workflow` call joins the tool call that started it, and starting the
// worker creates nothing.
//
//   server  — a nats-server with JetStream and one account shaped like a
//             tenant's: file storage only, `max_bytes` required, room for
//             the seven streams of the durable-execution library
//   tenant  — a user of that account. It creates the seven first, from the
//             configurations the fabric's onboarding applies
//             (`test-fixtures/durable/`, at R1), watches the account's
//             JetStream API advisories, and reads the run's journal back
//   agent   — `startAgent()` with `durable: true`, pointed at the fake
//   fake    — the model behind a fake proxy: a prompt "durable: <task>"
//             asks for `start_workflow` of `durable-task` under a tool-call id with a dot
//             and a space in it; the step's call answers "step answer: …";
//             a tool result is answered "done: …"
//
// Asserted: the run id is `<served thread>-<tool call id sanitised>`; the
// journal's start entry carries that id's workflow and the served trace in
// its input; the step's model call reached the proxy with the two headers
// equal to that trace; the worker's start, and the run, sent no
// STREAM.CREATE and no STREAM.UPDATE, and the account still holds the seven
// and the worker's two consumers alone.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { fabricTracing } from "@synadia-ai/agent-fabric";
import { Agents, signerFromSeed } from "@synadia-ai/agents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startAgent, type RunningAgent } from "../src/agent.js";
import { loadConfig, type AgentConfig } from "../src/config.js";
import { DURABLE_STEP_INSTRUCTION, START_WORKFLOW } from "../src/durable.js";
import type { ChatMessage } from "../src/model.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

const binary = await natsServerOnPath();

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "test-fixtures", "durable");
const SEVEN = ["DE_JOURNAL", "DE_WORK", "DE_TIMERS", "KV_DE_RUNS", "KV_DE_LEASES", "KV_DE_PARKED", "OBJ_DE_BLOBS"];
// A dot and a space, which a run id may not hold.
const TOOL_CALL_ID = "call.durable 1";
const SANITISED = "call_durable_1";

interface ModelRequest {
  readonly headers: IncomingMessage["headers"];
  readonly body: { readonly messages: ChatMessage[]; readonly tools?: { function: { name: string } }[] };
}

describe("AGENT_DURABLE", () => {
  const base = { MODEL_PROXY_URL: "http://p", MODEL_VIRTUAL_KEY: "k", MODEL_NAME: "m", NATS_CREDS: "/c" };
  it("is off by default, on with 1, and refuses anything else", () => {
    expect(loadConfig(base).durable).toBe(false);
    expect(loadConfig({ ...base, AGENT_DURABLE: "1" }).durable).toBe(true);
    expect(() => loadConfig({ ...base, AGENT_DURABLE: "yes" })).toThrow(/AGENT_DURABLE/);
  });
});

describe.skipIf(binary === undefined)("start_workflow: a durable run joined to the tool call that started it", () => {
  let server: TestNatsServer;
  let fake: Server;
  let dir: string;
  let ncTenant: NatsConnection;
  let ncCaller: NatsConnection;
  let caller: Agents;
  let agent: RunningAgent;
  const requests: ModelRequest[] = [];
  const advisories: string[] = [];
  let startAdvisories: string[] = [];
  const callerUser = newUser();
  const tracing = fabricTracing();

  /** A JetStream API request as the tenant, its JSON reply; throws on an API error. */
  async function api<T>(subject: string, body: unknown = {}): Promise<T> {
    const msg = await ncTenant.request(subject, JSON.stringify(body), { timeout: 5_000 });
    const reply = msg.json<T & { error?: { description: string } }>();
    if (reply.error !== undefined) throw new Error(`${subject}: ${reply.error.description}`);
    return reply;
  }

  const kinds = (subjects: readonly string[]): string[] =>
    subjects.map((s) => s.replace(/^\$JS\.API\./, "").split(".").slice(0, 2).join("."));

  beforeAll(async () => {
    const [agentUser, tenantUser] = [newUser(), newUser()];
    server = await TestNatsServer.start(binary!, [callerUser, agentUser, tenantUser], { maxStreams: 7 });
    dir = await mkdtemp(join(tmpdir(), "fabric-examples-durable-"));
    const agentCreds = join(dir, "agent.nk");
    await writeFile(agentCreds, `${agentUser.seed}\n`);
    const enc = new TextEncoder();
    const open = (seed: string, name: string): Promise<NatsConnection> =>
      connect({ servers: server.url, authenticator: nkeyAuthenticator(enc.encode(seed)), name });
    [ncTenant, ncCaller] = await Promise.all([open(tenantUser.seed, "tenant"), open(callerUser.seed, "caller")]);

    // The seven, as the fabric's onboarding creates them, at R1 on one node.
    for (const name of SEVEN) {
      const config = JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as Record<string, unknown>;
      await api(`$JS.API.STREAM.CREATE.${name}`, { ...config, num_replicas: 1 });
    }

    // Every JetStream API request the account audits from here on.
    const sub = ncTenant.subscribe("$JS.EVENT.ADVISORY.API");
    void (async () => {
      for await (const m of sub) {
        const a = m.json<{ subject: string; client?: { name?: string } }>();
        if (a.client?.name !== "tenant") advisories.push(a.subject);
      }
    })();
    await ncTenant.flush();

    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as ModelRequest["body"];
        requests.push({ headers: req.headers, body });
        const last = body.messages[body.messages.length - 1]!;
        let message: ChatMessage;
        if (body.messages[0]?.content === DURABLE_STEP_INSTRUCTION) {
          message = { role: "assistant", content: `step answer: ${last.content}` };
        } else if (last.role === "tool") {
          message = { role: "assistant", content: `done: ${last.content}` };
        } else if ((last.content ?? "").startsWith("durable: ") && body.tools?.some((t) => t.function.name === START_WORKFLOW)) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: TOOL_CALL_ID,
                type: "function",
                function: {
                  name: START_WORKFLOW,
                  arguments: JSON.stringify({ name: "durable-task", input: { task: last.content!.slice(9) } }),
                },
              },
            ],
          };
        } else {
          message = { role: "assistant", content: `plain answer to: ${last.content}` };
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ index: 0, message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const addr = fake.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");

    const cfg: AgentConfig = {
      nats: { url: server.url, nkey: agentCreds },
      agent: {
        kind: "assistant",
        owner: "test",
        name: "durable",
        description: "the agent under test",
        systemPrompt: "You are under test.",
        minSenderTrust: "any",
        tools: "blocking",
        heartbeatIntervalS: undefined,
        maxHistoryExchanges: 0,
        readyFile: undefined,
      },
      model: { proxyUrl: `http://127.0.0.1:${addr.port}`, virtualKey: "vk-test", model: "fake-1", timeoutMs: undefined },
      tools: { replyTimeoutMs: 20_000 },
      durable: true,
    };
    agent = await startAgent(cfg, () => {}, { scratchpad: undefined, env: {} });
    // The advisories are asynchronous.
    await new Promise((r) => setTimeout(r, 1_000));
    startAdvisories = [...advisories];

    caller = new Agents({
      nc: ncCaller,
      identity: { signer: signerFromSeed(callerUser.seed) },
      interceptors: [tracing.promptInterceptor],
    });
  }, 30_000);

  afterAll(async () => {
    await caller?.close();
    await agent?.stop();
    await Promise.all([ncCaller?.close(), ncTenant?.close()]);
    await new Promise<void>((r) => fake?.close(() => r()));
    await server?.stop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("names the served thread and the tool call, carries the trace, and creates nothing", async () => {
    const [found] = await caller.discover({ filter: { agent: "assistant" }, timeoutMs: 1_000 });
    expect(found).toBeDefined();
    let reply = "";
    for await (const msg of await found!.prompt("durable: count to three")) {
      if (msg.type === "response") reply += msg.text;
    }

    // The served prompt's first model call names its thread.
    const served = requests[0]!;
    expect(served.body.tools?.map((t) => t.function.name)).toContain(START_WORKFLOW);
    const thread = served.headers["x-synadia-thread-id"] as string;
    const root = served.headers["x-synadia-root-id"] as string;
    expect(thread).toMatch(/^[0-9a-f]{32}$/);
    const runId = `${thread}-${SANITISED}`;

    // The tool's result came back to the model, and the reply carries it.
    const result = JSON.parse(reply.replace(/^done: /, "")) as Record<string, unknown>;
    expect(result).toEqual({
      run_id: runId,
      result: { task: "count to three", answer: "step answer: count to three" },
    });

    // The journal's start entry, read back as the tenant.
    const got = await api<{ message: { subject: string; data: string } }>("$JS.API.STREAM.MSG.GET.DE_JOURNAL", {
      seq: 1,
      next_by_subj: `de.journal.${runId}`,
    });
    expect(got.message.subject).toBe(`de.journal.${runId}`);
    const start = JSON.parse(Buffer.from(got.message.data, "base64").toString()) as {
      kind: string;
      wf: string;
      input: { input: unknown; trace: unknown };
    };
    expect(start.kind).toBe("start");
    expect(start.wf).toBe("durable-task");
    expect(start.input).toEqual({ input: { task: "count to three" }, trace: { thread_id: thread, root_id: root } });

    // The step's model call, made on the worker, carried the same trace.
    const step = requests.find((r) => r.body.messages[0]?.content === DURABLE_STEP_INSTRUCTION);
    expect(step).toBeDefined();
    expect(step!.headers["x-synadia-thread-id"]).toBe(thread);
    expect(step!.headers["x-synadia-root-id"]).toBe(root);

    // Nothing created, nothing changed: not at the worker's start, not by the run.
    await new Promise((r) => setTimeout(r, 500));
    const touched = kinds(advisories).filter((k) => k === "STREAM.CREATE" || k === "STREAM.UPDATE");
    expect(startAdvisories.length).toBeGreaterThan(0);
    expect(touched).toEqual([]);
    const names = await api<{ streams: string[] }>("$JS.API.STREAM.NAMES");
    expect([...names.streams].sort()).toEqual([...SEVEN].sort());
    const work = await api<{ consumers: string[] }>("$JS.API.CONSUMER.NAMES.DE_WORK");
    const timers = await api<{ consumers: string[] }>("$JS.API.CONSUMER.NAMES.DE_TIMERS");
    expect(work.consumers).toEqual(["de-worker-durable-task"]);
    expect(timers.consumers).toEqual(["de-timer-durable-task"]);

    // The evidence, for whoever reads the run's output.
    console.log(
      JSON.stringify({
        run_id: runId,
        start_input: start.input,
        step_headers: { thread: step!.headers["x-synadia-thread-id"], root: step!.headers["x-synadia-root-id"] },
        worker_start_advisories: startAdvisories.length,
        worker_start_kinds: count(kinds(startAdvisories)),
        stream_creates_or_updates: touched.length,
      }),
    );
  }, 30_000);
});

function count(kinds: readonly string[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const k of kinds) c[k] = (c[k] ?? 0) + 1;
  return c;
}
