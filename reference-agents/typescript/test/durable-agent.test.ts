// The durable agent survives a crash: the model loop is the workflow, so the
// run is taken up again after the process is killed and completes without
// repeating a model turn it had journaled.
//
//   server  — a nats-server with JetStream and one account
//   engine  — `durable-engine serve` on that account (`harness/engine.ts`),
//             with a 3 s ack wait: the item the killed process held goes
//             back to a worker 3 s after its last extend
//   agent   — `src/durable-main.ts` as a child process, twice: the first is
//             killed, the second takes the run up
//   fake    — the model behind a fake proxy. The first turn asks for
//             `discover_agents`; the second, with the tool's result in front
//             of it, is held until a marker file exists, then answers
//   caller  — an SDK client with tracing on, prompting the agent once
//
// Asserted: the run `<served thread>-prompt` completes after the restart;
// its journal has one `step-end` per step; the fake saw the first model turn
// exactly once across both processes; every model call of both processes
// carried the same two trace headers, the served thread's; the journal's
// result holds the answer. And the limit, stated: the prompt that was being
// served when the first process died ended without the reply.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { fabricTracing } from "@synadia-ai/agent-fabric";
import { Agents, signerFromSeed } from "@synadia-ai/agents";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/model.js";
import { engineUnavailable, TestEngine } from "./harness/engine.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

const binary = await natsServerOnPath();

const HERE = import.meta.dirname;
const AGENT_DIR = join(HERE, "..");
const ANSWER = "the fabric has agents, and this one survived a crash";

interface Seen {
  readonly headers: IncomingMessage["headers"];
  readonly messages: ChatMessage[];
}

interface Entry {
  readonly kind: string;
  readonly seq?: number;
  readonly name?: string;
  readonly value?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(binary === undefined || engineUnavailable !== undefined)("the durable agent across a crash", () => {
  let server: TestNatsServer;
  let engine: TestEngine;
  let fake: Server;
  let dir: string;
  let ncTenant: NatsConnection;
  let ncCaller: NatsConnection;
  let caller: Agents;
  const seen: Seen[] = [];
  const children: ChildProcess[] = [];
  const callerUser = newUser();
  const agentUser = newUser();
  const tenantUser = newUser();
  let marker: string;
  let env: Record<string, string>;
  let logs = "";

  /** Every journal entry of a run, in order, read as the tenant. */
  async function journal(runId: string): Promise<Entry[]> {
    const entries: Entry[] = [];
    for (let seq = 1; ; ) {
      const msg = await ncTenant.request(
        "$JS.API.STREAM.MSG.GET.DE_JOURNAL",
        JSON.stringify({ seq, next_by_subj: `de.journal.${runId}` }),
        { timeout: 5_000 },
      );
      const got = msg.json<{ message?: { seq: number; data: string }; error?: { code: number } }>();
      if (got.message === undefined) return entries;
      entries.push(JSON.parse(Buffer.from(got.message.data, "base64").toString()) as Entry);
      seq = got.message.seq + 1;
    }
  }

  async function startAgent(n: number): Promise<ChildProcess> {
    const ready = join(dir, `ready-${n}.json`);
    const child = spawn(process.execPath, ["--import", "tsx", "src/durable-main.ts"], {
      cwd: AGENT_DIR,
      env: { ...process.env, ...env, AGENT_READY_FILE: ready },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.on("data", (b: Buffer) => (logs += `[${n}] ${b.toString()}`));
    child.stderr?.on("data", (b: Buffer) => (logs += `[${n}!] ${b.toString()}`));
    for (let i = 0; !existsSync(ready); i += 1) {
      if (child.exitCode !== null || i > 300) throw new Error(`agent ${n} did not start:\n${logs}`);
      await sleep(100);
    }
    return child;
  }

  beforeAll(async () => {
    server = await TestNatsServer.start(binary!, [callerUser, agentUser, tenantUser], { maxStreams: 8 });
    dir = await mkdtemp(join(tmpdir(), "fabric-examples-durable-agent-"));
    marker = join(dir, "release-the-second-turn");
    const agentSeed = join(dir, "agent.nk");
    await writeFile(agentSeed, `${agentUser.seed}\n`);
    const enc = new TextEncoder();
    const open = (seed: string, name: string): Promise<NatsConnection> =>
      connect({ servers: server.url, authenticator: nkeyAuthenticator(enc.encode(seed)), name });
    [ncTenant, ncCaller] = await Promise.all([open(tenantUser.seed, "tenant"), open(callerUser.seed, "caller")]);
    engine = await TestEngine.start(server.engineUrl, { ackWaitMs: 3_000 });

    // The fake model. The second turn waits for the marker; a process killed
    // while it waits never reads the answer.
    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        void (async () => {
          const body = JSON.parse(raw) as { messages: ChatMessage[] };
          seen.push({ headers: req.headers, messages: body.messages });
          let message: ChatMessage;
          if (!body.messages.some((m) => m.role === "tool")) {
            message = {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "call_discover_1", type: "function", function: { name: "discover_agents", arguments: "{}" } }],
            };
          } else {
            while (!existsSync(marker)) await sleep(50);
            message = { role: "assistant", content: ANSWER };
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ choices: [{ index: 0, message }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
        })();
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const addr = fake.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");

    env = {
      NATS_URL: server.url,
      NATS_NKEY_SEED_FILE: agentSeed,
      MODEL_PROXY_URL: `http://127.0.0.1:${addr.port}`,
      MODEL_VIRTUAL_KEY: "vk-test",
      MODEL_NAME: "fake-1",
      AGENT_KIND: "assistant",
      AGENT_OWNER: "test",
      AGENT_NAME: "durable",
      AGENT_REPLY_TIMEOUT_MS: "120000",
      SCRATCHPAD_VOLUME: "",
    };
    caller = new Agents({
      nc: ncCaller,
      identity: { signer: signerFromSeed(callerUser.seed) },
      interceptors: [fabricTracing().promptInterceptor],
    });
  }, 30_000);

  afterAll(async () => {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await caller?.close();
    await Promise.all([ncCaller?.close(), ncTenant?.close()]);
    await new Promise<void>((r) => fake?.close(() => r()));
    await engine?.stop();
    await server?.stop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("completes the run after a kill, without repeating a journaled model turn", async () => {
    const first = await startAgent(1);
    const [found] = await caller.discover({ filter: { agent: "assistant" }, timeoutMs: 2_000 });
    expect(found).toBeDefined();

    // The prompt, read in the background: the agent serving it will die.
    const chunks: string[] = [];
    const ended = (async (): Promise<string> => {
      try {
        for await (const msg of await found!.prompt("what is on the fabric?", { inactivityTimeoutMs: 10_000 })) {
          if (msg.type === "response") chunks.push(msg.text);
        }
        return "completed";
      } catch (err) {
        return err instanceof Error ? err.name : String(err);
      }
    })();

    // The served thread, from the first model call; the run is named after it.
    for (let i = 0; seen.length === 0; i += 1) {
      if (i > 100) throw new Error(`no model call:\n${logs}`);
      await sleep(100);
    }
    const thread = seen[0]!.headers["x-synadia-thread-id"] as string;
    const root = seen[0]!.headers["x-synadia-root-id"] as string;
    expect(thread).toMatch(/^[0-9a-f]{32}$/);
    const runId = `${thread}-prompt`;

    // Killed once its first step has ended.
    let before: Entry[] = [];
    for (let i = 0; !before.some((e) => e.kind === "step-end"); i += 1) {
      if (i > 100) throw new Error(`no step-end:\n${logs}`);
      await sleep(100);
      before = await journal(runId);
    }
    first.kill("SIGKILL");
    await new Promise((r) => first.once("exit", r));
    before = await journal(runId);
    const callsBefore = seen.length;

    // The stream of the prompt that was being served ends without the reply.
    const outcome = await ended;
    expect(chunks.join("")).not.toContain(ANSWER);

    // The second turn may go out now; a second process takes the run up.
    await writeFile(marker, "");
    await startAgent(2);
    let after: Entry[] = [];
    for (let i = 0; !after.some((e) => e.kind === "result"); i += 1) {
      if (i > 900) throw new Error(`the run did not complete:\n${logs}`);
      await sleep(100);
      after = await journal(runId);
    }

    const result = after.find((e) => e.kind === "result")!;
    expect(result.value).toEqual({ answer: ANSWER, modelTurns: 2 });
    // One step-end per step.
    const ends = after.filter((e) => e.kind === "step-end");
    expect(new Set(ends.map((e) => e.seq)).size).toBe(ends.length);
    expect(ends.map((e) => e.name)).toEqual(["llm-0", "tool-0-0", "llm-1"]);
    // The first model turn, journaled before the kill, was made once.
    const firstTurns = seen.filter((s) => !s.messages.some((m) => m.role === "tool"));
    expect(firstTurns).toHaveLength(1);
    // Every model call of both processes on the served thread.
    for (const s of seen) {
      expect(s.headers["x-synadia-thread-id"]).toBe(thread);
      expect(s.headers["x-synadia-root-id"]).toBe(root);
    }

    console.log(
      JSON.stringify({
        run_id: runId,
        journal_before_kill: before.map((e) => `${e.kind}${e.name !== undefined ? ` ${e.name}` : ""}`),
        journal_after: after.map((e) => `${e.kind}${e.name !== undefined ? ` ${e.name}` : ""}`),
        model_calls: { before_kill: callsBefore, total: seen.length, first_turn: firstTurns.length },
        headers: { thread, root },
        first_prompt: { outcome, reply_chunks: chunks.length },
        result: result.value,
      }),
    );
  }, 180_000);
});
