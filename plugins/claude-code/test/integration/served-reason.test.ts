// How a prompt ended, on the wire: the plugin's reason on `promptEnded`
// goes on the `served` record's `end` as `reason`, version 2. A real
// `AgentService` over a local nats-server in operator mode, wired as the
// Claude Code channel's MCP server wires it, its handler standing in for
// Claude Code as the plugin behaves when the model never calls `reply`:
//
//   - the turn stops with final text: the plugin sends that text as the
//     reply at the turn's `Stop` and ends the prompt `ok` with `final_text`.
//     The add-on settles at once — no later `Stop` is waited for;
//   - the turn stops with no text: the plugin ends the prompt with `500`,
//     `error` with `no_reply`.
//
// Each `end` validates against `served.json` and verifies as Claude Code's.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { AgentService, RequestRejectedError } from "@synadia-ai/agent-service";
import {
  Agents,
  newAgentId,
  signerFromCredsFile,
  verifySender,
  type SenderSigner,
} from "@synadia-ai/agents";
import { fabricTracing, type ServedRequest } from "@synadia-ai/agent-fabric";
import { createFabricExtension } from "../../src/index.js";
import { extensionContext, recordingLogger } from "../support/fake-plugin.js";
import {
  enc,
  findNatsServerBinary,
  handleOf,
  identityFixture,
  NatsServerProcess,
  parse,
  servedSchemaErrors,
  sleep,
} from "../support/harness.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}
const bin = await findNatsServerBinary();
const opKeys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const CAROL_ID = newAgentId(
  opKeys.accounts[opKeys.users["carol"]!.account]!.public,
  opKeys.users["carol"]!.public,
);
const SESSION = "0b5e7c0e-3f0a-4c55-9d0e-8b2f6a1d4c21";
const FINAL_TEXT = "the answer, written as plain text";

describe.skipIf(!bin)("Claude Code on the fabric: a turn that ends without a reply", () => {
  const server = new NatsServerProcess();
  const connections: NatsConnection[] = [];
  const clients: Agents[] = [];
  let service: AgentService | undefined;
  const { logger } = recordingLogger();
  const ext = createFabricExtension(extensionContext({ logger }), {});
  const trace: Msg[] = [];
  const answers: Record<string, string[]> = {};
  const failures: Record<string, string> = {};
  const stoppedAt: Record<string, number> = {};

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
    const alice = await as("alice");
    const carol = await as("carol");
    const observer = await as("alice");

    const ccClient = new Agents({
      nc: carol.nc,
      identity: { signer: carol.signer },
      interceptors: ext.promptInterceptors!,
    });
    clients.push(ccClient);
    let nextId = 0;
    service = new AgentService({
      nc: carol.nc,
      agent: "cc",
      owner: "team",
      name: "claude",
      identity: { signer: carol.signer },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [...ext.requestInterceptors!],
      heartbeatExtras: ext.heartbeatExtras!,
    });
    service.onPrompt(async (envelope, response) => {
      const served: ServedRequest = Object.freeze({
        id: String(++nextId),
        extras: Object.freeze({ ...(envelope.extras ?? {}) }),
        sessionId: SESSION,
      });
      ext.events!.promptAccepted!(served);
      // The model works, writes plain text and stops; the plugin's hook
      // refuses the first stop, and the turn stops again without reply.
      await sleep(50);
      const at = Date.now();
      stoppedAt[envelope.prompt] = at;
      ext.events!.turnStopped!(SESSION, at);
      if (envelope.prompt === "final_text") {
        await response.send(FINAL_TEXT);
        ext.events!.promptEnded!(served, "ok", at, "final_text");
        return;
      }
      ext.events!.promptEnded!(served, "error", at, "no_reply");
      throw new RequestRejectedError(
        500,
        "the Claude Code turn ended without a reply to this prompt",
      );
    });
    await service.start();
    await ext.started!({ agents: ccClient, service });
    ext.events!.sessionStarted!(SESSION, "startup");

    const sub = observer.nc.subscribe("TRACE.edges");
    void (async () => {
      for await (const msg of sub) trace.push(msg);
    })();
    await observer.nc.flush();

    const a = new Agents({
      nc: alice.nc,
      identity: { signer: alice.signer },
      interceptors: [fabricTracing().promptInterceptor],
    });
    clients.push(a);
    const toCc = await handleOf(a, service);
    for (const prompt of ["final_text", "no_reply"]) {
      answers[prompt] = [];
      try {
        for await (const m of await toCc.prompt(prompt)) {
          if (m.type === "response") answers[prompt].push(m.text);
        }
      } catch (err) {
        failures[prompt] = err instanceof Error ? err.message : String(err);
      }
    }
    // No further Stop, no stopping: whatever ended, ended by itself.
    await sleep(500);
  });

  afterAll(async () => {
    await ext.stopping!();
    for (const client of clients) await client.close();
    await service?.stop();
    for (const nc of connections) await nc.close();
    await server.stop();
  });

  const ends = (): Array<Record<string, unknown>> =>
    trace.map(parse).filter((r) => r["kind"] === "served" && r["phase"] === "end");

  it("the caller gets the final text, and the other prompt the 500", () => {
    expect(answers["final_text"]).toEqual([FINAL_TEXT]);
    expect(failures["final_text"]).toBeUndefined();
    expect(failures["no_reply"]).toMatch(/without a reply/);
  });

  it("ends each with the plugin's reason as version 2, at the turn's stop, without waiting", () => {
    const records = ends();
    expect(records.map((r) => [r["version"], r["status"], r["reason"]])).toEqual([
      [2, "ok", "final_text"],
      [2, "error", "no_reply"],
    ]);
    expect(records[0]!["ts"]).toBe(Math.floor(stoppedAt["final_text"]! / 1000));
    expect(records[1]!["ts"]).toBe(Math.floor(stoppedAt["no_reply"]! / 1000));
  });

  it("keeps start at version 1, and every record valid and signed as Claude Code", async () => {
    const served = trace.filter((m) => parse(m)["kind"] === "served");
    expect(served).toHaveLength(4);
    for (const msg of served) {
      const record = parse(msg);
      if (record["phase"] === "start") {
        expect(record["version"]).toBe(1);
        expect("reason" in record).toBe(false);
      }
      expect(servedSchemaErrors(record)).toEqual([]);
      const sender = await verifySender(msg, "stored");
      expect(sender?.trust === "verified" ? sender.id : undefined).toBe(CAROL_ID);
    }
  });
});
