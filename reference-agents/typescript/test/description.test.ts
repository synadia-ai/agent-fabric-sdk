// The agent's description: the rule (`src/description.ts`) against the
// vectors both reference agents share, `AGENT_DESCRIPTION` as `loadConfig`
// reads it, and the agent as `npm start` runs it, on a throwaway
// nats-server: what it registers and what its startup lines say.
//
// The vectors file holds two lists. `clean` is the rule the agents apply:
// it makes any text fit and never refuses. `entry` is for the places a
// person types a description, which refuse rather than change it (the
// `fabric` command and the console's form); the agents do not use it.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { Agents } from "@synadia-ai/agents";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cleanDescription, DESCRIPTION_LIMIT } from "../src/description.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

const binary = await natsServerOnPath();
const AGENT_DIR = join(import.meta.dirname, "..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The two lines an agent logs about a description it could not use as given.
const CLEANED =
  "AGENT_DESCRIPTION was cleaned: a description is one line of plain text of at most 500 characters. " +
  "A line break, a tab, a control or an invisible character becomes a space, runs of spaces become one, " +
  "and a longer text is cut to its first 500 characters.";
const NO_TEXT = "AGENT_DESCRIPTION holds no text: the default description is used.";

const vectors = JSON.parse(
  readFileSync(new URL("../../test-fixtures/description-vectors.json", import.meta.url), "utf8"),
) as { limit: number; clean: { name: string; in: string; out: string }[] };

describe("cleanDescription, against the shared vectors", () => {
  it("has the vectors' limit", () => {
    expect(DESCRIPTION_LIMIT).toBe(vectors.limit);
    expect(vectors.clean.length).toBeGreaterThan(0);
  });

  for (const v of vectors.clean) {
    it(v.name, () => {
      expect(cleanDescription(v.in)).toBe(v.out);
      // A cleaned text is a description: cleaning it again changes nothing.
      expect(cleanDescription(v.out)).toBe(v.out);
    });
  }
});

describe("AGENT_DESCRIPTION", () => {
  const env = {
    MODEL_PROXY_URL: "http://proxy",
    MODEL_VIRTUAL_KEY: "vk",
    MODEL_NAME: "m-1",
    NATS_CREDS: "/dev/null",
    AGENT_KIND: "researcher",
  };

  /** The description in use and what the agent logged about it. */
  function load(value?: string): { description: string; log: string[] } {
    const log: string[] = [];
    const cfg = loadConfig(value === undefined ? env : { ...env, AGENT_DESCRIPTION: value }, (line) => log.push(line));
    return { description: cfg.agent.description, log };
  }

  it("unset or empty, the default: <kind> agent (<model>)", () => {
    expect(load()).toEqual({ description: "researcher agent (m-1)", log: [] });
    expect(load("")).toEqual({ description: "researcher agent (m-1)", log: [] });
  });

  it("set, it is used as it is, and nothing is logged", () => {
    const text = "Keeps the logs of the orders server. Ask it what happened in a time range. Reads only; changes nothing on the server.";
    expect(load(text)).toEqual({ description: text, log: [] });
  });

  it("keeps every printable character: the rule cleans, it does not refuse", () => {
    const text = 'Answers "what broke?" for <orders> at $5 a `look`; the server\u2019s logs \\ 50% #1 \u{1F44D}';
    expect(load(text)).toEqual({ description: text, log: [] });
  });

  it("with a line break, it is one line, and one line in the log says it was cleaned", () => {
    expect(load("Keeps the logs.\nAsk it\twhat happened.\r\n")).toEqual({
      description: "Keeps the logs. Ask it what happened.",
      log: [CLEANED],
    });
  });

  it("with a control or an invisible character, a space takes its place", () => {
    expect(load("red \u001b[31malert\u200bhere")).toEqual({ description: "red [31malert here", log: [CLEANED] });
  });

  it("too long, it is cut to its first 500 characters, and the log says so", () => {
    const { description, log } = load(`${"word ".repeat(120)}end`);
    expect(Array.from(description).length).toBeLessThanOrEqual(DESCRIPTION_LIMIT);
    expect(description).toBe("word ".repeat(100).trimEnd());
    expect(log).toEqual([CLEANED]);
  });

  it("exactly 500 characters long, it is used whole", () => {
    const text = "a".repeat(499) + "\u{1F44D}";
    expect(load(text)).toEqual({ description: text, log: [] });
  });

  it("with nothing left once cleaned, the default, and the log says so", () => {
    expect(load("   ")).toEqual({ description: "researcher agent (m-1)", log: [NO_TEXT] });
    expect(load("\t\n\u200b")).toEqual({ description: "researcher agent (m-1)", log: [NO_TEXT] });
  });

  it("logs to the console unless told where", () => {
    const lines: unknown[][] = [];
    const real = console.log;
    console.log = (...args: unknown[]) => void lines.push(args);
    try {
      expect(loadConfig({ ...env, AGENT_DESCRIPTION: "a\nb" }).agent.description).toBe("a b");
    } finally {
      console.log = real;
    }
    expect(lines).toEqual([[CLEANED]]);
  });
});

describe.skipIf(binary === undefined)("the agent as `npm start` runs it", () => {
  it("registers the cleaned description, and its startup lines say it", async () => {
    const [agentUser, callerUser] = [newUser(), newUser()];
    const server = await TestNatsServer.start(binary!, [agentUser, callerUser]);
    const dir = await mkdtemp(join(tmpdir(), "fabric-examples-description-"));
    let child: ChildProcess | undefined;
    let nc: NatsConnection | undefined;
    try {
      const seed = join(dir, "agent.nk");
      await writeFile(seed, `${agentUser.seed}\n`);
      const ready = join(dir, "ready.json");
      // The startup lines are the agent's stdout; a warning on stderr is not one of them.
      let out = "";
      let err = "";
      child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: AGENT_DIR,
        env: {
          ...process.env,
          NATS_URL: server.url,
          NATS_NKEY_SEED_FILE: seed,
          NATS_CONTEXT: "",
          NATS_CREDS: "",
          AGENT_KIND: "logkeeper",
          AGENT_OWNER: "test",
          AGENT_NAME: "main",
          // As a quoted value in a `.env` gives it: on two lines.
          AGENT_DESCRIPTION: "Keeps the logs of the orders server.\nAsk it what happened in a time range.",
          AGENT_READY_FILE: ready,
          // Nothing prompts the agent, so no model is called.
          MODEL_PROXY_URL: "http://127.0.0.1:9",
          MODEL_VIRTUAL_KEY: "vk-test",
          MODEL_NAME: "fake-1",
          SCRATCHPAD_VOLUME: "",
          SCRATCHPAD_BOOTSTRAP_FILE: "",
          AGENT_DURABLE: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
      child.stderr?.on("data", (b: Buffer) => (err += b.toString()));
      // The startup lines follow the ready file; the last of them ends the wait.
      for (let i = 0; !(existsSync(ready) && out.includes("press Ctrl+C")); i += 1) {
        if (child.exitCode !== null || i > 300) throw new Error(`the agent did not start:\n${out}${err}`);
        await sleep(100);
      }

      // What the other agents are shown: the description on one line.
      nc = await connect({
        servers: server.url,
        authenticator: nkeyAuthenticator(new TextEncoder().encode(callerUser.seed)),
      });
      const caller = new Agents({ nc });
      const [found] = await caller.discover({ filter: { agent: "logkeeper" }, timeoutMs: 500 });
      await caller.close();
      expect(found?.description).toBe("Keeps the logs of the orders server. Ask it what happened in a time range.");

      // And what the person who started it is shown: that the text was
      // cleaned, then the description in use, under the address.
      const lines = out.split("\n");
      expect(lines[0]).toBe(CLEANED);
      expect(lines[1]).toBe("logkeeper agent listening on agents.prompt.logkeeper.test.main");
      expect(lines[2]).toBe("description: Keeps the logs of the orders server. Ask it what happened in a time range.");
    } finally {
      await nc?.close();
      if (child !== undefined && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(5_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
