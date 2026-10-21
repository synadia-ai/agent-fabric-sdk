// Tracing interoperates across languages and with peers that have none.
//
// A traced TypeScript caller is adopted by a Python host that runs the
// fabric, and served by one that runs the protocol SDK alone (which passes
// the two envelope fields through unread, §5.6). An untraced caller is
// served by a traced Python host, which mints a root of its own, and sees
// nothing of tracing on the wire. In operator mode the caller's edge
// record names the thread the Python host adopted, verifies, and
// validates against edge.json.
//
// The Python host is `test-fixtures/interop/py-agent-service-host.py` (from
// the protocol SDK's interop host at synadia-agents c9d7bcb), run by `uv`
// inside this repo's `python` project. The cross-version case needs the
// last published, pre-tracing `synadia-ai-agent-service` in a venv of its
// own:
//
//   uv venv old-py && uv pip install --python old-py/bin/python \
//     synadia-ai-agent-service==0.4.1 synadia-ai-agents==0.7.1 nkeys
//   export SYNADIA_INTEROP_PRETRACING_PY_PYTHON=$PWD/old-py/bin/python
//
// and skips when that variable is unset. The Python suite runs the mirror
// image against a TypeScript host. A caller (`fabricCaller`, with a caller's
// permissions only) prompts a Python host, which adopts the root it returned.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import {
  Agents,
  newAgentId,
  signerFromCredsFile,
  verifySender,
  type Agent,
} from "@synadia-ai/agents";
import { fabricCaller, fabricTracing, isThreadId, type TraceOptions } from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import { dec, edgeSchemaErrors, enc, parse, REPO_ROOT, sleep } from "../support/fixtures.js";

const HOST_SCRIPT = join(REPO_ROOT, "test-fixtures", "interop", "py-agent-service-host.py");
const PY_PROJECT = join(REPO_ROOT, "python");
const PRETRACING_PY_ENV = "SYNADIA_INTEROP_PRETRACING_PY_PYTHON";
const READY_MARKER = "agent service listening on ";
const ECHO = /^echo: (.*?)(?: thread=([0-9a-f]{32}) root=([0-9a-f]{32}))?$/;
const CREDS = identityFixture("operator/alice.creds");
const CALLER_CREDS = identityFixture("operator/erin.creds");

const bin = await findNatsServerBinary();
const uvAvailable = spawnSync("uv", ["--version"]).status === 0;

interface PyHost {
  readonly subject: string;
  stop(): Promise<void>;
}

async function startPyHost(opts: {
  readonly url: string;
  readonly agent: string;
  readonly traced?: boolean;
  readonly creds?: string;
  /** Interpreter to run the host with; default: this repo's `python` project via `uv`. */
  readonly python?: string;
}): Promise<PyHost> {
  const cmd = opts.python ?? "uv";
  const args = opts.python
    ? ["-u", HOST_SCRIPT]
    : ["run", "--project", PY_PROJECT, "python", "-u", HOST_SCRIPT];
  const child: ChildProcess = spawn(cmd, args, {
    env: {
      ...process.env,
      NATS_URL: opts.url,
      AGENT: opts.agent,
      TRACE: opts.traced ? "1" : "0",
      ...(opts.creds ? { NATS_CREDS_FILE: opts.creds } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  const subject = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`python host not ready in 60s:\n${out}`)),
      60_000,
    );
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const line = out.split("\n").find((l) => l.includes(READY_MARKER));
      if (line !== undefined) {
        clearTimeout(timer);
        resolve(line.split(READY_MARKER)[1]!.trim());
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`python host exited before ready (code=${code}):\n${out}`));
    });
  });
  return {
    subject,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }),
  };
}

function capture(nc: NatsConnection, subject: string): Msg[] {
  const seen: Msg[] = [];
  const sub = nc.subscribe(subject);
  void (async () => {
    for await (const m of sub) seen.push(m);
  })();
  return seen;
}

async function echo(
  agents: Agents,
  subject: string,
  text: string,
): Promise<{ prompt: string; thread?: string; root?: string }> {
  const found = await agents.discover({ timeoutMs: 3000 });
  const handle = found.find((a: Agent) => a.promptEndpoint.subject === subject);
  expect(handle, `host ${subject} not discovered`).toBeDefined();
  const texts: string[] = [];
  for await (const m of await handle!.prompt(text)) {
    if (m.type === "response") texts.push(m.text);
  }
  expect(texts).toHaveLength(1);
  const m = ECHO.exec(texts[0]!);
  expect(m, texts[0]).not.toBeNull();
  return { prompt: m![1]!, ...(m![2] ? { thread: m![2], root: m![3] } : {}) };
}

function traced(
  nc: NatsConnection,
  options: TraceOptions,
  signer?: Awaited<ReturnType<typeof signerFromCredsFile>>,
): Agents {
  return new Agents({
    nc,
    ...(signer ? { identity: { signer } } : {}),
    interceptors: [fabricTracing(options).promptInterceptor],
  });
}

describe.skipIf(!bin || !uvAvailable)("tracing interop with Python hosts (no auth)", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  beforeAll(async () => {
    await server.start();
    nc = await connect({ servers: server.url, reconnect: false });
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  it("a traced caller is adopted by a traced Python host", async () => {
    const host = await startPyHost({ url: server.url, agent: "py-traced", traced: true });
    try {
      const prompts = capture(nc, host.subject);
      await nc.flush();
      const agents = traced(nc, { edgeSubject: null });
      const seen = await echo(agents, host.subject, "hi");
      await agents.close();
      expect(seen.prompt).toBe("hi");
      const sent = JSON.parse(dec.decode(prompts[0]!.data)) as Record<string, string>;
      expect(isThreadId(sent["thread_id"]!)).toBe(true);
      expect(sent["root_id"]).toBe(sent["thread_id"]);
      // Adopted, not dropped or re-minted.
      expect(seen.thread).toBe(sent["thread_id"]);
      expect(seen.root).toBe(sent["root_id"]);
    } finally {
      await host.stop();
    }
  });

  it("an untraced caller is served by a traced Python host, which mints a root", async () => {
    const host = await startPyHost({ url: server.url, agent: "py-mint", traced: true });
    try {
      const prompts = capture(nc, host.subject);
      const traces = capture(nc, "TRACE.>");
      await nc.flush();
      const agents = new Agents({ nc }); // never traced
      const seen = await echo(agents, host.subject, "hi");
      await agents.close();
      expect(seen.prompt).toBe("hi");
      expect(dec.decode(prompts[0]!.data)).toBe('{"prompt":"hi"}');
      expect(seen.thread).toBeDefined();
      expect(seen.root).toBe(seen.thread);
      await sleep(200);
      expect(traces).toHaveLength(0);
    } finally {
      await host.stop();
    }
  });

  it("a traced caller is served by a Python host without the fabric, which ignores the fields", async () => {
    const host = await startPyHost({ url: server.url, agent: "py-plain" });
    try {
      const prompts = capture(nc, host.subject);
      await nc.flush();
      const agents = traced(nc, { edgeSubject: null });
      const seen = await echo(agents, host.subject, "hello plain host");
      await agents.close();
      expect(seen.prompt).toBe("hello plain host");
      expect(seen.thread).toBeUndefined(); // nothing adopted, nothing bound
      expect(Object.keys(JSON.parse(dec.decode(prompts[0]!.data)) as object)).toEqual([
        "prompt",
        "thread_id",
        "root_id",
      ]);
    } finally {
      await host.stop();
    }
  });
});

describe.skipIf(!bin || !uvAvailable)("tracing interop with Python hosts (operator mode)", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let aliceId: string;
  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    nc = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(enc.encode(await readFile(CREDS, "utf8"))),
      reconnect: false,
    });
    const keys = JSON.parse(await readFile(identityFixture("operator/keys.json"), "utf8")) as {
      accounts: Record<string, { public: string }>;
      users: Record<string, { public: string }>;
    };
    aliceId = newAgentId(keys.accounts["ACME"]!.public, keys.users["alice"]!.public);
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  it("a traced caller's edge names the thread the Python host adopted", async () => {
    const host = await startPyHost({
      url: server.url,
      agent: "py-traced-op",
      traced: true,
      creds: CREDS,
    });
    try {
      const edges = capture(nc, "TRACE.edges");
      await nc.flush();
      const agents = traced(nc, {}, await signerFromCredsFile(CREDS));
      const seen = await echo(agents, host.subject, "hi");
      await agents.close();
      expect(seen.prompt).toBe("hi");
      await sleep(200);
      expect(edges).toHaveLength(1);
      const record = parse(edges[0]!);
      expect(edgeSchemaErrors(record)).toEqual([]);
      expect(record["thread_id"]).toBe(seen.thread);
      expect(record["root_id"]).toBe(seen.root);
      expect(record["parent_id"]).toBeNull();
      const sender = await verifySender(edges[0]!, "stored");
      expect(sender?.trust).toBe("verified");
      // The body names the same writer the signed header attests.
      expect(sender?.trust === "verified" ? sender.id : undefined).toBe(aliceId);
      expect(record["agent"]).toBe(aliceId);
      // One id three ways: the body's record_id is the signed nonce and the Nats-Msg-Id.
      expect(sender?.header.nonce).toBe(record["record_id"]);
      expect(edges[0]!.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
    } finally {
      await host.stop();
    }
  });

  it("a caller with a caller's permissions prompts a Python host: the root it returned is adopted", async () => {
    const host = await startPyHost({
      url: server.url,
      agent: "py-for-caller",
      traced: true,
      creds: CREDS,
    });
    const caller = await fabricCaller({ creds: CALLER_CREDS, url: server.url });
    try {
      const edges = capture(nc, "TRACE.edges");
      await nc.flush();
      const reply = await caller.ask(host.subject, "from a caller");
      const m = ECHO.exec(reply.text);
      expect(m, reply.text).not.toBeNull();
      expect(m![1]).toBe("from a caller");
      expect(m![2]).toBe(reply.rootId);
      expect(m![3]).toBe(reply.rootId);
      await sleep(200);
      expect(edges).toHaveLength(1);
      const record = parse(edges[0]!);
      expect(edgeSchemaErrors(record)).toEqual([]);
      expect(record).toMatchObject({
        parent_id: null,
        thread_id: reply.rootId,
        root_id: reply.rootId,
      });
    } finally {
      await caller.close();
      await host.stop();
    }
  });

  it.skipIf(process.env[PRETRACING_PY_ENV] === undefined)(
    "a traced caller is served by the last published Python host",
    async () => {
      const host = await startPyHost({
        url: server.url,
        agent: "py-old",
        creds: CREDS,
        python: process.env[PRETRACING_PY_ENV]!,
      });
      try {
        const edges = capture(nc, "TRACE.edges");
        await nc.flush();
        const agents = traced(nc, {}, await signerFromCredsFile(CREDS));
        const seen = await echo(agents, host.subject, "hello old host");
        await agents.close();
        expect(seen.prompt).toBe("hello old host");
        expect(seen.thread).toBeUndefined(); // nothing to echo before tracing existed
        await sleep(200);
        expect(edges).toHaveLength(1);
        expect(edgeSchemaErrors(parse(edges[0]!))).toEqual([]);
      } finally {
        await host.stop();
      }
    },
  );
});
