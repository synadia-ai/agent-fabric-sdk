// The agent tools as the agent wires them, tested on a real nats-server:
// five parties on one server, each with its own user key, the way agents
// sit in one account.
//
//   caller  — an SDK client with tracing on; it prompts `host` and so
//             starts a tree (a root edge, parent null)
//   host    — the agent under test, wired as `agent.ts` wires it: the SDK's
//             `AgentTools` with the fabric package's ScratchPad extension,
//             the three request interceptors in the agent's order, and the
//             grant endpoint. Its prompt handler does what a model loop
//             would: one model call's worth of trace headers, then the tool
//             call the prompt names, through `toolRunner()`
//   target  — an agent that answers "pong: <prompt>", accepts signed
//             prompts only, and says it reads ScratchPad references
//   leaf    — a signed agent that does not say so, as PI does not: it gets
//             the text without the references
//   creator — an agent that handed the host a reference into its own
//             volume, and answers grant requests about it
//
// What is asserted is the whole point of the tools on the fabric: the edge
// `prompt_agent` writes from inside the served prompt names the served
// thread as its parent, the tree root as its root and the model's tool-call
// id. And the grant that goes with a handed-over reference: to the target's
// verified identity, under the served thread and the tool call, before the
// prompt goes out; no reference, nor a grant, for an agent that does not
// read references; no reference this agent was not given, exactly as it
// came. And for a reference the host did not create: the creator is asked
// and makes the grant itself, or the reference comes out and the text goes
// alone. The rules are the fabric package's and tested there line by line;
// here they are tested through the agent's wiring.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  fabricTracing,
  grantRequestEndpoint,
  granteeFromIdentity,
  READS_REFERENCES_KEY,
  scratchPadExtension,
  traceHeaders,
  type GrantKind,
  type Grantee,
  type ScratchPad,
  type ScratchPadExtension,
  type TraceIds,
} from "@synadia-ai/agent-fabric";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, AgentSubject, AgentTools, signerFromSeed } from "@synadia-ai/agents";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BLOCKING_TOOLS, chatTools, offeredTools, toolRunner, type ChatTool } from "../src/tools.js";
import { createModelClient, type ToolRunner } from "../src/model.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

// The contract's own files, in the SDK checkout this repository links: the
// definitions a model reads and the shapes of what comes back.
const CONTRACT_DIR = new URL("../../../../synadia-agents/test-fixtures/agent-tools/", import.meta.url);
const contract = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(name, CONTRACT_DIR), "utf8")) as Record<string, unknown>;

// Strict, with two of Ajv's opinions set aside: union types
// (`["string", "null"]`) and a `required` inside `oneOf` naming a property
// declared one level up are both what the draft allows and the contract's
// schemas do.
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, strictRequired: false });
const validDiscoverResult = ajv.compile(contract("discover_agents.result.json"));
const validCallResult = ajv.compile(contract("prompt_agent.result.json"));

const TOOL_NAMES = ["discover_agents", "prompt_agent", "wait_agent", "answer_agent", "cancel_agent", "list_agent_calls"];

// The definitions a helper that offers `names` shows its model, derived
// from the contract's files by its rule (section 5): those tools' files,
// in the contract's order. Without `wait_agent`, each loses its `wait`
// parameter, and a description that mentions `wait_agent` is replaced by
// its words in `blocking.json`. Nothing else changes.
const derived = (names: ReadonlyArray<string>): Record<string, unknown>[] => {
  const blocking = contract("blocking.json") as Record<string, string>;
  return TOOL_NAMES.filter((name) => names.includes(name)).map((name) => {
    const definition = contract(`${name}.json`) as { description: string; parameters: { properties: object } };
    if (names.includes("wait_agent")) return definition;
    delete (definition.parameters.properties as Record<string, unknown>)["wait"];
    return { ...definition, description: blocking[name] ?? definition.description };
  });
};

describe("the tool definitions", () => {
  // Definitions need no connection: the helper hands out its own copy.
  const byDefault = new AgentTools({ agents: {} as Agents, tools: offeredTools("blocking") });
  const all = new AgentTools({ agents: {} as Agents, tools: offeredTools("all") });

  it.each(["blocking", "all"] as const)("serializes explicit non-strict Chat Completions tools for %s", async (setting) => {
    const tools = new AgentTools({ agents: {} as Agents, tools: offeredTools(setting) });
    const original = structuredClone(tools.definitions);
    const requests: { url: string | undefined; body: { tools: ChatTool[] } }[] = [];
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const model = createModelClient({
        proxyUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/api`,
        virtualKey: "test-key",
        model: "test-model",
        timeoutMs: 3000,
      });
      await model.complete([{ role: "user", content: "hello" }], toolRunner(tools).definitions, {});
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe("/api/v1/chat/completions");
      expect(requests[0]!.body.tools).toEqual(
        original.map((definition) => ({ type: "function", function: { ...definition, strict: false } })),
      );
      expect(tools.definitions).toEqual(original);
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("are by default the SDK's three blocking ones, in the shape a chat-completions request carries, not a word changed", () => {
    const offered = chatTools(byDefault);
    expect(offered.map((t) => t.function.name)).toEqual(["discover_agents", "prompt_agent", "answer_agent"]);
    expect(offered.map((t) => t.function.name)).toEqual(BLOCKING_TOOLS);
    expect(offered.every((t) => t.type === "function")).toBe(true);
    // Word for word what the contract derives for the three: nothing to
    // detach with, so no `wait`, and no word of a tool not offered.
    expect(offered.map((t) => t.function)).toEqual(derived(BLOCKING_TOOLS).map((d) => ({ ...d, strict: false })));
    expect(JSON.stringify(offered)).not.toMatch(/wait_agent|cancel_agent|list_agent_calls|"wait"/);
    expect(toolRunner(byDefault).definitions).toEqual(offered);
  });

  it("are the SDK's six with AGENT_TOOLS=all, word for word the contract's files", () => {
    const offered = chatTools(all);
    expect(offered.map((t) => t.function.name)).toEqual(TOOL_NAMES);
    for (const tool of offered) {
      expect(tool.type).toBe("function");
      expect(tool.function).toEqual({ ...contract(`${tool.function.name}.json`), strict: false });
    }
    expect(offered.map((t) => t.function)).toEqual(derived(TOOL_NAMES).map((d) => ({ ...d, strict: false })));
  });

  it("have parameter schemas that compile under draft 2020-12 and admit nothing unknown", () => {
    for (const tools of [byDefault, all]) {
      for (const tool of chatTools(tools)) {
        const validate = ajv.compile(tool.function.parameters);
        expect(tool.function.parameters["additionalProperties"]).toBe(false);
        expect(validate({ unknown: 1 })).toBe(false);
      }
      const prompt = ajv.compile(chatTools(tools).find((t) => t.function.name === "prompt_agent")!.function.parameters);
      const discover = ajv.compile(chatTools(tools).find((t) => t.function.name === "discover_agents")!.function.parameters);
      expect(discover({})).toBe(true);
      expect(discover({ agent: "researcher" })).toBe(true);
      expect(discover({ agent: null })).toBe(false);
      expect(prompt({ address: "agents.prompt.echo.test.target", prompt: "hi" })).toBe(true);
      expect(prompt({ address: "agents.prompt.echo.test.target" })).toBe(false);
      expect(prompt({ address: "agents.prompt.echo.test.target", prompt: "" })).toBe(false);
    }
    // Only the six take `wait: false`.
    const promptOf = (tools: AgentTools) =>
      ajv.compile(chatTools(tools).find((t) => t.function.name === "prompt_agent")!.function.parameters);
    const detached = { address: "agents.prompt.echo.test.target", prompt: "hi", wait: false };
    expect(promptOf(all)(detached)).toBe(true);
    expect(promptOf(byDefault)(detached)).toBe(false);
  });
});

interface EdgeRecord {
  readonly version: number;
  readonly kind: string;
  readonly record_id: string;
  readonly ts: number;
  readonly agent: string;
  readonly thread_id: string;
  readonly parent_id: string | null;
  readonly root_id: string;
  readonly tool_call_id: string | null;
  readonly turn_count_hint: number;
}

const binary = await natsServerOnPath();

// Tracing as every agent here wires it: the request interceptor on each
// service, the prompt interceptor on each client that prompts.
const tracing = fabricTracing();

describe.skipIf(binary === undefined)("the agent tools on a fabric", () => {
  let server: TestNatsServer;
  let ncCaller: NatsConnection;
  let ncHost: NatsConnection;
  let ncTarget: NatsConnection;
  let ncCreator: NatsConnection;
  let caller: Agents;
  let targetClient: Agents;
  let hostClient: Agents;
  let host: AgentService;
  let target: AgentService;
  let leaf: AgentService;
  let creator: AgentService;
  let tools: AgentTools;
  let references: ScratchPadExtension;
  let runner: ToolRunner;
  // The host's ScratchPad, as the extension sees it: a record of every
  // grant it made. References listed in `theirs` are the creator's.
  type GrantCall = { reference: string; grantee: Grantee; trace: TraceIds | undefined; toolCallId: string | undefined };
  const grants: GrantCall[] = [];
  const theirs = new Set<string>();
  const pad: ScratchPad = {
    owns: (reference) => !theirs.has(reference),
    grantRead(reference, grantee, trace, toolCallId) {
      grants.push({ reference, grantee, trace, toolCallId });
    },
    granted: () => undefined,
  };
  // The creator's ScratchPad: its ledger says whether it granted the host
  // first-hand, and it records the grants it makes on request.
  const creatorGrants: (GrantCall & { kind: GrantKind | undefined })[] = [];
  let creatorGrantedHost = true;
  const creatorPad: ScratchPad = {
    owns: (reference) => theirs.has(reference),
    granted: () => (creatorGrantedHost ? "first-hand" : undefined),
    grantRead(reference, grantee, trace, toolCallId, kind) {
      creatorGrants.push({ reference, grantee, trace, toolCallId, kind });
    },
  };
  /** A token as the agent at `creatorAddress` would hand it over, into its own volume. */
  function handedBy(creatorAddress: string | undefined, path: string): string {
    const made = {
      ref: { type: "handoff", handoff_id: "h", volume_id: "vol-creator", root: "r", path, expires_at: 9e9 },
      source_sequence: 1,
      ...(creatorAddress !== undefined ? { creator: creatorAddress } : {}),
    };
    const token = `sp-ref:${Buffer.from(JSON.stringify(made)).toString("base64url")}`;
    theirs.add(token);
    return token;
  }
  // Every edge record published on the fabric, with the message it came in.
  const edges: { record: EdgeRecord; msg: Msg }[] = [];
  // What the host's handler saw as its own thread, as a model call would.
  let served: Record<string, string> = {};

  beforeAll(async () => {
    const [callerUser, hostUser, targetUser, creatorUser] = [newUser(), newUser(), newUser(), newUser()];
    server = await TestNatsServer.start(binary!, [callerUser, hostUser, targetUser, creatorUser]);
    const enc = new TextEncoder();
    const open = (seed: string): Promise<NatsConnection> =>
      connect({ servers: server.url, authenticator: nkeyAuthenticator(enc.encode(seed)) });
    [ncCaller, ncHost, ncTarget, ncCreator] = await Promise.all([
      open(callerUser.seed),
      open(hostUser.seed),
      open(targetUser.seed),
      open(creatorUser.seed),
    ]);

    // Watch the edges before anyone prompts. `TRACE.edges` is the short
    // form an agent publishes to; on a real fabric the account's import
    // carries it into the AFO account.
    const sub = ncCaller.subscribe("TRACE.edges");
    void (async () => {
      for await (const msg of sub) {
        edges.push({ record: JSON.parse(msg.string()) as EdgeRecord, msg });
      }
    })();
    await ncCaller.flush();

    // The target: answers, accepts signed prompts only, reads references.
    target = new AgentService({
      nc: ncTarget,
      agent: "echo",
      owner: "test",
      name: "target",
      description: "Answers pong",
      interceptors: [tracing.requestInterceptor],
      identity: { signer: signerFromSeed(targetUser.seed) },
      minSenderTrust: "signed",
      keepaliveIntervalS: null,
      extraMetadata: { [READS_REFERENCES_KEY]: "true" },
    });
    target.onPrompt(async (envelope, response) => {
      traceHeaders();
      // One prompt gets a reference back, as a reply committed to ScratchPad would.
      if (envelope.prompt === "hand me a reference") await response.send("here it is: sp-ref:GIVENBACK");
      else await response.send(`pong: ${envelope.prompt}`);
    });
    await target.start();
    // The target's own client, for the one test where it prompts the host.
    targetClient = new Agents({ nc: ncTarget, identity: { signer: signerFromSeed(targetUser.seed) } });

    // A signed agent that does not say it reads references, like a harness.
    leaf = new AgentService({
      nc: ncTarget,
      agent: "leaf",
      owner: "test",
      name: "target",
      interceptors: [tracing.requestInterceptor],
      identity: { signer: signerFromSeed(targetUser.seed) },
      keepaliveIntervalS: null,
    });
    leaf.onPrompt(async (envelope, response) => {
      await response.send(`leaf: ${envelope.prompt}`);
    });
    await leaf.start();

    // The creator: never prompted here. It is on the fabric with a verified
    // identity, and answers grant requests next to its prompt address.
    const creatorAddress = AgentSubject.new("creator", "test", "main").prompt;
    creator = new AgentService({
      nc: ncCreator,
      agent: "creator",
      owner: "test",
      name: "main",
      interceptors: [tracing.requestInterceptor],
      identity: { signer: signerFromSeed(creatorUser.seed) },
      keepaliveIntervalS: null,
      extraMetadata: { [READS_REFERENCES_KEY]: "true" },
      extraEndpoints: [grantRequestEndpoint({ promptAddress: creatorAddress, scratchPad: creatorPad })],
    });
    creator.onPrompt(async (_envelope, response) => {
      await response.send("the creator is not prompted in these tests");
    });
    await creator.start();

    // The host, wired as `agent.ts` wires the agent.
    const hostAddress = AgentSubject.new("host", "test", "main").prompt;
    hostClient = new Agents({
      nc: ncHost,
      identity: { signer: signerFromSeed(hostUser.seed) },
      interceptors: [tracing.promptInterceptor],
    });
    references = scratchPadExtension({ scratchPad: pad, agents: hostClient });
    tools = new AgentTools({
      agents: hostClient,
      tools: offeredTools("blocking"),
      selfAddress: hostAddress,
      discoverTimeoutMs: 500,
      extensions: [references],
    });
    runner = toolRunner(tools);
    host = new AgentService({
      nc: ncHost,
      agent: "host",
      owner: "test",
      name: "main",
      interceptors: [tracing.requestInterceptor, tools.requestInterceptor, references.requestInterceptor],
      identity: { signer: signerFromSeed(hostUser.seed) },
      keepaliveIntervalS: null,
      extraMetadata: { [READS_REFERENCES_KEY]: "true" },
      extraEndpoints: [grantRequestEndpoint({ promptAddress: hostAddress, scratchPad: pad })],
    });
    host.onPrompt(async (envelope, response) => {
      // One model call happened here; its headers carry the served thread.
      served = traceHeaders();
      // The model asked for one tool call, which the prompt names, its
      // arguments as the wire carries them: a JSON string, and a tool-call
      // id of the model's choosing.
      const { name, args } = JSON.parse(envelope.prompt) as { name: string; args: unknown };
      await response.send(await runner.call(name, JSON.stringify(args), "call_test_1"));
    });
    await host.start();

    caller = new Agents({
      nc: ncCaller,
      identity: { signer: signerFromSeed(callerUser.seed) },
      interceptors: [tracing.promptInterceptor],
    });
  });

  afterAll(async () => {
    await tools?.close();
    await caller?.close();
    await targetClient?.close();
    await hostClient?.close();
    await host?.stop();
    await target?.stop();
    await leaf?.stop();
    await creator?.stop();
    await Promise.all([ncCaller?.close(), ncHost?.close(), ncTarget?.close(), ncCreator?.close()]);
    await server?.stop();
  });

  beforeEach(() => {
    edges.length = 0;
    grants.length = 0;
    creatorGrants.length = 0;
    creatorGrantedHost = true;
    served = {};
  });

  // Edges go out before the prompts they announce; give the last one a
  // moment to arrive after the reply has.
  async function settle(): Promise<void> {
    await ncHost.flush();
    await new Promise((r) => setTimeout(r, 300));
  }

  // A tool call made from inside a prompt the host serves, as the model
  // makes it: the tools run in that prompt's scope and trace.
  async function viaHost(name: string, args: unknown, from: Agents = caller): Promise<Record<string, unknown>> {
    const [found] = await from.discover({ filter: { agent: "host" }, timeoutMs: 500 });
    let reply = "";
    for await (const msg of await found!.prompt(JSON.stringify({ name, args }))) {
      if (msg.type === "response") reply += msg.text;
    }
    await settle();
    return JSON.parse(reply) as Record<string, unknown>;
  }

  // A tool call made outside any served prompt.
  async function direct(name: string, args: unknown): Promise<Record<string, unknown>> {
    return JSON.parse(await runner.call(name, args, "call_direct")) as Record<string, unknown>;
  }

  it("prompt_agent from inside a served prompt hangs the child under the served thread", async () => {
    const result = await viaHost("prompt_agent", { address: target.subject.prompt, prompt: "ping" });
    expect(validCallResult(result), JSON.stringify(validCallResult.errors)).toBe(true);
    expect(result).toEqual({ call_id: expect.any(String), state: "completed", reply: "pong: ping" });

    const root = edges.find((e) => e.record.parent_id === null);
    const child = edges.find((e) => e.record.tool_call_id === "call_test_1");
    expect(edges).toHaveLength(2);
    expect(root).toBeDefined();
    expect(child).toBeDefined();

    // The caller's edge announced the tree; the host adopted its thread.
    expect(root!.record.thread_id).toBe(served["X-Synadia-Thread-ID"]);
    expect(root!.record.root_id).toBe(served["X-Synadia-Root-ID"]);
    expect(root!.record.turn_count_hint).toBe(0);

    // The host's edge: a child of the served thread, in the same tree,
    // named after the model's tool call, written by the host, after one
    // model call.
    expect(child!.record.kind).toBe("edge");
    expect(child!.record.parent_id).toBe(root!.record.thread_id);
    expect(child!.record.root_id).toBe(root!.record.root_id);
    expect(child!.record.thread_id).not.toBe(root!.record.thread_id);
    expect(child!.record.agent).toBe(host.identity);
    expect(child!.record.turn_count_hint).toBe(1);

    // Signed, and one id for the body, the header and the message.
    expect(child!.msg.headers?.get("Agent-Sender")).not.toBe("");
    expect(child!.msg.headers?.get("Nats-Msg-Id")).toBe(child!.record.record_id);
  });

  it("prompt_agent grants the target read on every reference of the host's own in the prompt, then sends it", async () => {
    // The references arrive in the prompt the host serves, so they were given to it.
    const result = await viaHost("prompt_agent", { address: target.subject.prompt, prompt: "read sp-ref:AAA and sp-ref:BBB" });
    expect(result).toEqual({ call_id: expect.any(String), state: "completed", reply: "pong: read sp-ref:AAA and sp-ref:BBB" });
    // One grant per reference, to the identity discovery reported for the
    // address, under the served thread, named after the model's call.
    expect(grants.map((g) => g.reference)).toEqual(["sp-ref:AAA", "sp-ref:BBB"]);
    for (const g of grants) {
      expect(g.grantee).toEqual(granteeFromIdentity(target.identity!));
      expect(g.toolCallId).toBe("call_test_1");
      expect(g.trace?.threadId).toBe(served["X-Synadia-Thread-ID"]);
      expect(g.trace?.rootId).toBe(served["X-Synadia-Root-ID"]);
    }
    expect(edges.filter((e) => e.record.tool_call_id === "call_test_1")).toHaveLength(1);
  });

  it("prompt_agent asks the creator of a reference the host did not create, and the creator grants the target", async () => {
    const token = handedBy(creator.subject.prompt, "/replies/findings.md");
    const result = await viaHost("prompt_agent", { address: target.subject.prompt, prompt: `write from ${token}` });
    // The reference travels as it came: nothing was copied.
    expect(result).toMatchObject({ state: "completed", reply: `pong: write from ${token}` });
    // The host granted nothing; the creator did, on request, to the
    // target's verified identity, labelled with the host's served thread
    // and the model's call.
    expect(grants).toHaveLength(0);
    expect(creatorGrants).toHaveLength(1);
    expect(creatorGrants[0]).toMatchObject({
      reference: token,
      grantee: granteeFromIdentity(target.identity!),
      toolCallId: "call_test_1",
      kind: "on-request",
    });
    expect(creatorGrants[0]!.trace?.threadId).toBe(served["X-Synadia-Thread-ID"]);
    expect(creatorGrants[0]!.trace?.rootId).toBe(served["X-Synadia-Root-ID"]);
  });

  it("prompt_agent sends the text without a reference its creator will not grant on, and says so", async () => {
    creatorGrantedHost = false;
    const token = handedBy(creator.subject.prompt, "/replies/findings.md");
    references.remember(`${token} sp-ref:AAA`);
    const result = await direct("prompt_agent", { address: target.subject.prompt, prompt: `write from sp-ref:AAA and\n${token}` });
    expect(validCallResult(result), JSON.stringify(validCallResult.errors)).toBe(true);
    // The host's own reference went with its grant; the other one came out.
    expect(result).toEqual({
      call_id: expect.any(String),
      state: "completed",
      reply: "pong: write from sp-ref:AAA and",
      references_removed: 1,
      note: expect.stringMatching(/1 reference.*removed.*only the text.*its creator did not grant.*no live read grant/),
    });
    expect(grants.map((g) => g.reference)).toEqual(["sp-ref:AAA"]);
    expect(creatorGrants).toHaveLength(0);
  });

  it("prompt_agent sends a non-reader the text without the references, grants nothing, and says so", async () => {
    references.remember("sp-ref:AAA");
    const result = await direct("prompt_agent", { address: leaf.subject.prompt, prompt: "edit this: some text\n\nsp-ref:AAA" });
    expect(validCallResult(result), JSON.stringify(validCallResult.errors)).toBe(true);
    expect(result).toEqual({
      call_id: expect.any(String),
      state: "completed",
      reply: "leaf: edit this: some text",
      references_removed: 1,
      note: expect.stringMatching(/does not read ScratchPad references: 1 reference.*removed.*only the text.*nothing was granted/),
    });
    expect(grants).toHaveLength(0);
    // A prompt that was nothing but references is not sent at all. (The one
    // above went out from outside a served prompt, so its edge is a root's.)
    await settle();
    edges.length = 0;
    expect(await direct("prompt_agent", { address: leaf.subject.prompt, prompt: " sp-ref:AAA \n" })).toEqual({
      error: expect.stringMatching(/not sent.*does not read ScratchPad references.*nothing but references/),
    });
    await settle();
    expect(edges).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  it("prompt_agent hands over only a reference the host was given, exactly as it came", async () => {
    // Never given: an invented token, or a given one with a character changed.
    references.remember("sp-ref:AAA");
    for (const prompt of ["read sp-ref:NEVERGIVEN", "read sp-ref:AAB"]) {
      const refused = await direct("prompt_agent", { address: target.subject.prompt, prompt });
      expect(validCallResult(refused), JSON.stringify(validCallResult.errors)).toBe(true);
      expect(refused).toEqual({
        error: expect.stringMatching(/not sent.*not one you were given.*Copy each reference exactly/),
      });
    }
    expect(grants).toHaveLength(0);
    await settle();
    expect(edges).toHaveLength(0);
    // Given in a reply prompt_agent brought back: it may be handed on.
    expect(await direct("prompt_agent", { address: target.subject.prompt, prompt: "hand me a reference" })).toMatchObject({
      reply: "here it is: sp-ref:GIVENBACK",
    });
    expect(await direct("prompt_agent", { address: target.subject.prompt, prompt: "read sp-ref:GIVENBACK" })).toMatchObject({
      state: "completed",
      reply: "pong: read sp-ref:GIVENBACK",
    });
    expect(grants.map((g) => g.reference)).toEqual(["sp-ref:GIVENBACK"]);
  });

  it("prompt_agent never prompts the host's own address, nor the agent that sent the prompt it serves", async () => {
    expect(await direct("prompt_agent", { address: AgentSubject.new("host", "test", "main").prompt, prompt: "hi" })).toEqual({
      error: expect.stringMatching(/your own address; answer the prompt yourself/),
    });
    // The target prompts the host, whose model then tries to prompt the target back.
    const result = await viaHost("prompt_agent", { address: target.subject.prompt, prompt: "please do my task" }, targetClient);
    expect(result).toEqual({
      error: expect.stringMatching(/sent the prompt you are answering; answer it rather than prompting it back/),
    });
    expect(edges).toHaveLength(0);
  });

  it("discover_agents lists the others with the contract's fields and whether each reads references, never the host itself", async () => {
    const result = (await direct("discover_agents", {})) as { agents: Record<string, unknown>[] };
    expect(validDiscoverResult(result), JSON.stringify(validDiscoverResult.errors)).toBe(true);
    const addresses = result.agents.map((a) => a["address"]);
    expect(addresses).toContain(target.subject.prompt);
    expect(addresses).not.toContain(host.subject.prompt);
    expect(result.agents.find((a) => a["address"] === target.subject.prompt)).toEqual({
      address: target.subject.prompt,
      agent: "echo",
      owner: "test",
      name: "target",
      description: "Answers pong",
      identity: target.identity,
      identity_verified: true,
      requires_signed_prompts: true,
      accepts_attachments: true,
      instances: 1,
      reads_scratchpad_references: true,
    });
    expect(result.agents.find((a) => a["address"] === leaf.subject.prompt)).toMatchObject({
      identity_verified: true,
      reads_scratchpad_references: false,
    });
    // Discovery writes nothing to the log.
    await settle();
    expect(edges).toHaveLength(0);
  });

  it("tells the model in words about an unknown tool, bad arguments or an address nobody answers at, and writes no edge", async () => {
    expect(await direct("open_pod_bay_doors", {})).toEqual({ error: 'unknown tool "open_pod_bay_doors"' });
    expect(await direct("prompt_agent", "{not json")).toEqual({ error: expect.stringContaining("not valid JSON") });
    expect(await direct("prompt_agent", { prompt: "no address" })).toEqual({
      error: expect.stringContaining('"address" is required'),
    });
    const nobody = await direct("prompt_agent", { address: "agents.prompt.nobody.test.main", prompt: "hello?" });
    expect(validCallResult(nobody), JSON.stringify(validCallResult.errors)).toBe(true);
    expect(nobody).toEqual({ error: expect.stringContaining("no agent answers at") });
    // No file of this host's at the model's word: the agent names no
    // attachment root, so only files other agents sent back may be sent on.
    expect(await direct("prompt_agent", { address: target.subject.prompt, prompt: "hi", attachments: ["package.json"] })).toEqual({
      error: expect.stringMatching(/outside the directories you may send files from/),
    });
    await settle();
    expect(edges).toHaveLength(0);
  });

  it("reports a refusal instead of throwing: an unsigned caller on a signed-only agent", async () => {
    const unsigned = new Agents({ nc: ncCaller });
    const unsignedTools = new AgentTools({ agents: unsigned, discoverTimeoutMs: 500 });
    try {
      const result = JSON.parse(
        await toolRunner(unsignedTools).call("prompt_agent", JSON.stringify({ address: target.subject.prompt, prompt: "ping" }), "c"),
      ) as Record<string, unknown>;
      expect(validCallResult(result), JSON.stringify(validCallResult.errors)).toBe(true);
      expect(result).toEqual({ error: expect.stringMatching(/not sent.*requires a signed Agent-Sender header/) });
    } finally {
      await unsignedTools.close();
      await unsigned.close();
    }
  });
});
