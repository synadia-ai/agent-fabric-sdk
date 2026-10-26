// ScratchPad for Claude Code's model (`docs/plugins.md` §9.13), driven
// through the factory by a fake of the Claude Code plugin: the
// registration, the tool extension, and the file the variables go to — the
// connection, the workspace and the volume at start, the served prompt's
// trace and caller from its arrival to its end — since the add-on's process
// cannot set the Bash tool's environment. Then the package's SessionStart
// hook, which names that file to the Bash tool, and the package as a Claude
// Code plugin. The environment is a plain object, not the process's.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READS_REFERENCES_KEY } from "@synadia-ai/agent-fabric";
import createExtension, {
  ScratchPadHandOn,
  SP_VARS,
  spEnvFilePath,
  SpEnvFile,
} from "../../src/index.js";
import {
  extensionContext,
  fakeClient,
  fakeService,
  localTurn,
  recordingLogger,
  serve,
} from "../support/fake-plugin.js";

const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);
const THREAD_2 = "c".repeat(32);
const ROOT_2 = "d".repeat(32);
const CALLER = "ACALLERACCOUNT.UCALLERUSER";
const ADDRESS = "agents.prompt.cc.team.claude";
const PID = "4242";
const PACKAGE = resolve(__dirname, "../..");

let state: string;
let file: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "fabric-claude-code-sp-"));
  file = join(state, "agent-fabric", `${PID}.env`);
});

const configured = (): Record<string, string | undefined> => ({
  SCRATCHPAD_VOLUME: "CcVol",
  NATS_URL: "nats://127.0.0.1:4222",
  NATS_CREDS: "/keys/cc.creds",
  CLAUDE_PID: PID,
});

/** The file as `scripts/sp` reads it: `NAME=value` lines. */
function readVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line === "") continue;
    const at = line.indexOf("=");
    vars[line.slice(0, at)] = line.slice(at + 1);
  }
  return vars;
}

async function started(env: Record<string, string | undefined>) {
  const { logger, lines } = recordingLogger();
  const ext = await createExtension(extensionContext({ logger, stateDir: state }), env);
  await ext.started!({ agents: fakeClient().agents, service: fakeService(ADDRESS) });
  return { ext, lines };
}

describe("the registration and the tool extension", () => {
  it("declares reads-references and adds the extension when ScratchPad is on", async () => {
    const ext = await createExtension(extensionContext({ stateDir: state }), configured());
    expect(ext.metadata).toEqual({ [READS_REFERENCES_KEY]: "true" });
    expect(ext.toolExtensions).toHaveLength(1);
    expect(ext.toolExtensions![0]).toBeInstanceOf(ScratchPadHandOn);
    expect(ext.requestInterceptors).toHaveLength(3);
  });

  it("declares nothing, adds nothing and writes nothing when ScratchPad is off", async () => {
    const ext = await createExtension(extensionContext({ stateDir: state }), { CLAUDE_PID: PID });
    expect(ext.metadata).toBeUndefined();
    expect(ext.toolExtensions).toBeUndefined();
    expect(ext.requestInterceptors).toHaveLength(2);
    expect(existsSync(file)).toBe(false);
  });
});

describe("the file scripts/sp reads", () => {
  it("is the state directory's agent-fabric/<CLAUDE_PID>.env, else the parent's pid", () => {
    expect(spEnvFilePath("/s", { CLAUDE_PID: "77" }, 12)).toBe("/s/agent-fabric/77.env");
    expect(spEnvFilePath("/s", {}, 12)).toBe("/s/agent-fabric/12.env");
    expect(spEnvFilePath("/s", { CLAUDE_PID: "7; rm" }, 12)).toBe("/s/agent-fabric/12.env");
  });

  it("holds the connection, the workspace and the volume before the plugin connects, the creator once it is up", async () => {
    const env = configured();
    const ext = await createExtension(extensionContext({ stateDir: state }), env);
    const dir = join(state, "scratchpad");
    expect(readVars()).toEqual({
      SP_NATS_URL: "nats://127.0.0.1:4222",
      SP_NATS_CREDS: "/keys/cc.creds",
      SCRATCHPAD_VOLUME: "CcVol",
      SCRATCHPAD_DIR: dir,
      // Where scripts/sp records the grants it makes, beside the workspace.
      SP_GRANTS_FILE: `${dir}.grants`,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).isDirectory()).toBe(true);
    // The server's own environment is left as it was: no Bash reads it.
    expect(env).toEqual(configured());
    await ext.started!({ agents: fakeClient().agents, service: fakeService(ADDRESS) });
    expect(readVars()[SP_VARS.creator]).toBe(ADDRESS);
  });

  it("logs the volume, the workspace and the file at start", async () => {
    const { lines } = await started(configured());
    expect(lines.filter((l) => l.level === "info").at(-1)?.message).toBe(
      `agent-fabric: ScratchPad volume CcVol, workspace ${join(state, "scratchpad")}, ` +
        `for the skill's scripts/sp through ${file}`,
    );
  });

  it("holds the served prompt's trace and caller from its arrival to its end", async () => {
    const { ext } = await started(configured());
    const served = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await served.accepted;
    expect(readVars()).toMatchObject({
      SP_THREAD_ID: THREAD,
      SP_ROOT_ID: ROOT,
      SP_CALLER_ACCOUNT: "ACALLERACCOUNT",
      SP_CALLER_USER: "UCALLERUSER",
    });
    await served.end();
    const after = readVars();
    for (const v of [SP_VARS.threadId, SP_VARS.rootId, SP_VARS.callerAccount, SP_VARS.callerUser]) {
      expect(after[v]).toBeUndefined();
    }
    expect(after[SP_VARS.volume]).toBe("CcVol");
    expect(after[SP_VARS.creator]).toBe(ADDRESS);
  });

  it("names no caller for an unverified sender, so no grant goes out", async () => {
    const { ext } = await started(configured());
    const served = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await served.accepted;
    expect(readVars()[SP_VARS.threadId]).toBe(THREAD);
    expect(readVars()[SP_VARS.callerAccount]).toBeUndefined();
    await served.end();
  });

  it("gives a second prompt in the same turn its own, and the first back when the second ends", async () => {
    const { ext } = await started(configured());
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await first.accepted;
    const second = serve(ext, { thread_id: THREAD_2, root_id: ROOT_2 });
    await second.accepted;
    expect(readVars()[SP_VARS.threadId]).toBe(THREAD_2);
    expect(readVars()[SP_VARS.callerAccount]).toBeUndefined();
    await second.end();
    expect(readVars()).toMatchObject({ SP_THREAD_ID: THREAD, SP_CALLER_USER: "UCALLERUSER" });
    await first.end();
    expect(readVars()[SP_VARS.threadId]).toBeUndefined();
  });

  it("keeps the latest prompt's when an earlier one ends first", async () => {
    const { ext } = await started(configured());
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await first.accepted;
    const second = serve(ext, { thread_id: THREAD_2, root_id: ROOT_2 });
    await second.accepted;
    await first.end("error");
    expect(readVars()[SP_VARS.threadId]).toBe(THREAD_2);
    await second.end();
  });

  it("holds a local turn's root, with no caller, while it runs", async () => {
    const { ext } = await started(configured());
    const local = localTurn(ext, "0b5e7c0e-3f0a-4c55-9d0e-8b2f6a1d4c21");
    local.start();
    const vars = readVars();
    expect(vars[SP_VARS.threadId]).toMatch(/^[0-9a-f]{32}$/);
    expect(vars[SP_VARS.rootId]).toBe(vars[SP_VARS.threadId]);
    expect(vars[SP_VARS.callerAccount]).toBeUndefined();
    local.end();
    expect(readVars()[SP_VARS.threadId]).toBeUndefined();
  });

  it("never gives them to a prompt waiting behind the turn: the local turn keeps them until it ends", async () => {
    const { ext } = await started(configured());
    const local = localTurn(ext, "0b5e7c0e-3f0a-4c55-9d0e-8b2f6a1d4c21");
    local.start();
    const root = readVars()[SP_VARS.threadId];
    const waiting = serve(
      ext,
      { thread_id: THREAD, root_id: ROOT },
      { caller: CALLER, start: false },
    );
    await waiting.accepted;
    expect(readVars()[SP_VARS.threadId]).toBe(root);
    // Another prompt waits and ends meanwhile: the local turn's stay.
    const cancelled = serve(ext, { thread_id: THREAD_2, root_id: ROOT_2 }, { start: false });
    await cancelled.accepted;
    await cancelled.end("timeout");
    expect(readVars()[SP_VARS.threadId]).toBe(root);
    // The turn ends; the waiting prompt is taken into its own turn and takes them.
    local.end();
    expect(readVars()[SP_VARS.threadId]).toBeUndefined();
    waiting.start();
    expect(readVars()).toMatchObject({ SP_THREAD_ID: THREAD, SP_CALLER_USER: "UCALLERUSER" });
    await waiting.end();
    expect(readVars()[SP_VARS.threadId]).toBeUndefined();
  });

  it("is removed when the plugin stops", async () => {
    const { ext } = await started(configured());
    expect(existsSync(file)).toBe(true);
    await ext.stopping!();
    expect(existsSync(file)).toBe(false);
  });

  it("is not written, with a warning, when the plugin names no state directory", async () => {
    const { logger, lines } = recordingLogger();
    const ext = await createExtension(extensionContext({ logger, stateDir: null }), {
      ...configured(),
      SCRATCHPAD_DIR: join(state, "ws"),
    });
    expect(ext.toolExtensions).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
    expect(lines.map((l) => l.message)).toContain(
      "agent-fabric: the plugin names no state directory, so the skill's scripts/sp gets no ScratchPad settings",
    );
  });

  it("leaves out a value with a line break, which could not be read back", () => {
    const envFile = new SpEnvFile(file);
    envFile.vars[SP_VARS.volume] = "CcVol";
    envFile.vars[SP_VARS.dir] = "/a\nSP_CALLER_USER=someone";
    envFile.vars["OTHER"] = "x";
    envFile.write();
    expect(readVars()).toEqual({ SCRATCHPAD_VOLUME: "CcVol" });
  });
});

describe("the SessionStart hook", () => {
  const hook = join(PACKAGE, "hooks", "session-start.sh");

  function runHook(env: Record<string, string>): string {
    const envFile = join(state, "claude-env");
    writeFileSync(envFile, "");
    const r = spawnSync("sh", [hook], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", CLAUDE_ENV_FILE: envFile, ...env },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    return readFileSync(envFile, "utf8");
  }

  it("names the module's file for this Claude Code process to the Bash tool", () => {
    const out = runHook({ CLAUDE_PID: PID, NATS_STATE_DIR: state, HOME: "/nowhere" });
    expect(out).toBe(`export SP_ENV_FILE='${file}'\n`);
    // The shell that reads it gets the path back as it was.
    const echoed = spawnSync("sh", ["-c", `${out}printf %s "$SP_ENV_FILE"`], { encoding: "utf8" });
    expect(echoed.stdout).toBe(file);
  });

  it("takes the plugin's default state directory under HOME", () => {
    expect(runHook({ CLAUDE_PID: PID, HOME: "/home/it's" })).toBe(
      `export SP_ENV_FILE='/home/it'\\''s/.claude/channels/nats/agent-fabric/${PID}.env'\n`,
    );
  });

  it("names nothing without a Claude Code pid, and never fails the session", () => {
    expect(runHook({ HOME: "/h" })).toBe("");
    expect(runHook({ CLAUDE_PID: "12 34", HOME: "/h" })).toBe("");
    const r = spawnSync("sh", [hook], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(r.status).toBe(0);
  });
});

describe("the package as a Claude Code plugin", () => {
  it("has a manifest and registers the hook at SessionStart", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("agent-fabric");
    const hooks = JSON.parse(readFileSync(join(PACKAGE, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart"]);
    expect(hooks.hooks["SessionStart"]![0]!.hooks[0]!.command).toBe(
      'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"',
    );
  });

  it.skipIf(!existsSync(join(PACKAGE, "skills", "scratchpad", "SKILL.md")))(
    "ships the skill with scripts/sp allowed, and nothing else (npm run build:sp)",
    () => {
      const skill = readFileSync(join(PACKAGE, "skills", "scratchpad", "SKILL.md"), "utf8");
      const front = skill.split("---")[1]!;
      expect(front).toContain("\nname: scratchpad\n");
      expect(front).toContain("\nallowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)\n");
      expect(existsSync(join(PACKAGE, "skills", "scratchpad", "scripts", "sp"))).toBe(true);
    },
  );
});
