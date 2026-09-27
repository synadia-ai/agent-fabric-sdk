// ScratchPad in PI's registration and in PI's `prompt_agent`, on a real
// `AgentService` and `Agents` over a local nats-server in operator mode.
// PI (carol) is wired as the PI plugin wires it: the extension's
// `metadata` under the plugin's own registration keys, its request
// interceptors before the tools', its tool extensions on `AgentTools`. The
// ScratchPad behind the extension is an in-memory port, the one volume PI
// publishes into.
//
// Two receivers (alice): one that registers `scratchpad_refs_ok: "true"`,
// one that does not. A reference into PI's volume that PI's model puts into
// `prompt_agent` reaches the first with a first-hand grant, and the second
// without the reference, with a note; one that is neither PI's nor given to
// it is refused before anything is sent.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import {
  Agents,
  AgentTools,
  BLOCKING_AGENT_TOOLS,
  newAgentId,
  signerFromCredsFile,
  type AgentToolResult,
  type SenderSigner,
} from "@synadia-ai/agents";
import { READS_REFERENCES_KEY } from "@synadia-ai/agent-fabric";
import { createFabricExtension, type ScratchPadHandOn } from "../../src/index.js";
import { extensionContext } from "../support/fake-plugin.js";
import {
  enc,
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../support/harness.js";
import { makeReference, MemoryScratchPad } from "../support/scratchpad-fake.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}
const bin = await findNatsServerBinary();
const opKeys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const idOf = (user: string): string =>
  newAgentId(opKeys.accounts[opKeys.users[user]!.account]!.public, opKeys.users[user]!.public);
const ALICE_ID = idOf("alice");

const PI_ADDRESS = "agents.prompt.pi.fabric.editor";
const SETTINGS = { url: "nats://unused:4222", creds: "/unused.creds", volume: "PiVol" };

describe.skipIf(!bin)("ScratchPad for PI: the registration and the references PI hands on", () => {
  const server = new NatsServerProcess();
  const connections: NatsConnection[] = [];
  const services: AgentService[] = [];
  const clients: Agents[] = [];
  const env: Record<string, string | undefined> = {};
  const ext = createFabricExtension(extensionContext(), env, SETTINGS);
  const handOn = ext.toolExtensions![0] as ScratchPadHandOn;
  const volume = new MemoryScratchPad("PiVol");
  const seenByReader: string[] = [];
  const seenByPlain: string[] = [];
  let tools: AgentTools;
  let alice: { nc: NatsConnection; signer: SenderSigner };
  let reader: AgentService;
  let plain: AgentService;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
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
    alice = await as("alice");
    const carol = await as("carol");

    // --- PI, wired as the plugin wires it -----------------------------------
    const piClient = new Agents({
      nc: carol.nc,
      identity: { signer: carol.signer },
      interceptors: ext.promptInterceptors!,
    });
    clients.push(piClient);
    tools = new AgentTools({
      agents: piClient,
      tools: BLOCKING_AGENT_TOOLS,
      selfAddress: PI_ADDRESS,
      extensions: ext.toolExtensions!,
    });
    const pi = new AgentService({
      nc: carol.nc,
      agent: "pi",
      owner: "fabric",
      name: "editor",
      identity: { signer: carol.signer },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [...ext.requestInterceptors!, tools.requestInterceptor],
      // The extensions' keys under the plugin's own, as the plugin merges them.
      extraMetadata: { ...ext.metadata, cwd: "/work" },
    });
    services.push(pi);
    pi.onPrompt(async (_envelope, response) => {
      await response.send("pi-ok");
    });
    await pi.start();
    // The plugin calls `started()` with its client; the port here is the fake.
    handOn.start({ scratchPad: volume, agents: piClient });

    // --- the two receivers ----------------------------------------------------
    const receiver = (name: string, seen: string[], reads: boolean): AgentService => {
      const svc = new AgentService({
        nc: alice.nc,
        agent: "fabric-r",
        owner: "fabric",
        name,
        identity: { signer: alice.signer },
        heartbeatIntervalS: 30,
        keepaliveIntervalS: null,
        ...(reads ? { extraMetadata: { [READS_REFERENCES_KEY]: "true" } } : {}),
      });
      svc.onPrompt(async (envelope, response) => {
        seen.push(envelope.prompt);
        await response.send(`${name}-ok`);
      });
      services.push(svc);
      return svc;
    };
    reader = receiver("reader", seenByReader, true);
    plain = receiver("plain", seenByPlain, false);
    await reader.start();
    await plain.start();
  });

  afterAll(async () => {
    for (const client of clients) await client.close();
    for (const svc of services) await svc.stop();
    for (const nc of connections) await nc.close();
    await server.stop();
  });

  it("registers PI as reading references, so discovery says so", async () => {
    expect(ext.metadata).toEqual({ [READS_REFERENCES_KEY]: "true" });
    const caller = new Agents({ nc: alice.nc, identity: { signer: alice.signer } });
    clients.push(caller);
    const found = await caller.discover({ timeoutMs: 1_000 });
    const piEntry = found.find((a) => a.promptSubject === PI_ADDRESS);
    expect(piEntry?.metadata).toMatchObject({ [READS_REFERENCES_KEY]: "true", cwd: "/work" });
    expect(handOn.discoveryFields(piEntry!)).toEqual({ reads_scratchpad_references: true });
  });

  it("grants a receiver that reads references, first-hand, and sends it the reference", async () => {
    const reference = makeReference("PiVol", "/notes/1.txt", PI_ADDRESS);
    const result = (await tools.execute(
      "prompt_agent",
      { address: reader.subject.prompt, prompt: `the notes: ${reference}` },
      { toolCallId: "toolu_pi_ref_1" },
    )) as AgentToolResult & Record<string, unknown>;
    expect(result).toMatchObject({ state: "completed", reply: "reader-ok" });
    expect(result["references_removed"]).toBeUndefined();
    expect(seenByReader).toEqual([`the notes: ${reference}`]);
    expect(volume.grants).toEqual([
      expect.objectContaining({
        reference,
        grantee: ALICE_ID,
        kind: "first-hand",
        toolCallId: "toolu_pi_ref_1",
      }),
    ]);
  });

  it("takes the reference out for a receiver that does not read them, with a note, and grants nothing", async () => {
    const before = volume.grants.length;
    const reference = makeReference("PiVol", "/notes/2.txt", PI_ADDRESS);
    const result = (await tools.execute(
      "prompt_agent",
      { address: plain.subject.prompt, prompt: `the notes: ${reference}` },
      { toolCallId: "toolu_pi_ref_2" },
    )) as AgentToolResult & Record<string, unknown>;
    expect(result).toMatchObject({ state: "completed", reply: "plain-ok", references_removed: 1 });
    expect(String(result["note"])).toContain("does not read ScratchPad references");
    expect(seenByPlain).toEqual(["the notes:"]);
    expect(volume.grants).toHaveLength(before);
  });

  it("refuses a reference that is neither PI's nor given to it, sending nothing", async () => {
    const sent = seenByReader.length;
    const foreign = makeReference("SomeoneElsesVol", "/x.txt", "agents.prompt.x.fabric.other");
    const result = (await tools.execute("prompt_agent", {
      address: reader.subject.prompt,
      prompt: `look: ${foreign}`,
    })) as Record<string, unknown>;
    expect(String(result["error"])).toContain("is not one you were given");
    expect(seenByReader).toHaveLength(sent);
  });
});
