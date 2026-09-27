// ScratchPad for a harness's model, the pieces every add-on shares
// (`plugin-scratchpad.ts`): the settings' precedence, the per-prompt
// variables, the packaged sp's path, and the ScratchPad extension behind
// its wrapper. The add-ons' own suites drive them through their factories.

import { mkdtempSync, statSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Logger } from "@synadia-ai/agents";
import {
  exportScratchPad,
  resolveScratchPad,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  spBinary,
  type AgentExtensionContext,
} from "../../src/index.js";
import { MemoryScratchPad, promptContext, stubAgent, stubAgents } from "../support/scratchpad.js";

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function context(options: Record<string, unknown> = {}, stateDir?: string): AgentExtensionContext {
  return {
    harness: "openclaw",
    plugin: { name: "test", version: "0" },
    settings: {
      owner: "team",
      name: "agent",
      senderIdentity: "signed",
      minSenderTrust: "signed",
      ...(stateDir !== undefined ? { stateDir } : {}),
      config: {},
    },
    options,
    logger: quiet,
  };
}

describe("resolveScratchPad", () => {
  it("is off without a volume", async () => {
    expect(
      await resolveScratchPad(context(), { NATS_URL: "nats://x:1", NATS_CREDS: "/c" }),
    ).toBeUndefined();
  });

  it("takes the options over the variables, and puts the workspace under the state directory", async () => {
    const state = mkdtempSync(join(tmpdir(), "fabric-plugin-sp-"));
    const fromEnv = {
      SCRATCHPAD_VOLUME: "Env",
      NATS_URL: "nats://env:1",
      NATS_CREDS: "/env.creds",
    };
    expect(await resolveScratchPad(context({}, state), fromEnv)).toEqual({
      volume: "Env",
      url: "nats://env:1",
      creds: "/env.creds",
      dir: join(state, "scratchpad"),
    });
    expect(statSync(join(state, "scratchpad")).isDirectory()).toBe(true);
    const settings = await resolveScratchPad(
      context({ scratchpad: { volume: "Opt", url: "nats://opt:1", creds: "/opt.creds" } }, state),
      fromEnv,
    );
    expect(settings).toMatchObject({ volume: "Opt", url: "nats://opt:1", creds: "/opt.creds" });
  });

  it("takes the connection from the plugin's configuration when it names url and credentials", async () => {
    const ctx = context();
    const withConfig = {
      ...ctx,
      settings: { ...ctx.settings, config: { url: "nats://oc:4222", credentials: "/oc.creds" } },
    };
    expect(await resolveScratchPad(withConfig, { SCRATCHPAD_VOLUME: "OcVol" })).toMatchObject({
      volume: "OcVol",
      url: "nats://oc:4222",
      creds: "/oc.creds",
    });
  });

  it("exports the start-time variables", () => {
    const env: Record<string, string | undefined> = {};
    exportScratchPad({ volume: "V", url: "nats://u:1", creds: "/c", dir: "/d" }, env);
    expect(env).toEqual({
      SCRATCHPAD_VOLUME: "V",
      SP_NATS_URL: "nats://u:1",
      SP_NATS_CREDS: "/c",
      SCRATCHPAD_DIR: "/d",
    });
  });
});

describe("ServedPromptEnv", () => {
  it("sets a prompt's trace and verified caller, and clears them only for the prompt that holds them", () => {
    const env: Record<string, string | undefined> = {};
    const promptEnv = new ServedPromptEnv(env);
    const scope = { threadId: "a".repeat(32), rootId: "b".repeat(32), turnCountHint: 0 };
    promptEnv.enter({ id: "r1", extras: {}, caller: "ACCT.USER" }, scope);
    expect(env).toEqual({
      [SP_VARS.threadId]: "a".repeat(32),
      [SP_VARS.rootId]: "b".repeat(32),
      [SP_VARS.callerAccount]: "ACCT",
      [SP_VARS.callerUser]: "USER",
    });
    promptEnv.enter({ id: "r2", extras: {} }, scope);
    expect(env[SP_VARS.callerAccount]).toBeUndefined();
    promptEnv.leave({ id: "r1", extras: {} });
    expect(env[SP_VARS.threadId]).toBe("a".repeat(32));
    promptEnv.leave({ id: "r2", extras: {} });
    expect(env).toEqual({});
  });
});

describe("spBinary", () => {
  it("names the binary for this machine in the add-on's skill directory, or SCRATCHPAD_BIN", () => {
    const os = platform() === "darwin" ? "darwin" : "linux";
    const cpu = arch() === "arm64" ? "arm64" : "amd64";
    expect(spBinary({}, "/addon/skill/scratchpad")).toBe(
      `/addon/skill/scratchpad/bin/sp-${os}-${cpu}`,
    );
    expect(spBinary({ SCRATCHPAD_BIN: "/opt/sp" }, "/addon/skill/scratchpad")).toBe("/opt/sp");
  });
});

describe("ScratchPadHandOn", () => {
  const reader = stubAgent({ address: "agents.prompt.r.team.reader", identity: "AREADER.UREADER" });

  it("refuses a prompt with references before it starts, and discovery reads the registration", async () => {
    const handOn = new ScratchPadHandOn();
    expect(handOn.discoveryFields(reader)).toEqual({ reads_scratchpad_references: true });
    const pad = new MemoryScratchPad("vol-own");
    const rewrite = await handOn.beforePrompt(promptContext(reader, `see ${pad.commit()}`));
    expect((rewrite as { error: string }).error).toContain("ScratchPad is not ready yet");
  });

  it("hands on a reference into the agent's own volume as given, with a first-hand grant", async () => {
    const pad = new MemoryScratchPad("vol-own", "agents.prompt.h.team.agent");
    const handOn = new ScratchPadHandOn();
    handOn.start({ scratchPad: pad, agents: stubAgents().agents });
    const reference = pad.commit();
    expect(await handOn.beforePrompt(promptContext(reader, `see ${reference}`))).toBeUndefined();
    expect(pad.grants).toEqual([
      expect.objectContaining({ reference, grantee: "AREADER.UREADER", kind: "first-hand" }),
    ]);
  });

  it("remembers what the prompts served before it started brought", async () => {
    const theirs = new MemoryScratchPad("vol-reader", reader.promptSubject).commit();
    const handOn = new ScratchPadHandOn();
    await handOn.requestInterceptor.aroundRequest(
      { envelope: { prompt: `here ${theirs}` } } as never,
      () => Promise.resolve(),
    );
    handOn.start({ scratchPad: new MemoryScratchPad("vol-own"), agents: stubAgents().agents });
    // Back to its creator: no grant needed, nothing refused.
    expect(await handOn.beforePrompt(promptContext(reader, `back: ${theirs}`))).toBeUndefined();
  });
});
