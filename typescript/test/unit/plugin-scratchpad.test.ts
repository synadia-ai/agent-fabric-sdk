// ScratchPad for a harness's model, the pieces every add-on shares
// (`plugin-scratchpad.ts`): the settings' precedence, the per-prompt
// variables, the packaged sp's path, the grants `scripts/sp` recorded, and
// the ScratchPad extension behind its wrapper, with the grant requests it
// answers. The add-ons' own suites drive them through their factories.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@synadia-ai/agents";
import type { AgentService } from "@synadia-ai/agent-service";
import {
  exportScratchPad,
  findSp,
  noSpWarning,
  readRecordedGrants,
  resolveScratchPad,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  spBinary,
  withRecordedGrants,
  type AgentExtensionContext,
  type LocalTurn,
  type ServedRequest,
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
  it("clears the opposite plugin-owned environment when selecting bootstrap or legacy settings", () => {
    const env: Record<string, string | undefined> = { SCRATCHPAD_VOLUME: "Replies" };
    exportScratchPad(
      {
        url: "nats://x:1",
        creds: "/c",
        volume: "Replies",
        bootstrapFile: "/bootstrap.json",
        dir: "/work",
      },
      env,
    );
    expect(env.SCRATCHPAD_BOOTSTRAP_FILE).toBe("/bootstrap.json");
    expect(env.SCRATCHPAD_VOLUME).toBeUndefined();
    exportScratchPad({ url: "nats://x:1", creds: "/c", volume: "Legacy" }, env);
    expect(env.SCRATCHPAD_VOLUME).toBe("Legacy");
    expect(env.SCRATCHPAD_BOOTSTRAP_FILE).toBeUndefined();
  });
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
      grants: join(state, "scratchpad.grants"),
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

  describe("the connection, as the plugin's channel takes it", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    /** NATS CLI contexts under a config home of their own. */
    function natsContexts(contexts: Record<string, Record<string, unknown>>): void {
      const home = mkdtempSync(join(tmpdir(), "fabric-plugin-sp-ctx-"));
      const dir = join(home, "nats", "context");
      mkdirSync(dir, { recursive: true });
      for (const [name, fields] of Object.entries(contexts)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(fields));
      }
      vi.stubEnv("NATS_CONFIG_HOME", join(home, "nats"));
      vi.stubEnv("XDG_CONFIG_HOME", home);
    }

    /** A context whose plugin config names `configured` as its NATS context. */
    function withConfigContext(
      options: Record<string, unknown> = {},
      config: Record<string, unknown> = { context: "configured" },
    ): AgentExtensionContext {
      const ctx = context(options);
      return { ...ctx, settings: { ...ctx.settings, config } };
    }

    function recording(ctx: AgentExtensionContext): {
      ctx: AgentExtensionContext;
      warnings: string[];
    } {
      const warnings: string[] = [];
      return {
        ctx: { ...ctx, logger: { ...quiet, warn: (m: string) => warnings.push(m) } },
        warnings,
      };
    }

    const CONTEXTS = {
      configured: { url: "nats://file:4222", creds: "/file.creds" },
      named: { url: "nats://named:4222", creds: "/named.creds" },
    };

    it("takes a non-empty NATS_CONTEXT's context over NATS_URL and NATS_CREDS", async () => {
      natsContexts(CONTEXTS);
      expect(
        await resolveScratchPad(withConfigContext(), {
          SCRATCHPAD_VOLUME: "V",
          NATS_CONTEXT: "named",
          NATS_URL: "nats://env:4222",
          NATS_CREDS: "/env.creds",
        }),
      ).toMatchObject({ url: "nats://named:4222", creds: "/named.creds" });
    });

    it("reads no context for an empty NATS_CONTEXT, not even the config's: the variables, else off", async () => {
      natsContexts(CONTEXTS);
      const { ctx, warnings } = recording(withConfigContext());
      expect(
        await resolveScratchPad(ctx, { SCRATCHPAD_VOLUME: "V", NATS_CONTEXT: "" }),
      ).toBeUndefined();
      expect(warnings).toEqual([
        expect.stringContaining("ScratchPad is off: sp needs a NATS URL and a credentials file"),
      ]);
      expect(
        await resolveScratchPad(withConfigContext(), {
          SCRATCHPAD_VOLUME: "V",
          NATS_CONTEXT: "",
          NATS_URL: "nats://env:4222",
          NATS_CREDS: "/env.creds",
        }),
      ).toMatchObject({ url: "nats://env:4222", creds: "/env.creds" });
    });

    it("takes the variables over the config's context, never filling from it", async () => {
      natsContexts(CONTEXTS);
      expect(
        await resolveScratchPad(withConfigContext(), {
          SCRATCHPAD_VOLUME: "V",
          NATS_URL: "nats://env:4222",
          NATS_CREDS: "/env.creds",
        }),
      ).toMatchObject({ url: "nats://env:4222", creds: "/env.creds" });
      // A URL alone, or credentials alone, still selects the variables: off, as the channel
      // connects without the context (or, for credentials without a URL, fails).
      const urlOnly = recording(withConfigContext());
      expect(
        await resolveScratchPad(urlOnly.ctx, {
          SCRATCHPAD_VOLUME: "V",
          NATS_URL: "nats://env:4222",
        }),
      ).toBeUndefined();
      expect(urlOnly.warnings).toEqual([expect.stringContaining("ScratchPad is off")]);
      expect(
        await resolveScratchPad(withConfigContext(), {
          SCRATCHPAD_VOLUME: "V",
          NATS_CREDS: "/env.creds",
        }),
      ).toBeUndefined();
      // With none of them set, empty meaning unset, the config's context.
      expect(
        await resolveScratchPad(withConfigContext(), {
          SCRATCHPAD_VOLUME: "V",
          NATS_URL: "",
          NATS_CREDS: "",
          NATS_CREDENTIALS: "",
        }),
      ).toMatchObject({ url: "nats://file:4222", creds: "/file.creds" });
    });

    it("reads NATS_CREDENTIALS as NATS_CREDS's alias, in the order the channel reads them", async () => {
      expect(
        await resolveScratchPad(context(), {
          SCRATCHPAD_VOLUME: "V",
          NATS_URL: "nats://env:4222",
          NATS_CREDENTIALS: "/alias.creds",
        }),
      ).toMatchObject({ url: "nats://env:4222", creds: "/alias.creds" });
      const both = {
        SCRATCHPAD_VOLUME: "V",
        NATS_URL: "nats://env:4222",
        NATS_CREDS: "/creds.creds",
        NATS_CREDENTIALS: "/alias.creds",
      };
      expect((await resolveScratchPad(context(), both))?.creds).toBe("/creds.creds");
      expect(
        (
          await resolveScratchPad(context(), both, {
            credsVariables: ["NATS_CREDENTIALS", "NATS_CREDS"],
          })
        )?.creds,
      ).toBe("/alias.creds");
    });

    it("takes the options over everything, field by field, the channel's connection filling the rest", async () => {
      natsContexts(CONTEXTS);
      expect(
        await resolveScratchPad(
          withConfigContext({ scratchpad: { url: "nats://opt:4222", creds: "/opt.creds" } }),
          {
            SCRATCHPAD_VOLUME: "V",
            NATS_CONTEXT: "named",
            NATS_URL: "nats://env:4222",
            NATS_CREDS: "/env.creds",
          },
        ),
      ).toMatchObject({ url: "nats://opt:4222", creds: "/opt.creds" });
      expect(
        await resolveScratchPad(withConfigContext({ scratchpad: { url: "nats://opt:4222" } }), {
          SCRATCHPAD_VOLUME: "V",
          NATS_CONTEXT: "named",
          NATS_CREDS: "/env.creds",
        }),
      ).toMatchObject({ url: "nats://opt:4222", creds: "/named.creds" });
    });
  });

  it("exports the start-time variables", () => {
    const env: Record<string, string | undefined> = {};
    exportScratchPad(
      { volume: "V", url: "nats://u:1", creds: "/c", dir: "/d", grants: "/d.grants" },
      env,
    );
    expect(env).toEqual({
      SCRATCHPAD_VOLUME: "V",
      SP_NATS_URL: "nats://u:1",
      SP_NATS_CREDS: "/c",
      SCRATCHPAD_DIR: "/d",
      SP_GRANTS_FILE: "/d.grants",
    });
  });

  it("keeps only the live grants scripts/sp recorded, and no grants file without a workspace", async () => {
    const state = mkdtempSync(join(tmpdir(), "fabric-plugin-sp-"));
    const grants = join(state, "scratchpad.grants");
    const t = Math.floor(Date.now() / 1000);
    writeFileSync(
      grants,
      `${t - 1} AOLD UOLD sp-ref:old\nnot a line\n${t + 600} ALIVE ULIVE sp-ref:live\n`,
    );
    const env = { SCRATCHPAD_VOLUME: "V", NATS_URL: "nats://u:1", NATS_CREDS: "/c" };
    expect((await resolveScratchPad(context({}, state), env))?.grants).toBe(grants);
    expect(readFileSync(grants, "utf8")).toBe(`${t + 600} ALIVE ULIVE sp-ref:live\n`);
    expect((await resolveScratchPad(context(), env))?.grants).toBeUndefined();
  });
});

describe("the grants scripts/sp recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-plugin-grants-"));
  const CALLER = { account: "ACALLER", user: "UCALLER" };
  const pad = new MemoryScratchPad("vol-own", "agents.prompt.h.team.agent");
  const recorded = pad.commit("/published.txt");
  const file = join(dir, "grants");
  writeFileSync(file, `2000 ACALLER UCALLER ${recorded}\n1000 AGONE UGONE ${recorded}\n`);
  const ported = withRecordedGrants(pad, file, () => 1500);

  it("reads the lines the wrapper writes, and skips anything else", () => {
    writeFileSync(join(dir, "mixed"), `12 A U sp-ref:x\n12 A U not-a-ref\nx A U sp-ref:y\n\n`);
    expect(readRecordedGrants(join(dir, "mixed"))).toEqual([
      { expiresAt: 12, grantee: { account: "A", user: "U" }, reference: "sp-ref:x" },
    ]);
    expect(readRecordedGrants(join(dir, "absent"))).toEqual([]);
  });

  it("counts a live recorded grant as first-hand, for that grantee and that reference only", async () => {
    expect(await ported.granted(recorded, CALLER)).toBe("first-hand");
    expect(await ported.granted(recorded, { account: "AGONE", user: "UGONE" })).toBeUndefined();
    expect(await ported.granted(pad.commit("/other.txt"), CALLER)).toBeUndefined();
    expect(await ported.granted(recorded, { account: "ACALLER", user: "UOTHER" })).toBeUndefined();
  });

  it("retains short-token grant records and the optional resolver through the wrapper", async () => {
    const token = "sp-r1:" + "A".repeat(60),
      ledger = join(dir, "short");
    writeFileSync(ledger, `2000 ACALLER UCALLER ${token}\n`);
    const wrapped = withRecordedGrants(
      {
        owns: () => true,
        granted: () => undefined,
        grantRead: () => {},
        resolveReference: () => Promise.resolve({ creator: "agents.prompt.creator.team.main" }),
      },
      ledger,
      () => 1500,
    );
    expect(await wrapped.granted(token, CALLER)).toBe("first-hand");
    expect(await wrapped.granted(token.slice(0, -1) + "B", CALLER)).toBeUndefined();
    expect(await wrapped.resolveReference!(token)).toEqual({
      creator: "agents.prompt.creator.team.main",
    });
  });

  it("keeps the port's own answer when nothing live is recorded", async () => {
    const other = pad.commit("/granted-on-request.txt");
    await ported.grantRead(other, CALLER, undefined, undefined, "on-request");
    expect(await ported.granted(other, CALLER)).toBe("on-request");
    expect(pad.grants.at(-1)).toMatchObject({ reference: other, kind: "on-request" });
    expect(await ported.owns(other)).toBe(true);
  });
});

describe("ServedPromptEnv", () => {
  it("sets a prompt's trace and verified caller, and clears them only for the prompt that holds them", () => {
    const env: Record<string, string | undefined> = {};
    const promptEnv = new ServedPromptEnv(env);
    const scope = { threadId: "a".repeat(32), rootId: "b".repeat(32), turnCountHint: 0 };
    const r1: ServedRequest = { id: "r1", extras: {}, caller: "ACCT.USER" };
    const r2: ServedRequest = { id: "r2", extras: {} };
    promptEnv.enter(r1, scope);
    expect(env).toEqual({
      [SP_VARS.threadId]: "a".repeat(32),
      [SP_VARS.rootId]: "b".repeat(32),
      [SP_VARS.callerAccount]: "ACCT",
      [SP_VARS.callerUser]: "USER",
    });
    promptEnv.enter(r2, scope);
    expect(env[SP_VARS.callerAccount]).toBeUndefined();
    promptEnv.leave(r1);
    expect(env[SP_VARS.threadId]).toBe("a".repeat(32));
    promptEnv.leave(r2);
    expect(env).toEqual({});
  });

  it("holds a local turn's trace, with no caller, and keeps it apart from a request's", () => {
    const env: Record<string, string | undefined> = {};
    const promptEnv = new ServedPromptEnv(env);
    const local = { threadId: "c".repeat(32), rootId: "c".repeat(32), turnCountHint: 0 };
    const turn: LocalTurn = { id: "local-1", local: true };
    const request: ServedRequest = { id: "1", extras: {}, caller: "ACCT.USER" };
    promptEnv.enter(request, {
      threadId: "a".repeat(32),
      rootId: "b".repeat(32),
      turnCountHint: 0,
    });
    promptEnv.enter(turn, local);
    expect(env).toEqual({ [SP_VARS.threadId]: "c".repeat(32), [SP_VARS.rootId]: "c".repeat(32) });
    // The request's end does not clear the turn's variables.
    promptEnv.leave(request);
    expect(env[SP_VARS.threadId]).toBe("c".repeat(32));
    promptEnv.leave(turn);
    expect(env).toEqual({});
  });
});

describe("findSp: the add-on's own sp, the first executable file", () => {
  const os = platform() === "darwin" ? "darwin" : "linux";
  const cpu = arch() === "arm64" ? "arm64" : "amd64";
  const layout = () => {
    const root = mkdtempSync(join(tmpdir(), "fabric-find-sp-"));
    const skillDir = join(root, "skill", "scratchpad");
    const shipped = join(skillDir, "bin", `sp-${os}-${cpu}`);
    const file = (path: string, mode: number): string => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, mode);
      return path;
    };
    return { root, skillDir, shipped, file };
  };

  it("takes SCRATCHPAD_BIN when it is an executable file", () => {
    const { root, skillDir, file } = layout();
    const own = file(join(root, "own", "sp"), 0o755);
    expect(findSp({ SCRATCHPAD_BIN: own }, skillDir)).toEqual({ bin: own, tried: [] });
    expect(spBinary({ SCRATCHPAD_BIN: own }, skillDir)).toBe(own);
  });

  it("else the binary shipped for this machine, saying why SCRATCHPAD_BIN was passed over", () => {
    const { root, skillDir, shipped, file } = layout();
    file(shipped, 0o755);
    expect(findSp({}, skillDir)).toEqual({ bin: shipped, tried: ["SCRATCHPAD_BIN is not set"] });
    expect(findSp({ SCRATCHPAD_BIN: "" }, skillDir).bin).toBe(shipped);
    const missing = join(root, "missing");
    expect(findSp({ SCRATCHPAD_BIN: missing }, skillDir)).toEqual({
      bin: shipped,
      tried: [`SCRATCHPAD_BIN ${missing} does not exist`],
    });
    const notExecutable = file(join(root, "own", "sp"), 0o644);
    expect(findSp({ SCRATCHPAD_BIN: notExecutable }, skillDir).tried).toEqual([
      `SCRATCHPAD_BIN ${notExecutable} is not executable`,
    ]);
    expect(findSp({ SCRATCHPAD_BIN: root }, skillDir).tried).toEqual([
      `SCRATCHPAD_BIN ${root} is not a file`,
    ]);
  });

  it("none, when neither is there: a module copied without its skill directory, or without the modes", () => {
    const { skillDir, shipped, file } = layout();
    expect(findSp({}, skillDir)).toEqual({
      bin: undefined,
      tried: ["SCRATCHPAD_BIN is not set", `${shipped} does not exist`],
    });
    expect(spBinary({}, skillDir)).toBeUndefined();
    file(shipped, 0o600);
    expect(findSp({}, skillDir)).toEqual({
      bin: undefined,
      tried: ["SCRATCHPAD_BIN is not set", `${shipped} is not executable`],
    });
  });

  it("the warning names what was tried, the variable that fixes it, and what is left out", () => {
    expect(
      noSpWarning("agent-fabric", {
        bin: undefined,
        tried: ["SCRATCHPAD_BIN is not set", "/a/sp does not exist"],
      }),
    ).toBe(
      "agent-fabric: no sp for the add-on's own ScratchPad steps (SCRATCHPAD_BIN is not set; /a/sp does not exist); " +
        "set SCRATCHPAD_BIN to the path of an sp binary. Until then nothing is granted: references in prompt_agent " +
        "are removed with a note, and grant requests are not answered",
    );
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

  describe("started without ScratchPad (no sp): nothing can be granted, so every reference is removed with a note", () => {
    const own = new MemoryScratchPad("vol-own", "agents.prompt.h.team.agent");
    const other = new MemoryScratchPad("vol-other", "agents.prompt.h.team.other");
    const nonReader = stubAgent({
      address: "agents.prompt.r.team.plain",
      identity: "APLAIN.UPLAIN",
      readsReferences: false,
    });
    const without = async (given: string[]) => {
      const agents = stubAgents([reader, nonReader]);
      const handOn = new ScratchPadHandOn();
      for (const reference of given) {
        await handOn.requestInterceptor.aroundRequest(
          { envelope: { prompt: `take ${reference}` } } as never,
          () => Promise.resolve(),
        );
      }
      handOn.startWithoutScratchPad();
      return { handOn, agents };
    };
    const noted = (address: string, n: number) => ({
      references_removed: n,
      note:
        "this agent has no sp of its own to grant read with (SCRATCHPAD_BIN names one): " +
        `${n} reference(s) were removed from your prompt, "${address}" got only the text, and nothing was granted`,
    });

    it("a reader: its own reference is removed with a note, and nothing is granted", async () => {
      const reference = own.commit();
      const { handOn } = await without([reference]);
      expect(await handOn.beforePrompt(promptContext(reader, `summarise ${reference}`))).toEqual({
        prompt: "summarise",
        fields: noted(reader.promptSubject, 1),
      });
      expect(own.grants).toEqual([]);
      expect(handOn.discoveryFields(reader)).toEqual({ reads_scratchpad_references: true });
    });

    it("a non-reader: the references are removed with the same note", async () => {
      const reference = own.commit();
      const { handOn } = await without([reference]);
      expect(
        await handOn.beforePrompt(promptContext(nonReader, `see ${reference} twice ${reference}`)),
      ).toEqual({
        prompt: "see  twice",
        fields: noted(nonReader.promptSubject, 2),
      });
    });

    it("a token the agent was not given never goes out", async () => {
      const { handOn } = await without([]);
      const stray = other.commit();
      expect(await handOn.beforePrompt(promptContext(reader, `look ${stray}`))).toEqual({
        prompt: "look",
        fields: noted(reader.promptSubject, 1),
      });
    });

    it("another agent's sp-ref: is removed, and its creator is not asked", async () => {
      const reference = other.commit();
      const { handOn, agents } = await without([reference]);
      expect(await handOn.beforePrompt(promptContext(reader, `read ${reference}`))).toEqual({
        prompt: "read",
        fields: noted(reader.promptSubject, 1),
      });
      expect(agents.requests).toEqual([]);
      expect(other.grants).toEqual([]);
    });

    it("a prompt of nothing but references is refused, in the words of the non-reader rule", async () => {
      const reference = own.commit();
      const { handOn } = await without([reference]);
      expect(await handOn.beforePrompt(promptContext(reader, reference))).toEqual({
        error:
          "the prompt was not sent: this agent has no sp of its own to grant read with (SCRATCHPAD_BIN names one), " +
          "and the prompt held nothing but references; put the content they point at into the prompt itself",
      });
      expect(
        await handOn.beforePrompt(promptContext(reader, "no references here")),
      ).toBeUndefined();
    });
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

  it("answers grant requests on the service it is given, next to the agent's prompt address", () => {
    const added: { name: string; subject: string; queue?: string }[] = [];
    const service = {
      subject: { prompt: "agents.prompt.h.team.agent" },
      service: {
        addEndpoint: (name: string, opts: { subject: string; queue?: string }) => {
          added.push({ name, subject: opts.subject, ...(opts.queue ? { queue: opts.queue } : {}) });
        },
      },
    } as unknown as AgentService;
    new ScratchPadHandOn().start({
      scratchPad: new MemoryScratchPad("vol-own"),
      agents: stubAgents().agents,
      service,
    });
    expect(added).toEqual([
      { name: "sp-grant", subject: "agents.sp-grant.h.team.agent", queue: "agents" },
    ]);
  });

  it("says so, and hands on all the same, when the endpoint cannot be added", async () => {
    const warned: string[] = [];
    const logger: Logger = { ...quiet, warn: (m) => warned.push(m) };
    const service = {
      subject: { prompt: "agents.prompt.h.team.agent" },
      service: {
        addEndpoint: () => {
          throw new Error("taken");
        },
      },
    } as unknown as AgentService;
    const pad = new MemoryScratchPad("vol-own");
    const handOn = new ScratchPadHandOn();
    handOn.start({ scratchPad: pad, agents: stubAgents().agents, service, logger });
    expect(warned).toEqual(["agent-fabric: grant requests are not answered: Error: taken"]);
    expect(await handOn.beforePrompt(promptContext(reader, `see ${pad.commit()}`))).toBeUndefined();
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
