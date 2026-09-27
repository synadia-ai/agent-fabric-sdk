// ScratchPad in PI's registration, on a real `AgentService` over a local
// nats-server in operator mode. PI (carol) is wired as the PI plugin wires
// it: the extension's `metadata` under the plugin's own registration keys.
// A caller (alice) discovers PI and sees that it reads references.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, signerFromCredsFile, type SenderSigner } from "@synadia-ai/agents";
import { READS_REFERENCES_KEY } from "@synadia-ai/agent-fabric";
import { createFabricExtension } from "../../src/index.js";
import { extensionContext } from "../support/fake-plugin.js";
import {
  enc,
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../support/harness.js";

const bin = await findNatsServerBinary();

const PI_ADDRESS = "agents.prompt.pi.fabric.editor";
const SETTINGS = { url: "nats://unused:4222", creds: "/unused.creds", volume: "PiVol" };

describe.skipIf(!bin)("ScratchPad for PI: the registration", () => {
  const server = new NatsServerProcess();
  const connections: NatsConnection[] = [];
  const services: AgentService[] = [];
  const clients: Agents[] = [];
  const env: Record<string, string | undefined> = {};
  const ext = createFabricExtension(extensionContext(), env, SETTINGS);
  let alice: { nc: NatsConnection; signer: SenderSigner };

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

    const pi = new AgentService({
      nc: carol.nc,
      agent: "pi",
      owner: "fabric",
      name: "editor",
      identity: { signer: carol.signer },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [...ext.requestInterceptors!],
      // The extensions' keys under the plugin's own, as the plugin merges them.
      extraMetadata: { ...ext.metadata, cwd: "/work" },
    });
    services.push(pi);
    pi.onPrompt(async (_envelope, response) => {
      await response.send("pi-ok");
    });
    await pi.start();
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
    expect(piEntry?.idSigVerified).toBe(true);
    expect(piEntry?.metadata).toMatchObject({ [READS_REFERENCES_KEY]: "true", cwd: "/work" });
  });
});
