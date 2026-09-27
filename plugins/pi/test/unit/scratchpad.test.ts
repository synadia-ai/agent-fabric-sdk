// ScratchPad's environment, set by the add-on for the skill's `scripts/sp`
// (`docs/plugins.md` §9): resolved once the service is up, per served
// prompt from its hand-over to its end. A fake of the PI plugin drives the
// extension; the environment is a plain object, not the process's.

import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, Agents, AgentToolsPromptContext } from "@synadia-ai/agents";
import { READS_REFERENCES_KEY } from "@synadia-ai/agent-fabric";
import createExtension, { SCRATCHPAD_OPTION, ScratchPadHandOn, SP_VARS } from "../../src/index.js";
import { extensionContext, recordingLogger, serve } from "../support/fake-plugin.js";
import { makeReference, MemoryScratchPad } from "../support/scratchpad-fake.js";

const ADDRESS = "agents.prompt.pi.team.editor";
const handles = { service: { subject: { prompt: ADDRESS } } };
const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);
const CALLER = "ACALLERACCOUNT.UCALLERUSER";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fabric-pi-sp-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A NATS CLI context `name` under a config home of its own. */
function natsContext(name: string, fields: Record<string, unknown>): void {
  const dir = join(home, "nats", "context");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fields));
  vi.stubEnv("NATS_CONFIG_HOME", join(home, "nats"));
  vi.stubEnv("XDG_CONFIG_HOME", home);
}

async function started(
  env: Record<string, string | undefined>,
  overrides: Parameters<typeof extensionContext>[0] = {},
) {
  const { logger, lines } = recordingLogger();
  const ext = await createExtension(extensionContext({ logger, ...overrides }), env);
  await ext.started!(handles as never);
  return { ext, lines };
}

describe("at start", () => {
  it("sets nothing without a volume: ScratchPad is off", async () => {
    const env: Record<string, string | undefined> = { NATS_URL: "nats://x:4222", NATS_CREDS: "/c" };
    await started(env, { stateDir: home });
    expect(env).toEqual({ NATS_URL: "nats://x:4222", NATS_CREDS: "/c" });
  });

  it("takes the volume and the connection from the variables, the workspace under the state directory", async () => {
    const env: Record<string, string | undefined> = {
      SCRATCHPAD_VOLUME: "pi-vol",
      NATS_URL: "nats://127.0.0.1:4222",
      NATS_CREDS: "/keys/pi.creds",
    };
    const { lines } = await started(env, { stateDir: home });
    const dir = join(home, "scratchpad");
    expect(env).toEqual({
      SCRATCHPAD_VOLUME: "pi-vol",
      NATS_URL: "nats://127.0.0.1:4222",
      NATS_CREDS: "/keys/pi.creds",
      SCRATCHPAD_DIR: dir,
      SP_CREATOR: ADDRESS,
    });
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(lines.filter((l) => l.level === "info").at(-1)?.message).toBe(
      `agent-fabric: ScratchPad volume pi-vol, workspace ${dir}, for the skill's scripts/sp`,
    );
  });

  it("prefers the config entry's options to the variables", async () => {
    const env: Record<string, string | undefined> = {
      SCRATCHPAD_VOLUME: "from-env",
      NATS_URL: "nats://env:4222",
      NATS_CREDS: "/env.creds",
    };
    const dir = join(home, "ws");
    await started(env, {
      options: {
        [SCRATCHPAD_OPTION]: {
          volume: "from-options",
          url: "nats://opt:4222",
          creds: "/opt.creds",
          dir,
        },
      },
    });
    expect(env[SP_VARS.volume]).toBe("from-options");
    expect(env[SP_VARS.url]).toBe("nats://opt:4222");
    expect(env[SP_VARS.creds]).toBe("/opt.creds");
    expect(env[SP_VARS.dir]).toBe(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
  });

  it("reads the URL and the credentials file from the plugin's NATS context, which sp cannot", async () => {
    natsContext("fabric", { url: "nats://ctx:4333", creds: "/ctx/pi.creds" });
    const env: Record<string, string | undefined> = { SCRATCHPAD_VOLUME: "pi-vol" };
    await started(env, { stateDir: home });
    expect(env[SP_VARS.url]).toBe("nats://ctx:4333");
    expect(env[SP_VARS.creds]).toBe("/ctx/pi.creds");
  });

  it("lets NATS_CONTEXT name the context, as the plugin does", async () => {
    natsContext("other", { url: "nats://other:4333", creds: "/other.creds" });
    const env: Record<string, string | undefined> = {
      SCRATCHPAD_VOLUME: "v",
      NATS_CONTEXT: "other",
    };
    await started(env, { stateDir: home });
    expect(env[SP_VARS.url]).toBe("nats://other:4333");
  });

  it("stays off, with a warning, when no connection sp can use is found", async () => {
    natsContext("fabric", { url: "nats://ctx:4333" });
    const env: Record<string, string | undefined> = { SCRATCHPAD_VOLUME: "pi-vol" };
    const { lines } = await started(env, { stateDir: home });
    expect(env).toEqual({ SCRATCHPAD_VOLUME: "pi-vol" });
    expect(lines.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      expect.stringContaining("ScratchPad is off: sp needs a NATS URL and a credentials file"),
    ]);
  });

  it("stays off, with a warning, when the context cannot be read", async () => {
    natsContext("present", { url: "nats://x:1" });
    const env: Record<string, string | undefined> = { SCRATCHPAD_VOLUME: "pi-vol" };
    const { lines } = await started(env, { stateDir: home, config: { context: "missing" } });
    expect(env[SP_VARS.url]).toBeUndefined();
    expect(lines.filter((l) => l.level === "warn").map((l) => l.message)).toEqual([
      expect.stringContaining('the NATS context "missing" could not be read'),
    ]);
  });
});

describe("per served prompt", () => {
  const configured = (): Record<string, string | undefined> => ({
    SCRATCHPAD_VOLUME: "pi-vol",
    NATS_URL: "nats://127.0.0.1:4222",
    NATS_CREDS: "/keys/pi.creds",
  });

  it("sets the prompt's trace and caller at the hand-over, and clears them at its end", async () => {
    const env = configured();
    const { ext } = await started(env, { stateDir: home });
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT }, CALLER);
    await served.accepted;
    // Accepted is not yet handed over: PI may still be busy with another prompt.
    expect(env[SP_VARS.threadId]).toBeUndefined();
    const seen = ext.events!.aroundInject!(served.request, () => ({ ...env }));
    expect(seen[SP_VARS.threadId]).toBe(THREAD);
    expect(seen[SP_VARS.rootId]).toBe(ROOT);
    expect(seen[SP_VARS.callerAccount]).toBe("ACALLERACCOUNT");
    expect(seen[SP_VARS.callerUser]).toBe("UCALLERUSER");
    await served.end();
    for (const v of [SP_VARS.threadId, SP_VARS.rootId, SP_VARS.callerAccount, SP_VARS.callerUser]) {
      expect(env[v]).toBeUndefined();
    }
    expect(env[SP_VARS.volume]).toBe("pi-vol");
  });

  it("gives a minted root when the prompt carried no lineage", async () => {
    const env = configured();
    const { ext } = await started(env, { stateDir: home });
    const served = serve(ext, "r1", {}, CALLER);
    await served.accepted;
    ext.events!.aroundInject!(served.request, () => undefined);
    expect(env[SP_VARS.threadId]).toMatch(/^[0-9a-f]{32}$/);
    expect(env[SP_VARS.rootId]).toBe(env[SP_VARS.threadId]);
    await served.end();
  });

  it("sets no caller for an unverified sender, so no grant goes out", async () => {
    const env = configured();
    const { ext } = await started(env, { stateDir: home });
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT });
    await served.accepted;
    ext.events!.aroundInject!(served.request, () => undefined);
    expect(env[SP_VARS.threadId]).toBe(THREAD);
    expect(env[SP_VARS.callerAccount]).toBeUndefined();
    await served.end();
  });

  it("never clears the next prompt's variables at the end of an earlier one", async () => {
    const env = configured();
    const { ext } = await started(env, { stateDir: home });
    const first = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT }, CALLER);
    const second = serve(ext, "r2", { thread_id: "c".repeat(32), root_id: ROOT }, "AOTHER.UOTHER");
    await first.accepted;
    await second.accepted;
    ext.events!.aroundInject!(first.request, () => undefined);
    ext.events!.aroundInject!(second.request, () => undefined);
    await first.end();
    expect(env[SP_VARS.threadId]).toBe("c".repeat(32));
    expect(env[SP_VARS.callerAccount]).toBe("AOTHER");
    await second.end();
    expect(env[SP_VARS.threadId]).toBeUndefined();
  });

  it("sets nothing per prompt while ScratchPad is off", async () => {
    const env: Record<string, string | undefined> = {};
    const { ext } = await started(env, { stateDir: home });
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT }, CALLER);
    await served.accepted;
    ext.events!.aroundInject!(served.request, () => undefined);
    expect(env).toEqual({});
    await served.end();
  });
});

describe("references: the registration and the tool extension", () => {
  const configured = (): Record<string, string | undefined> => ({
    SCRATCHPAD_VOLUME: "pi-vol",
    NATS_URL: "nats://127.0.0.1:4222",
    NATS_CREDS: "/keys/pi.creds",
  });

  it("declares reads-references and adds the extension when ScratchPad is on", async () => {
    const ext = await createExtension(extensionContext({ stateDir: home }), configured());
    expect(ext.metadata).toEqual({ [READS_REFERENCES_KEY]: "true" });
    expect(ext.toolExtensions).toHaveLength(1);
    expect(ext.toolExtensions![0]).toBeInstanceOf(ScratchPadHandOn);
    expect(ext.requestInterceptors).toHaveLength(3);
  });

  it("declares nothing and adds nothing when ScratchPad is off", async () => {
    const ext = await createExtension(extensionContext({ stateDir: home }), {});
    expect(ext.metadata).toBeUndefined();
    expect(ext.toolExtensions).toBeUndefined();
    expect(ext.requestInterceptors).toHaveLength(2);
  });

  it("sets the connection before the plugin connects, the creator once the service is up", async () => {
    const env = configured();
    const ext = await createExtension(extensionContext({ stateDir: home }), env);
    expect(env[SP_VARS.dir]).toBe(join(home, "scratchpad"));
    expect(env[SP_VARS.creator]).toBeUndefined();
    await ext.started!({ agents: {}, service: { subject: { prompt: ADDRESS } } } as never);
    expect(env[SP_VARS.creator]).toBe(ADDRESS);
  });
});

describe("ScratchPadHandOn", () => {
  const TARGET = "agents.prompt.fabric-r.fabric.reader";
  const reader = {
    promptSubject: TARGET,
    identity: "AREADER.UREADER",
    idSigVerified: true,
    metadata: { [READS_REFERENCES_KEY]: "true" },
  } as unknown as Agent;
  const promptTo = (prompt: string): AgentToolsPromptContext =>
    ({
      address: TARGET,
      target: reader,
      prompt,
      arguments: {},
    }) as unknown as AgentToolsPromptContext;
  const agents = {} as Agents;

  it("before it starts, reports discovery from the registration and refuses a prompt with references", async () => {
    const handOn = new ScratchPadHandOn();
    expect(handOn.discoveryFields(reader)).toEqual({ reads_scratchpad_references: true });
    expect(await handOn.beforePrompt(promptTo("no references here"))).toBeUndefined();
    const refused = await handOn.beforePrompt(promptTo(`see ${makeReference("PiVol", "/a")}`));
    expect((refused as { error: string }).error).toContain("ScratchPad is not ready yet");
  });

  it("hands on PI's own reference, published with scripts/sp, as given: a first-hand grant", async () => {
    const handOn = new ScratchPadHandOn();
    const volume = new MemoryScratchPad("PiVol");
    handOn.start({ scratchPad: volume, agents });
    const reference = makeReference("PiVol", "/a", ADDRESS);
    expect(await handOn.beforePrompt(promptTo(`see ${reference}`))).toBeUndefined();
    expect(volume.grants).toEqual([
      expect.objectContaining({ reference, grantee: "AREADER.UREADER", kind: "first-hand" }),
    ]);
  });

  it("remembers the references of prompts served before it started", async () => {
    // A reference the target itself created: given to PI in a served
    // prompt, it may go back to its creator without a grant.
    const theirs = makeReference("ReaderVol", "/r", TARGET);
    const early = new ScratchPadHandOn();
    await early.requestInterceptor.aroundRequest(
      { envelope: { prompt: `here: ${theirs}` } } as never,
      () => Promise.resolve(),
    );
    early.start({ scratchPad: new MemoryScratchPad("PiVol"), agents });
    expect(await early.beforePrompt(promptTo(`back to you: ${theirs}`))).toBeUndefined();

    const late = new ScratchPadHandOn();
    late.start({ scratchPad: new MemoryScratchPad("PiVol"), agents });
    const refused = (await late.beforePrompt(promptTo(`back to you: ${theirs}`))) as {
      error: string;
    };
    expect(refused.error).toContain("is not one you were given");
  });
});
