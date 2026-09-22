// Grant requests across languages: a TypeScript requester against a Python
// creator. The caller (bob) runs `AgentTools` with the extension; the
// creator is `test-fixtures/interop/py-scratchpad-agent.py` (alice), run by
// `uv` inside this repo's `python` project; the target (carol) reads
// references. The caller takes a reference from the Python creator's reply,
// passes it to the target, and the Python creator verifies the TypeScript
// signature, reads the TypeScript bytes, and grants. Its refusals come back
// in the bytes this package writes. The Python suite runs the mirror image.

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, AgentTools, newAgentId, signerFromCredsFile } from "@synadia-ai/agents";
import {
  bindActiveTrace,
  encodeGrantReply,
  encodeGrantRequest,
  fabricTracing,
  grantSubject,
  randomThreadId,
  scratchPadExtension,
  type TraceScope,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import { dec, enc, REPO_ROOT, sleep } from "../support/fixtures.js";
import { makeReference, MemoryScratchPad } from "../support/scratchpad.js";

const HOST_SCRIPT = join(REPO_ROOT, "test-fixtures", "interop", "py-scratchpad-agent.py");
const PY_PROJECT = join(REPO_ROOT, "python");
const READY_MARKER = "agent service listening on ";

const bin = await findNatsServerBinary();
const uvAvailable = spawnSync("uv", ["--version"]).status === 0;

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}
const keys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const idOf = (user: string): string =>
  newAgentId(keys.accounts[keys.users[user]!.account]!.public, keys.users[user]!.public);
const BOB = idOf("bob");
const CAROL = idOf("carol");

type Event = Record<string, unknown>;

interface PyAgent {
  readonly subject: string;
  readonly events: Event[];
  stop(): Promise<void>;
}

async function startPyAgent(url: string, creds: string, agent: string): Promise<PyAgent> {
  const child = spawn("uv", ["run", "--project", PY_PROJECT, "python", "-u", HOST_SCRIPT], {
    env: { ...process.env, NATS_URL: url, NATS_CREDS_FILE: creds, AGENT: agent },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events: Event[] = [];
  let out = "";
  let pending = "";
  const subject = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`python agent not ready in 60s:\n${out}`)),
      60_000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith("{")) events.push(JSON.parse(line) as Event);
        if (line.includes(READY_MARKER)) {
          clearTimeout(timer);
          resolve(line.split(READY_MARKER)[1]!.trim());
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`python agent exited before ready (code=${code}):\n${out}`));
    });
  });
  return {
    subject,
    events,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
}

describe.skipIf(!bin || !uvAvailable)("a TypeScript requester and a Python creator", () => {
  const server = new NatsServerProcess();
  const connections: NatsConnection[] = [];
  let py: PyAgent;
  let target: AgentService;
  let client: Agents;
  let tools: AgentTools;
  const seenByTarget: string[] = [];
  const scope: TraceScope = {
    threadId: randomThreadId(),
    rootId: randomThreadId(),
    turnCountHint: 0,
  };
  const creator = (): string => py.subject;

  async function as(user: string): Promise<NatsConnection> {
    const nc = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(
        enc.encode(await readFile(identityFixture(`operator/${user}.creds`), "utf8")),
      ),
      reconnect: false,
    });
    connections.push(nc);
    return nc;
  }

  const call = (address: string, prompt: string, toolCallId: string) =>
    bindActiveTrace(scope, () =>
      tools.execute("prompt_agent", { address, prompt }, { toolCallId }),
    );

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    py = await startPyAgent(server.url, identityFixture("operator/alice.creds"), "py-creator");

    const ncCarol = await as("carol");
    target = new AgentService({
      nc: ncCarol,
      agent: "ts-target",
      owner: "interop",
      name: "t1",
      identity: { signer: await signerFromCredsFile(identityFixture("operator/carol.creds")) },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      extraMetadata: { scratchpad_refs_ok: "true" },
    });
    target.onPrompt(async (envelope, response) => {
      seenByTarget.push(envelope.prompt);
      await response.send("read");
    });
    await target.start();

    const ncBob = await as("bob");
    client = new Agents({
      nc: ncBob,
      identity: { signer: await signerFromCredsFile(identityFixture("operator/bob.creds")) },
      interceptors: [fabricTracing().promptInterceptor],
    });
    const ext = scratchPadExtension({
      scratchPad: new MemoryScratchPad("vol-bob"),
      agents: client,
    });
    tools = new AgentTools({ agents: client, extensions: [ext] });
  });

  afterAll(async () => {
    await tools?.close();
    await client?.close();
    await target?.stop();
    await py?.stop();
    for (const nc of connections) await nc.close();
    await server.stop();
  });

  let reference = "";

  it("takes a reference from the Python creator's reply, granted first-hand", async () => {
    const result = await call(creator(), "commit", "toolu_commit");
    expect(result).toMatchObject({ state: "completed" });
    reference = /sp-ref:[A-Za-z0-9_-]+/.exec(result["reply"] as string)![0];
    expect(py.events.filter((e) => e["event"] === "grant")).toEqual([
      {
        event: "grant",
        reference,
        grantee: BOB,
        thread_id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
        root_id: scope.rootId,
        tool_call_id: null,
        kind: "first-hand",
      },
    ]);
  });

  it("passes it on: the Python creator reads the TypeScript request and grants on request", async () => {
    const result = await call(
      `agents.prompt.ts-target.interop.t1`,
      `use ${reference}`,
      "toolu_pass",
    );
    expect(result).toMatchObject({ state: "completed", reply: "read" });
    expect(seenByTarget).toEqual([`use ${reference}`]);
    const requested = py.events.filter((e) => e["event"] === "request");
    expect(requested.map((e) => e["data"])).toEqual([
      encodeGrantRequest({
        reference,
        grantee: CAROL,
        trace: { thread_id: scope.threadId, root_id: scope.rootId, tool_call_id: "toolu_pass" },
      }),
    ]);
    expect(py.events.filter((e) => e["event"] === "grant").at(-1)).toEqual({
      event: "grant",
      reference,
      grantee: CAROL,
      thread_id: scope.threadId,
      root_id: scope.rootId,
      tool_call_id: "toolu_pass",
      kind: "on-request",
    });
  });

  it("answers its refusals in the bytes this package writes", async () => {
    const never = makeReference("vol-py-creator", "/99.md", creator());
    const signed = await client.requestSigned(
      grantSubject(creator()),
      encodeGrantRequest({ reference: never, grantee: CAROL }),
      { timeoutMs: 5000 },
    );
    expect(dec.decode(signed.data)).toBe(
      encodeGrantReply({
        granted: false,
        reason: "this agent holds no live read grant it made to the requester on that reference",
      }),
    );
    const unsigned = await connections[1]!.request(
      grantSubject(creator()),
      encodeGrantRequest({ reference: never, grantee: CAROL }),
      { timeout: 5000 },
    );
    expect(dec.decode(unsigned.data)).toBe(
      encodeGrantReply({ granted: false, reason: "signature required" }),
    );
    // No headers on a reply: the request's `Agent-Sender` is not echoed back.
    expect(signed.headers).toBeUndefined();
    expect(unsigned.headers).toBeUndefined();
    await sleep(50);
  });
});
