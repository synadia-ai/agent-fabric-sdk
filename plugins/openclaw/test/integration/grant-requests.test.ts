// Grant requests for what OpenClaw published, on a real `AgentService` and
// `Agents` over a local nats-server in operator mode. OpenClaw (carol) is wired as
// the OpenClaw plugin wires it and started through the add-on's own `started()`,
// its ScratchPad the add-on's port over the fabric package's stand-in `sp`
// (`fake-sp.mjs`), which knows each principal by its credentials file.
//
// OpenClaw's model publishes with `scripts/sp`, which grants the served prompt's
// caller (alice) read and records the grant in the grants file. Here the
// publication goes through the same stand-in and the record is the line
// the wrapper writes (its own tests: `plugins/harness/test/unit/scripts-sp.test.ts`).
// Alice, an SDK-built agent with the fabric package's ScratchPad extension,
// then hands OpenClaw's reference to a third agent (dave): its extension asks OpenClaw,
// the creator, for a grant, OpenClaw's add-on answers by an SDK-built agent's
// rule, and dave reads the content with its own credentials.

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import {
  Agents,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  signerFromCredsFile,
  type AgentToolResult,
  type SenderSigner,
} from "@synadia-ai/agents";
import {
  READS_REFERENCES_KEY,
  scratchPadExtension,
  spCliScratchPad,
  type ScratchPadClient,
  type ScratchPadExtension,
} from "@synadia-ai/agent-fabric";
import { createFabricExtension } from "../../src/index.js";
import { extensionContext } from "../support/fake-plugin.js";
import {
  enc,
  FAKE_SP,
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../support/harness.js";

interface Keys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account?: string }>;
}
const bin = await findNatsServerBinary();
const opKeys = JSON.parse(await readFile(identityFixture("operator/keys.json"), "utf8")) as Keys;
const userKeys = JSON.parse(await readFile(identityFixture("keys.json"), "utf8")) as Keys;
const ACME = opKeys.accounts["ACME"]!.public;
const ALICE = { account: ACME, user: opKeys.users["alice"]!.public };
const DAVE = { account: ACME, user: userKeys.users["dave"]!.public };

describe.skipIf(!bin)("grant requests for what OpenClaw published", () => {
  const server = new NatsServerProcess();
  const connections: NatsConnection[] = [];
  const services: AgentService[] = [];
  const clients: Agents[] = [];
  const state = mkdtempSync(join(tmpdir(), "fabric-oc-grants-"));
  const workspace = join(state, "scratchpad");
  const grants = `${workspace}.grants`;
  let harness: AgentService;
  let harnessPad: ScratchPadClient;
  let aliceTools: AgentTools;
  let aliceExt: ScratchPadExtension;
  let reader: AgentService;
  const readByDave: string[] = [];

  const as = async (user: string): Promise<{ nc: NatsConnection; signer: SenderSigner }> => {
    const creds = identityFixture(`operator/${user}.creds`);
    const nc = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(enc.encode(await readFile(creds, "utf8"))),
      reconnect: false,
    });
    connections.push(nc);
    return { nc, signer: await signerFromCredsFile(creds) };
  };
  const pad = (user: string, volume: string, creator?: string): ScratchPadClient => {
    const dir = join(state, `${user}-ws`);
    mkdirSync(dir, { recursive: true });
    return spCliScratchPad({
      bin: FAKE_SP,
      nats: { url: server.url, creds: identityFixture(`operator/${user}.creds`) },
      volume,
      dir: user === "carol" ? workspace : dir,
      ...(creator !== undefined ? { creator } : {}),
    });
  };
  // The grants sp was asked for, by grantee, as the stand-in logged them.
  const grantsTo = (grantee: { account: string; user: string }): string[][] =>
    readFileSync(join(state, "sp-calls.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
      .filter(
        (argv) =>
          argv[0] === "grant" &&
          argv[argv.indexOf("--grantee-account") + 1] === grantee.account &&
          argv[argv.indexOf("--grantee-user") + 1] === grantee.user,
      );
  // What `scripts/sp` appends after sp confirmed its grant to the caller.
  const recordGrantToAlice = (reference: string, expiresAt: number): void =>
    appendFileSync(grants, `${expiresAt} ${ALICE.account} ${ALICE.user} ${reference}\n`);

  beforeAll(async () => {
    process.env["FAKE_SP_STATE"] = join(state, "sp-state.json");
    process.env["FAKE_SP_LOG"] = join(state, "sp-calls.jsonl");
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    mkdirSync(workspace, { recursive: true });

    // --- OpenClaw, wired as the plugin wires it, started through the add-on --------
    const carol = await as("carol");
    const env: Record<string, string | undefined> = { SCRATCHPAD_BIN: FAKE_SP };
    const ext = createFabricExtension(extensionContext({ stateDir: state }), env, {
      url: server.url,
      creds: identityFixture("operator/carol.creds"),
      volume: "ocvol",
      dir: workspace,
      grants,
    });
    const harnessClient = new Agents({
      nc: carol.nc,
      identity: { signer: carol.signer },
      interceptors: ext.promptInterceptors!,
    });
    clients.push(harnessClient);
    const harnessTools = new AgentTools({
      agents: harnessClient,
      tools: BLOCKING_AGENT_TOOLS,
      selfAddress: "agents.prompt.oc.fabric.editor",
      extensions: ext.toolExtensions!,
    });
    harness = new AgentService({
      nc: carol.nc,
      agent: "oc",
      owner: "fabric",
      name: "editor",
      identity: { signer: carol.signer },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [...ext.requestInterceptors!, harnessTools.requestInterceptor],
      extraMetadata: { ...ext.metadata, cwd: "/work" },
    });
    services.push(harness);
    harness.onPrompt(async (_envelope, response) => {
      await response.send("oc-ok");
    });
    await harness.start();
    await ext.started!({ agents: harnessClient, service: harness });
    // OpenClaw's model, through scripts/sp: the same workspace, the same identity.
    harnessPad = pad("carol", "ocvol", harness.subject.prompt);

    // --- dave, a third agent that reads references ------------------------------
    const dave = await as("dave");
    const davePad = pad("dave", "davevol");
    reader = new AgentService({
      nc: dave.nc,
      agent: "fabric-r",
      owner: "fabric",
      name: "reader",
      identity: { signer: dave.signer },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      extraMetadata: { [READS_REFERENCES_KEY]: "true" },
    });
    reader.onPrompt(async (envelope, response) => {
      const ref = /sp-ref:[A-Za-z0-9_-]+/.exec(envelope.prompt)?.[0];
      let text = "no reference";
      if (ref !== undefined) {
        try {
          text = await davePad.read(ref, undefined);
        } catch (err) {
          text = `refused: ${String(err)}`;
        }
      }
      readByDave.push(text);
      await response.send(text);
    });
    services.push(reader);
    await reader.start();

    // --- alice, an SDK-built agent, OpenClaw's caller -------------------------------
    const alice = await as("alice");
    const aliceClient = new Agents({ nc: alice.nc, identity: { signer: alice.signer } });
    clients.push(aliceClient);
    aliceExt = scratchPadExtension({
      scratchPad: pad("alice", "alicevol"),
      agents: aliceClient,
      grantRequestTimeoutMs: 5_000,
    });
    aliceTools = new AgentTools({
      agents: aliceClient,
      tools: BLOCKING_AGENT_TOOLS,
      extensions: [aliceExt],
    });
  });

  afterAll(async () => {
    for (const client of clients) await client.close();
    for (const svc of services) await svc.stop();
    for (const nc of connections) await nc.close();
    await server.stop();
  });

  async function handOn(reference: string): Promise<AgentToolResult & Record<string, unknown>> {
    // OpenClaw's reply carried the reference to alice.
    aliceExt.remember(`done: ${reference}`);
    return aliceTools.execute("prompt_agent", {
      address: reader.subject.prompt,
      prompt: `what does it say? ${reference}`,
    });
  }

  it("grants the agent alice names, on request, and that agent reads what OpenClaw published", async () => {
    const reference = await harnessPad.commit(
      "The launch code is 4471.",
      "/out/code.txt",
      undefined,
    );
    recordGrantToAlice(reference, Math.floor(Date.now() / 1000) + 600);
    const result = await handOn(reference);
    expect(result).toMatchObject({ state: "completed", reply: "The launch code is 4471." });
    expect(result["references_removed"]).toBeUndefined();
    // One grant, to dave, on that reference, by the add-on's port.
    expect(grantsTo(DAVE).map((argv) => argv[argv.indexOf("--ref") + 1])).toEqual([reference]);
  });

  it("refuses when OpenClaw made no grant to alice on that reference: the reference is removed", async () => {
    const reference = await harnessPad.commit("Not for alice.", "/out/other.txt", undefined);
    const result = await handOn(reference);
    expect(result).toMatchObject({
      state: "completed",
      reply: "no reference",
      references_removed: 1,
    });
    expect(String(result["note"])).toContain("holds no live read grant");
    expect(grantsTo(DAVE)).toHaveLength(1);
  });

  it("refuses when OpenClaw's grant to alice has expired", async () => {
    const reference = await harnessPad.commit("Too late.", "/out/late.txt", undefined);
    recordGrantToAlice(reference, Math.floor(Date.now() / 1000) - 1);
    const result = await handOn(reference);
    expect(result).toMatchObject({ reply: "no reference", references_removed: 1 });
    expect(readByDave).not.toContain("Too late.");
  });
});
