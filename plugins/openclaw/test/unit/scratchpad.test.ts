// ScratchPad for OpenClaw's model (`docs/plugins.md` §9), driven through the
// factory by a fake of the OpenClaw plugin: the registration, the tool
// extension, the environment set before the plugin connects, and the
// served prompt's trace and caller set around its dispatch until its end.
// The environment is a plain object, not the process's.

import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READS_REFERENCES_KEY } from "@synadia-ai/agent-fabric";
import createExtension, { ScratchPadHandOn, SP_VARS } from "../../src/index.js";
import {
  extensionContext,
  fakeClient,
  fakeService,
  recordingLogger,
  serve,
} from "../support/fake-plugin.js";

const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);
const CALLER = "ACALLERACCOUNT.UCALLERUSER";
const ADDRESS = "agents.prompt.oc.team.summarizer";

let state: string;
beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "fabric-openclaw-sp-"));
});

const configured = (): Record<string, string | undefined> => ({
  SCRATCHPAD_VOLUME: "OcVol",
  NATS_URL: "nats://127.0.0.1:4222",
  NATS_CREDS: "/keys/oc.creds",
});

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

  it("declares nothing and adds nothing when ScratchPad is off", async () => {
    const ext = await createExtension(extensionContext({ stateDir: state }), {});
    expect(ext.metadata).toBeUndefined();
    expect(ext.toolExtensions).toBeUndefined();
    expect(ext.requestInterceptors).toHaveLength(2);
  });
});

describe("the environment", () => {
  it("sets the connection, the workspace and the volume before the plugin connects, the creator once it is up", async () => {
    const env = configured();
    const ext = await createExtension(extensionContext({ stateDir: state }), env);
    const dir = join(state, "scratchpad");
    // The connection under names of its own: OpenClaw's plugin reads NATS_URL
    // and NATS_CREDS as overrides of its account, so the add-on never sets them.
    expect(env).toEqual({
      ...configured(),
      SP_NATS_URL: "nats://127.0.0.1:4222",
      SP_NATS_CREDS: "/keys/oc.creds",
      SCRATCHPAD_DIR: dir,
      // Where scripts/sp records the grants it makes, beside the workspace.
      SP_GRANTS_FILE: `${dir}.grants`,
    });
    expect(statSync(dir).isDirectory()).toBe(true);
    await ext.started!({ agents: fakeClient().agents, service: fakeService(ADDRESS) });
    expect(env[SP_VARS.creator]).toBe(ADDRESS);
  });

  it("logs the volume and the workspace at start", async () => {
    const { lines } = await started(configured());
    expect(lines.filter((l) => l.level === "info").at(-1)?.message).toBe(
      `agent-fabric: ScratchPad volume OcVol, workspace ${join(state, "scratchpad")}, for the skill's scripts/sp`,
    );
  });

  it("sets the served prompt's trace and caller around its dispatch, and clears them at its end", async () => {
    const env = configured();
    const { ext } = await started(env);
    const served = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await served.dispatched;
    expect(env[SP_VARS.threadId]).toBe(THREAD);
    expect(env[SP_VARS.rootId]).toBe(ROOT);
    expect(env[SP_VARS.callerAccount]).toBe("ACALLERACCOUNT");
    expect(env[SP_VARS.callerUser]).toBe("UCALLERUSER");
    await served.end();
    for (const v of [SP_VARS.threadId, SP_VARS.rootId, SP_VARS.callerAccount, SP_VARS.callerUser]) {
      expect(env[v]).toBeUndefined();
    }
    expect(env[SP_VARS.volume]).toBe("OcVol");
  });

  it("sets no caller for an unverified sender, so no grant goes out", async () => {
    const env = configured();
    const { ext } = await started(env);
    const served = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await served.dispatched;
    expect(env[SP_VARS.threadId]).toBe(THREAD);
    expect(env[SP_VARS.callerAccount]).toBeUndefined();
    await served.end();
  });

  it("sets nothing per prompt while ScratchPad is off", async () => {
    const env: Record<string, string | undefined> = {};
    const { ext } = await started(env);
    const served = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await served.dispatched;
    expect(env).toEqual({});
    await served.end();
  });
});
