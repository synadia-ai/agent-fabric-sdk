// Actual service handlers and signed/unsigned SDK callers; only model and ScratchPad are external stubs.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { fabricTracing, type Grantee, type GrantKind, type ScratchPadClient } from "@synadia-ai/agent-fabric";
import { Agents, signerFromSeed } from "@synadia-ai/agents";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startAgent } from "../src/agent.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

const cases = JSON.parse(readFileSync(new URL("../../test-fixtures/reply-delivery.json", import.meta.url), "utf8"));
const reference: string = JSON.parse(readFileSync(new URL("../../../test-fixtures/scratchpad/reference-v2.json", import.meta.url), "utf8")).token;
const binary = await natsServerOnPath();
if (binary === undefined) throw new Error("bounded reply behavior tests require nats-server");

describe("bounded reply through actual agent", () => {
  const callerUser = newUser(), agentUser = newUser();
  let server: TestNatsServer, model: Server, nc: NatsConnection, dir: string, creds: string, modelURL: string;
  let modelReply = "";
  const requests: { messages: { role: string; content: string }[] }[] = [];
  let signed: Agents, unsigned: Agents;

  beforeAll(async () => {
    server = await TestNatsServer.start(binary!, [callerUser, agentUser]);
    dir = await mkdtemp(join(tmpdir(), "bounded-replies-"));
    creds = join(dir, "agent.nk");
    await writeFile(creds, agentUser.seed, { mode: 0o600 });
    nc = await connect({ servers: server.url, authenticator: nkeyAuthenticator(new TextEncoder().encode(callerUser.seed)) });
    const tracing = fabricTracing();
    signed = new Agents({ nc, identity: { signer: signerFromSeed(callerUser.seed) }, interceptors: [tracing.promptInterceptor] });
    unsigned = new Agents({ nc, interceptors: [tracing.promptInterceptor] });
    model = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "bounded-model", object: "chat.completion", model: "fixture",
          choices: [{ index: 0, message: { role: "assistant", content: modelReply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    const address = model.address();
    if (address === null || typeof address === "string") throw new Error("model address missing");
    modelURL = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await signed?.close(); await unsigned?.close(); await nc?.close();
    await new Promise<void>((resolve) => model?.close(() => resolve()));
    await server?.stop(); await rm(dir, { recursive: true, force: true });
  });

  for (const item of cases) {
    it(item.name, async () => {
      const text = item.unit.repeat(item.repeat) + item.suffix;
      const commits: string[] = [], grants: Grantee[] = [];
      const failure = "PRIVATE_PROVIDER_ERROR" + "e".repeat(100000);
      const pad: ScratchPadClient = {
        async commit(value) { commits.push(value); if (item.mode === "publish-failure") throw new Error(failure); return reference; },
        async read() { throw new Error("unexpected read"); },
        async owns() { return true; },
        async grantRead(_reference, grantee) { if (item.mode === "grant-failure") throw new Error(failure); grants.push(grantee); },
        granted(): GrantKind | undefined { return undefined; },
      };
      const agent = await startAgent({ nats: { url: server.url, nkey: creds },
        agent: { kind: "delivery", owner: "test", name: "main", description: "bounded delivery test",
          systemPrompt: "test", minSenderTrust: "any", tools: "none", heartbeatIntervalS: undefined,
          maxHistoryExchanges: 2, readyFile: undefined },
        model: { proxyUrl: modelURL, virtualKey: "fixture", model: "fixture", timeoutMs: 5000 },
        tools: { replyTimeoutMs: 5000 } }, () => {}, { env: {}, ...(item.mode === "absent" ? {} : { scratchpad: pad }) });
      try {
        const caller = item.mode === "unsigned" ? unsigned : signed;
        const [found] = await caller.discover({ filter: { agent: "delivery" }, timeoutMs: 200 });
        expect(found?.idSigVerified).toBe(true);
        async function prompt(): Promise<string> {
          let value = "";
          for await (const message of await found!.prompt("short input", { maxWaitMs: 5000 })) {
            if (message.type === "response") value += message.text;
          }
          return value;
        }
        requests.length = 0; modelReply = text;
        const reply = await prompt();
        expect(commits).toEqual(item.mode === "absent" ? [] : [text]);
        expect(grants).toHaveLength(item.mode === "granted" ? 1 : 0);
        if (grants.length) expect(grants[0]!.user).toBe(callerUser.publicKey);
        if (item.large) {
          expect(Buffer.byteLength(reply)).toBeLessThan(1024);
          expect(reply).not.toContain(text);
          expect(reply).toContain(String(item.bytes));
          expect(reply).not.toContain("PRIVATE_PROVIDER_ERROR");
          if (item.mode === "granted") expect(reply).toBe(`Result stored in ScratchPad (${item.bytes} UTF-8 bytes). Read the granted reference to retrieve it.\n\n${reference}`);
          else { expect(reply).toMatch(/^Delivery refused:/); expect(reply).not.toContain("sp-ref:"); }
        } else expect(reply).toBe(text + (item.mode === "granted" ? `\n\n${reference}` : ""));
        modelReply = "next";
        await prompt();
        expect(requests).toHaveLength(2);
        // An unsigned caller is kept no history.
        expect(requests[1]!.messages.filter(m => m.role === "assistant").map(m => m.content))
          .toEqual(item.mode === "unsigned" ? [] : [item.large ? reply : text]);
      } finally { await agent.stop(); }
    });
  }
});
