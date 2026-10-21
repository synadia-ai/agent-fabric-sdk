// The `agent-fabric` command against a server where it has exactly a
// caller's permissions (erin.creds), in operator mode, run in process: the
// agents listed, a reply streamed with its root and reference on stderr,
// `--json`, a question answered from stdin, and the exit codes.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import { CANNOT_ANSWER, fabricTracing } from "../../src/index.js";
import { EXIT_FAILED, EXIT_OK, runCommand } from "../../src/command.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import { capture, enc, parse, sleep } from "../support/fixtures.js";
import { recordingIO } from "../support/command-io.js";

const bin = await findNatsServerBinary();
const ERIN = identityFixture("operator/erin.creds");
const ALICE = identityFixture("operator/alice.creds");
const REF = "sp-r1:rwxmJU9MR2qrq6urq6urq6urq6urq6urAAAAAAAAAAkQb4WlVJM_S1l6lm-1";
const ROOT_LINE = /^root ([0-9a-f]{32})$/m;

describe.skipIf(!bin)("the agent-fabric command with a caller's permissions", () => {
  const server = new NatsServerProcess();
  let alice: NatsConnection;
  let svc: AgentService;
  const answers: string[] = [];
  let env: Record<string, string>;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    env = { NATS_CREDS: ERIN, NATS_URL: server.url };
    alice = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(enc.encode(await readFile(ALICE, "utf8"))),
      reconnect: false,
    });
    svc = new AgentService({
      nc: alice,
      agent: "writer",
      owner: "fabric",
      name: "writer-1",
      description: "writes",
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [fabricTracing().requestInterceptor],
    });
    svc.onPrompt(async (envelope, response) => {
      if (envelope.prompt.startsWith("ask:")) {
        const answer = await response.ask("which colour?", { timeoutMs: 3_000 });
        answers.push(answer.prompt);
        await response.send(`got ${answer.prompt}`);
      } else {
        await response.send(`echo: ${envelope.prompt}. `);
        await response.send(`kept at ${REF}`);
      }
    });
    await svc.start();
  });

  afterAll(async () => {
    await svc?.stop();
    await alice?.close();
    await server.stop();
  });

  it("lists the agents", async () => {
    const io = recordingIO(env);
    expect(await runCommand(["agents"], io)).toBe(EXIT_OK);
    // The host registers no identity of its own.
    expect(io.stdout()).toBe(`${svc.subject.prompt}\twriter\tno identity\n`);
    expect(io.stderr()).toBe(`url ${server.url}\n`);
  });

  it("lists the agents as JSON", async () => {
    const io = recordingIO(env);
    expect(await runCommand(["agents", "--json"], io)).toBe(EXIT_OK);
    expect(JSON.parse(io.stdout())).toEqual([
      {
        address: svc.subject.prompt,
        kind: "writer",
        identity: null,
        verified: false,
        description: "writes",
      },
    ]);
  });

  it("streams the reply, the root and the reference on stderr; the root is the edge's", async () => {
    const edges = capture(alice, "TRACE.edges");
    await alice.flush();
    const io = recordingIO(env);
    expect(await runCommand(["prompt", "writer", "hello", "there"], io)).toBe(EXIT_OK);
    await sleep(200);
    edges.stop();
    expect(io.stdout()).toBe(`echo: hello there. kept at ${REF}\n`);
    const root = ROOT_LINE.exec(io.stderr())?.[1];
    expect(root).toBeDefined();
    expect(io.stderr()).toContain(`→ ${svc.subject.prompt} (`);
    expect(io.stderr()).toContain(`reference: ${REF}\n`);
    expect(parse(edges.msgs[0]!)).toMatchObject({
      parent_id: null,
      root_id: root,
      thread_id: root,
    });
  });

  it("prints one JSON object with --json", async () => {
    const io = recordingIO(env);
    expect(await runCommand(["prompt", "writer", "hi", "--json"], io)).toBe(EXIT_OK);
    const out = JSON.parse(io.stdout()) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["root", "text", "references"]);
    expect(out).toEqual({
      root: ROOT_LINE.exec(io.stderr())?.[1],
      text: `echo: hi. kept at ${REF}`,
      references: [REF],
    });
  });

  it("answers a question from stdin", async () => {
    const io = recordingIO(env, ["green"]);
    expect(await runCommand(["prompt", "writer", "ask: colour"], io)).toBe(EXIT_OK);
    expect(io.stderr()).toContain("? which colour?\n");
    expect(io.stdout()).toBe("got green\n");
    expect(answers.at(-1)).toBe("green");
  });

  it("tells the agent it cannot answer when stdin has nothing", async () => {
    const io = recordingIO(env);
    expect(await runCommand(["prompt", "writer", "ask: colour"], io)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(`got ${CANNOT_ANSWER}\n`);
  });

  it("exits 1 for no such agent, naming what is there", async () => {
    const io = recordingIO(env);
    expect(await runCommand(["prompt", "nobody", "hi"], io)).toBe(EXIT_FAILED);
    expect(io.stderr()).toContain(`agent-fabric: no agent "nobody"; there: ${svc.subject.prompt}`);
  });

  it("exits 1 for a refused prompt", async () => {
    const io = recordingIO({
      ...env,
      NATS_CREDS: identityFixture("operator/erin-no-user-info.creds"),
    });
    expect(await runCommand(["prompt", "writer", "hi"], io)).toBe(EXIT_FAILED);
    expect(io.stderr()).toContain("agent-fabric: no reply:");
  });

  it("exits 1 when it cannot connect, naming the URL", async () => {
    const io = recordingIO({ ...env, NATS_URL: "nats://127.0.0.1:1" });
    expect(await runCommand(["agents"], io)).toBe(EXIT_FAILED);
    expect(io.stderr()).toContain("url nats://127.0.0.1:1\n");
    expect(io.stderr()).toContain("could not connect to nats://127.0.0.1:1");
  });
});
