// The prompt tool as a person runs it: `npm run prompt`, `src/prompt.ts` as
// a program, on a throwaway nats-server in operator mode.
//
// What it prints is another program's text: the address an agent registered,
// the words it refuses a prompt with, its reply. Two agents hold escape
// sequences in all three. The address and the refusal's words are printed as
// plain text, and a reply that goes to a pipe is written as it came. What a
// terminal is sent is the rule itself here (`terminalText`); the tool on a
// terminal is run by the Python agent's suite (`tests/test_prompt_tool.py`),
// which can open one.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { headers, type NatsConnection } from "@nats-io/nats-core";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plainLine, terminalText } from "../src/description.js";
import { natsServerOnPath, TestNatsServer } from "./harness/nats-server.js";

const binary = await natsServerOnPath();
const AGENT_DIR = join(import.meta.dirname, "..");
const IDENTITY = join(AGENT_DIR, "..", "..", "test-fixtures", "identity", "operator");

const ESC = "\u001b";
const FFFD = String.fromCodePoint(0xfffd);
const HALF = String.fromCharCode(0xd83d);
// A zero width space and a right-to-left override: invisible, and not kept.
const INVISIBLE = String.fromCodePoint(0x200b, 0x202e);
// What stays as it is: an accented letter, the zero width non-joiner and joiner, an emoji.
const KEPT = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x200c, 0x200d)} ${String.fromCodePoint(0x1f44d)}`;
// What the painter replies: it clears the screen and moves up a line.
const PAINT_REPLY = `${ESC}[2Jcleared\tthe\nscreen ${ESC}[1A`;
// The refuser's address, as it registered it, and the words it refuses with.
const REFUSER_ADDRESS = `agents.prompt.re${ESC}[2Jfuser.fabric.raw`;
const REFUSAL = `no${ESC}[2J way`;

describe("what the prompt tool prints of another agent's text", () => {
  it("plainLine: one line without a control character", () => {
    expect(plainLine(`no${ESC}[2J way\r\nat\tall ${INVISIBLE}${HALF}`)).toBe(`no [2J way  at all   ${FFFD}`);
    // The joiners stay, and so does every printable character.
    expect(plainLine(KEPT)).toBe(KEPT);
  });

  it("terminalText: the lines stay, and U+FFFD is shown for a control character", () => {
    expect(terminalText(PAINT_REPLY)).toBe(`${FFFD}[2Jcleared\tthe\nscreen ${FFFD}[1A`);
    expect(terminalText(`a\r\nb ${INVISIBLE}${HALF}`)).toBe(`a${FFFD}\nb ${FFFD}${FFFD}${FFFD}`);
    expect(terminalText(KEPT)).toBe(KEPT);
  });
});

describe.skipIf(binary === undefined)("the prompt tool, run as a program", () => {
  let server: TestNatsServer;
  let alice: NatsConnection;
  let painter: AgentService;

  beforeAll(async () => {
    server = await TestNatsServer.startWithConfig(binary!, join(IDENTITY, "operator.conf"));
    alice = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(await readFile(join(IDENTITY, "alice.creds"))),
      reconnect: false,
    });
    // The painter, on the protocol SDK's host: its reply holds escape sequences.
    painter = new AgentService({
      nc: alice,
      agent: "painter",
      owner: "test",
      name: "main",
      description: "paints",
      heartbeatIntervalS: 3600,
      keepaliveIntervalS: null,
    });
    painter.onPrompt(async (_envelope, response) => {
      await response.send(PAINT_REPLY);
    });
    await painter.start();

    // The refuser, a program that speaks NATS: it answers discovery itself,
    // with an address the host would not register, and refuses every prompt
    // with words of its own.
    const info = JSON.stringify({
      type: "io.nats.micro.v1.info_response",
      name: "agents",
      id: "raw1",
      version: "0.0.1",
      description: "",
      metadata: { agent: "refuser", owner: "test", protocol_version: "0.3" },
      endpoints: [{ name: "prompt", subject: REFUSER_ADDRESS, queue_group: "agents", metadata: {} }],
    });
    alice.subscribe("$SRV.INFO.agents", { callback: (_err, msg) => void msg.respond(info) });
    alice.subscribe(REFUSER_ADDRESS, {
      callback: (_err, msg) => {
        const refusal = headers();
        refusal.set("Nats-Service-Error-Code", "500");
        refusal.set("Nats-Service-Error", REFUSAL);
        if (msg.reply !== undefined) alice.publish(msg.reply, "", { headers: refusal });
      },
    });
    await alice.flush();
  });

  afterAll(async () => {
    await painter?.stop();
    await alice?.close();
    await server?.stop();
  });

  /** Run the tool with pipes for its outputs: its exit code, stdout and stderr. */
  function run(...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/prompt.ts", ...args], {
        cwd: AGENT_DIR,
        // The environment wins over a `.env`: nothing of the developer's own reaches the run.
        env: {
          ...process.env,
          NATS_URL: server.url,
          NATS_CREDS: join(IDENTITY, "erin.creds"),
          PROMPT_TIMEOUT_MS: "10000",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }),
      );
    });
  }

  /** stderr's lines, without the two that differ from run to run: the root id and the time taken. */
  const lines = (err: string): string[] =>
    err
      .split("\n")
      .slice(0, -1)
      .filter((line) => !/^(root [0-9a-f]{32}|\d+\.\d s)$/.test(line));

  it("prints an address and a refusal's words as plain text", async () => {
    const refused = await run("refuser", "hi");
    expect([refused.code, refused.out]).toEqual([1, ""]);
    expect(refused.err).not.toContain(ESC);
    // The address on the line that says who is prompted, and the refusal's
    // words after `no reply:`.
    expect(lines(refused.err)).toEqual([
      "→ agents.prompt.re [2Jfuser.fabric.raw (agent identity: none)",
      "",
      "no reply: service error 500: no [2J way; the agent's own output says why",
    ]);
    // No agent of that kind: the error names every address that is there.
    const missing = await run("nosuch", "hi");
    expect([missing.code, missing.out]).toEqual([1, ""]);
    expect(missing.err).not.toContain(ESC);
    expect(missing.err).toContain("agents.prompt.re [2Jfuser.fabric.raw");
    expect(missing.err).toContain("agents.prompt.painter.test.main");
  }, 60_000);

  it("writes a reply that goes to a pipe as it came", async () => {
    const painted = await run("painter", "paint it");
    expect([painted.code, painted.out]).toEqual([0, `${PAINT_REPLY}\n`]);
    expect(lines(painted.err)).toEqual(["→ agents.prompt.painter.test.main (agent identity: none)"]);
  }, 60_000);
});
