// The whole agent, with a fake model behind a fake proxy: what leaves the
// agent on the model side, and what it does with what comes back.
//
//   caller  — an SDK client with tracing on
//   agent   — `startAgent()` as `main.ts` would run it, pointed at the fake
//   target  — an agent that answers "pong: <prompt>" and reads references
//   asker   — an agent that asks its caller a question before it answers
//   fake    — an HTTP server on the proxy's path that plays the model: on a
//             prompt saying "delegate to <address>[: <text>]" it asks for
//             prompt_agent; on a tool result with a question it asks for
//             answer_agent, answering "yes"; on any other tool result it
//             answers with it; otherwise it answers plainly. A prompt that
//             starts "hush" makes it answer the question with nothing once,
//             then with answer_agent when told the call waits; "mute", with
//             nothing every time; "blank", with nothing to a plain prompt;
//             "use <tool>", a call to that tool with no arguments
//
//   pad     — a ScratchPad in memory, in place of the fabric package's one
//             over the `sp` command line (the package tests that one),
//             recording commits, reads and grants
//
// Asserted: the virtual key and the two trace headers on every model call,
// the served thread on those headers, the three blocking tools offered by
// default, the model's tool call carried out through prompt_agent with a
// child edge
// under the served thread, the tool result put back in front of the model,
// a question from the prompted agent put in front of the model and its
// answer_agent carried back, the reply to the caller, and the history on the
// next prompt. And ScratchPad: the reply committed and the verified caller
// granted read on it before the reference reaches it, a reference of the
// agent's own handed on with a grant to the prompted agent under the
// model's call, a handed-over reference read in front of the model, an
// unsigned caller given words only. And the grant request: the caller,
// granted the reply, asks the agent to let the target read it, and the
// agent's code does.

import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import {
  fabricTracing,
  READS_REFERENCES_KEY,
  requestGrant,
  type GrantKind,
  type Grantee,
  type ScratchPadClient,
  type TraceIds,
} from "@synadia-ai/agent-fabric";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, ServiceError, signerFromSeed } from "@synadia-ai/agents";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startAgent, type RunningAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { ChatMessage, ToolCall } from "../src/model.js";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

interface ModelRequest {
  readonly headers: IncomingMessage["headers"];
  readonly body: {
    readonly model: string;
    readonly messages: ChatMessage[];
    readonly tools?: { type: string; function: { name: string } }[];
  };
}

interface EdgeRecord {
  readonly thread_id: string;
  readonly parent_id: string | null;
  readonly root_id: string;
  readonly tool_call_id: string | null;
  readonly turn_count_hint: number;
}

const DELEGATE = /delegate to ([^\s:]+)(?:: (.*))?/;
const USE = /^use (\w+)/;

const binary = await natsServerOnPath();

// Tracing for the target and the caller, wired as the agent wires its own.
const tracing = fabricTracing();

describe.skipIf(binary === undefined)("the agent against a fake model behind a fake proxy", () => {
  let server: TestNatsServer;
  let fake: Server;
  let proxyUrl: string;
  let dir: string;
  let ncCaller: NatsConnection;
  let ncTarget: NatsConnection;
  let caller: Agents;
  let target: AgentService;
  let asker: AgentService;
  let agent: RunningAgent;
  let agentCreds: string;
  let cfg: AgentConfig;
  const requests: ModelRequest[] = [];
  const edges: { record: EdgeRecord; msg: Msg }[] = [];
  // What the asker was told when it asked.
  const answers: string[] = [];
  const callerUser = newUser();
  let targetSeed: string;

  // The agent's ScratchPad, in memory.
  const pad = {
    commits: [] as { text: string; path: string; trace: TraceIds | undefined }[],
    reads: [] as { reference: string; trace: TraceIds | undefined }[],
    grants: [] as { reference: string; grantee: Grantee; trace: TraceIds | undefined; toolCallId: string | undefined; kind: GrantKind }[],
    token(path: string): string {
      const made = { ref: { type: "handoff", handoff_id: "h", volume_id: "vol-agent", root: "r", path, expires_at: 9e9 }, source_sequence: 1 };
      return `sp-ref:${Buffer.from(JSON.stringify(made)).toString("base64url")}`;
    },
    async commit(text: string, path: string, trace: TraceIds | undefined): Promise<string> {
      pad.commits.push({ text, path, trace });
      return pad.token(path);
    },
    async read(reference: string, trace: TraceIds | undefined): Promise<string> {
      pad.reads.push({ reference, trace });
      return `the content behind ${reference.slice(0, 16)}`;
    },
    async owns(reference: string): Promise<boolean> {
      return reference.startsWith("sp-ref:") && Buffer.from(reference.slice(7), "base64url").toString().includes('"vol-agent"');
    },
    async grantRead(
      reference: string,
      grantee: Grantee,
      trace: TraceIds | undefined,
      toolCallId?: string,
      kind: GrantKind = "first-hand",
    ): Promise<void> {
      pad.grants.push({ reference, grantee, trace, toolCallId, kind });
    },
    granted(reference: string, grantee: Grantee): GrantKind | undefined {
      return pad.grants.find((g) => g.reference === reference && g.grantee.user === grantee.user)?.kind;
    },
  } satisfies ScratchPadClient & Record<string, unknown>;

  /** A reply's words, without the reference appended after them. */
  const words = (reply: string): string => reply.split("\n\nsp-ref:")[0]!;
  const reference = (reply: string): string | undefined => reply.match(/sp-ref:[A-Za-z0-9_-]+$/)?.[0];

  beforeAll(async () => {
    const [agentUser, targetUser] = [newUser(), newUser()];
    targetSeed = targetUser.seed;
    server = await TestNatsServer.start(binary!, [callerUser, agentUser, targetUser]);
    dir = await mkdtemp(join(tmpdir(), "fabric-examples-agent-"));
    // The agent reads its credentials from a file, as in production. A
    // bare seed file is one of the two forms the SDK accepts.
    agentCreds = join(dir, "agent.nk");
    await writeFile(agentCreds, `${agentUser.seed}\n`);

    const enc = new TextEncoder();
    const open = (seed: string): Promise<NatsConnection> =>
      connect({ servers: server.url, authenticator: nkeyAuthenticator(enc.encode(seed)) });
    [ncCaller, ncTarget] = await Promise.all([open(callerUser.seed), open(targetUser.seed)]);

    const sub = ncCaller.subscribe("TRACE.edges");
    void (async () => {
      for await (const msg of sub) edges.push({ record: JSON.parse(msg.string()) as EdgeRecord, msg });
    })();
    await ncCaller.flush();

    target = new AgentService({
      nc: ncTarget,
      agent: "echo",
      owner: "test",
      name: "target",
      interceptors: [tracing.requestInterceptor],
      identity: { signer: signerFromSeed(targetUser.seed) },
      keepaliveIntervalS: null,
      extraMetadata: { [READS_REFERENCES_KEY]: "true" },
    });
    target.onPrompt(async (envelope, response) => {
      await response.send(`pong: ${envelope.prompt}`);
    });
    await target.start();

    // An agent that asks before it answers, as a harness asks for a permission.
    asker = new AgentService({
      nc: ncTarget,
      agent: "asker",
      owner: "test",
      name: "target",
      interceptors: [tracing.requestInterceptor],
      identity: { signer: signerFromSeed(targetUser.seed) },
      keepaliveIntervalS: null,
    });
    asker.onPrompt(async (_envelope, response) => {
      const answer = await response.ask("may I read the file?", { timeoutMs: 5_000 });
      answers.push(answer.prompt);
      await response.send(`asked, and was told: ${answer.prompt}`);
    });
    await asker.start();

    // The fake model on the proxy's path. It records every request.
    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
      req.on("end", () => {
        const body = JSON.parse(raw) as ModelRequest["body"];
        requests.push({ headers: req.headers, body });
        const last = body.messages[body.messages.length - 1]!;
        const delegate = DELEGATE.exec(last.content ?? "");
        const use = USE.exec(last.content ?? "");
        // The prompt being served: the last user message that is not the loop's own word.
        const asked =
          [...body.messages]
            .reverse()
            .find((m) => m.role === "user" && !(m.content ?? "").startsWith("Your last answer was empty"))?.content ?? "";
        const silent = /^(hush|mute|blank) /.exec(asked)?.[1];
        let message: ChatMessage;
        if (last.role === "user" && (last.content ?? "").startsWith("Your last answer was empty")) {
          // Told that a call waits: "hush" answers it now, "mute" stays silent.
          const waiting = [...body.messages]
            .reverse()
            .map((m) => (m.role === "tool" ? (JSON.parse(m.content ?? "{}") as Record<string, string | undefined>) : {}))
            .find((r) => r["state"] === "input_required");
          if (silent === "hush" && waiting !== undefined) {
            const call: ToolCall = {
              id: "call_fake_3",
              type: "function",
              function: { name: "answer_agent", arguments: JSON.stringify({ call_id: waiting["call_id"], answer: "yes" }) },
            };
            message = { role: "assistant", content: "", tool_calls: [call] };
          } else {
            message = { role: "assistant", content: null };
          }
        } else if (last.role === "tool") {
          const result = JSON.parse(last.content ?? "{}") as Record<string, string | undefined>;
          if (result["state"] === "input_required" && silent !== undefined) {
            // The model that ends its turn with nothing while a call waits.
            message = { role: "assistant", content: null };
          } else if (result["state"] === "input_required") {
            const call: ToolCall = {
              id: "call_fake_2",
              type: "function",
              function: { name: "answer_agent", arguments: JSON.stringify({ call_id: result["call_id"], answer: "yes" }) },
            };
            message = { role: "assistant", content: "", tool_calls: [call] };
          } else {
            message = { role: "assistant", content: `they said: ${result["reply"] ?? result["error"] ?? last.content}` };
          }
        } else if (use !== null && body.tools?.length) {
          const call: ToolCall = { id: "call_fake_own", type: "function", function: { name: use[1]!, arguments: "{}" } };
          message = { role: "assistant", content: "", tool_calls: [call] };
        } else if (delegate !== null && body.tools?.length) {
          const call: ToolCall = {
            id: "call_fake_1",
            type: "function",
            function: {
              name: "prompt_agent",
              arguments: JSON.stringify({ address: delegate[1], prompt: delegate[2] ?? "ping" }),
            },
          };
          message = { role: "assistant", content: "", tool_calls: [call] };
        } else if (silent === "blank") {
          message = { role: "assistant", content: null };
        } else {
          message = { role: "assistant", content: `plain answer to: ${last.content}` };
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          }),
        );
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const addr = fake.address();
    if (addr === null || typeof addr === "string") throw new Error("no address");
    proxyUrl = `http://127.0.0.1:${addr.port}`;

    cfg = {
      nats: { url: server.url, nkey: agentCreds },
      agent: {
        kind: "assistant",
        owner: "test",
        name: "main",
        description: "the agent under test",
        systemPrompt: "You are under test.",
        minSenderTrust: "any",
        tools: "blocking",
        heartbeatIntervalS: undefined,
        maxHistoryExchanges: 20,
        readyFile: join(dir, "ready.json"),
      },
      model: { proxyUrl, virtualKey: "vk-test", model: "fake-1", timeoutMs: undefined },
      tools: { replyTimeoutMs: 10_000 },
    };
    agent = await startAgent(cfg, () => {}, { scratchpad: pad });

    caller = new Agents({
      nc: ncCaller,
      identity: { signer: signerFromSeed(callerUser.seed) },
      interceptors: [tracing.promptInterceptor],
    });
  });

  afterAll(async () => {
    await caller?.close();
    await agent?.stop();
    await target?.stop();
    await asker?.stop();
    await Promise.all([ncCaller?.close(), ncTarget?.close()]);
    await new Promise<void>((r) => fake?.close(() => r()));
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests.length = 0;
    edges.length = 0;
    answers.length = 0;
    pad.commits.length = 0;
    pad.reads.length = 0;
    pad.grants.length = 0;
  });

  async function prompt(text: string): Promise<string> {
    const [found] = await caller.discover({ filter: { agent: "assistant" }, timeoutMs: 500 });
    expect(found).toBeDefined();
    let reply = "";
    for await (const msg of await found!.prompt(text)) {
      if (msg.type === "response") reply += msg.text;
    }
    await ncCaller.flush();
    await new Promise((r) => setTimeout(r, 300));
    return reply;
  }

  /** The content of the `tool` message the request ends with, parsed. */
  function toolResult(req: ModelRequest): Record<string, unknown> {
    const last = req.body.messages[req.body.messages.length - 1]!;
    expect(last.role).toBe("tool");
    return JSON.parse(last.content ?? "") as Record<string, unknown>;
  }

  it("is on the fabric with a signed identity, says it reads references, and writes its ready file", async () => {
    expect(agent.address).toBe("agents.prompt.assistant.test.main");
    expect(agent.identity).toMatch(/\.U[A-Z2-7]{55}$/);
    // With ScratchPad, its registration says it reads what it is handed.
    const [found] = await caller.discover({ filter: { agent: "assistant" }, timeoutMs: 500 });
    expect(found!.metadata[READS_REFERENCES_KEY]).toBe("true");
    const ready = JSON.parse(await readFile(join(dir, "ready.json"), "utf8")) as Record<string, unknown>;
    expect(ready).toMatchObject({
      agent: "assistant",
      owner: "test",
      name: "main",
      subject: agent.address,
      instance_id: agent.instanceId,
      agent_id: agent.identity,
    });
  });

  it("calls the model through the proxy with its key, the served thread's two headers and the SDK's three blocking tools", async () => {
    const reply = await prompt("hello there");
    expect(words(reply)).toBe("plain answer to: hello there");
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.headers["authorization"]).toBe("Bearer vk-test");
    expect(req.body.model).toBe("fake-1");
    expect(req.body.tools?.map((t) => t.function.name)).toEqual(["discover_agents", "prompt_agent", "answer_agent"]);
    expect(req.body.tools?.every((t) => t.type === "function")).toBe(true);
    // The caller started the tree; the agent adopted its thread and stamped it.
    const root = edges.find((e) => e.record.parent_id === null)!;
    expect(root).toBeDefined();
    expect(req.headers["x-synadia-thread-id"]).toBe(root.record.thread_id);
    expect(req.headers["x-synadia-root-id"]).toBe(root.record.root_id);
  });

  it("carries out the model's prompt_agent call as a child thread and puts the result back in front of the model", async () => {
    const reply = await prompt(`please delegate to ${target.subject.prompt}`);
    expect(words(reply)).toBe("they said: pong: ping");
    expect(requests).toHaveLength(2);
    const [first, second] = requests as [ModelRequest, ModelRequest];
    // Both calls on the same served thread.
    expect(second.headers["x-synadia-thread-id"]).toBe(first.headers["x-synadia-thread-id"]);
    // The tool result went back as a `tool` message answering the model's call id.
    expect(second.body.messages[second.body.messages.length - 1]!.tool_call_id).toBe("call_fake_1");
    expect(toolResult(second)).toEqual({ call_id: expect.any(String), state: "completed", reply: "pong: ping" });
    // The child edge: under the served thread, named after the model's call,
    // spawned after one model call.
    const root = edges.find((e) => e.record.parent_id === null)!;
    const child = edges.find((e) => e.record.tool_call_id === "call_fake_1")!;
    expect(child).toBeDefined();
    expect(child.record.parent_id).toBe(root.record.thread_id);
    expect(child.record.root_id).toBe(root.record.root_id);
    expect(child.record.turn_count_hint).toBe(1);
    expect(first.headers["x-synadia-thread-id"]).toBe(root.record.thread_id);
  });

  it("remembers the conversation as words, not tool traffic, and names the tools an exchange used", async () => {
    await prompt("and one more");
    const req = requests[0]!;
    const roles = req.body.messages.map((m) => m.role);
    // system, then the two earlier exchanges as user/assistant pairs, then this prompt.
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(req.body.messages.some((m) => m.role === "tool" || m.tool_calls)).toBe(false);
    expect(req.body.messages[2]!.content).toBe("plain answer to: hello there");
    // The exchange that delegated says so, in one line: whom, not what.
    expect(req.body.messages[4]!.content).toBe(
      `[tools used: prompt_agent to ${target.subject.prompt}]\nthey said: pong: ping`,
    );
    expect(req.body.messages[4]!.content).not.toContain("call_");
  });

  it("keeps a history per verified caller: another caller's exchanges are not shown", async () => {
    const other = new Agents({
      nc: ncTarget,
      identity: { signer: signerFromSeed(targetSeed) },
      interceptors: [tracing.promptInterceptor],
    });
    try {
      const ask = async (text: string): Promise<void> => {
        const [found] = await other.discover({ filter: { agent: "assistant" }, timeoutMs: 500 });
        for await (const msg of await found!.prompt(text)) void msg;
      };
      await ask("first from the other caller");
      await ask("second from the other caller");
      const [first, second] = requests as [ModelRequest, ModelRequest];
      // Its first prompt comes with no history, though the caller above has one.
      expect(first.body.messages.map((m) => m.role)).toEqual(["system", "user"]);
      expect(second.body.messages.map((m) => m.content)).toEqual([
        "You are under test.",
        "first from the other caller",
        "plain answer to: first from the other caller",
        "second from the other caller",
      ]);
    } finally {
      await other.close();
    }
  });

  it("puts a question from the prompted agent in front of the model, and carries its answer_agent back", async () => {
    const reply = await prompt(`please delegate to ${asker.subject.prompt}`);
    expect(words(reply)).toBe("they said: asked, and was told: yes");
    expect(requests).toHaveLength(3);
    const [, second, third] = requests as [ModelRequest, ModelRequest, ModelRequest];
    // The question came back as the result of prompt_agent, with the call's id.
    const asked = toolResult(second);
    // While it waits for the answer the call is open, and the result says so.
    expect(asked).toEqual({
      call_id: expect.any(String),
      state: "input_required",
      question: "may I read the file?",
      open_calls: 1,
      open_calls_note: expect.stringMatching(/Calls end with the prompt you are answering/),
    });
    // The model's answer went to the asking agent, and the reply came back
    // as the result of answer_agent, for the same call.
    expect(answers).toEqual(["yes"]);
    expect(third.body.messages[third.body.messages.length - 1]!.tool_call_id).toBe("call_fake_2");
    expect(toolResult(third)).toEqual({
      call_id: asked["call_id"],
      state: "completed",
      reply: "asked, and was told: yes",
    });
    // One child thread, named after the call that started it.
    expect(edges.filter((e) => e.record.tool_call_id !== null).map((e) => e.record.tool_call_id)).toEqual(["call_fake_1"]);
  });

  it("asks the model again when it answers with nothing while a call waits on a question, and tells it what waits", async () => {
    const reply = await prompt(`hush delegate to ${asker.subject.prompt}: read the file`);
    expect(words(reply)).toBe("they said: asked, and was told: yes");
    expect(answers).toEqual(["yes"]);
    // prompt_agent, the empty answer, the word about the waiting call, answer_agent, the reply.
    expect(requests).toHaveLength(4);
    const told = requests[2]!.body.messages.at(-1)!;
    expect(told.role).toBe("user");
    expect(told.content).toContain(`to ${asker.subject.prompt} waits for an answer to "may I read the file?"`);
    expect(told.content).toContain("answer it with answer_agent");
  });

  it("fails the prompt, saying why, when the model keeps answering with nothing while a call waits", async () => {
    const failure = await prompt(`mute delegate to ${asker.subject.prompt}: read the file`).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ServiceError);
    const err = failure as ServiceError;
    expect(err.code).toBe(500);
    expect(err.message).toContain("the model returned an empty reply 3 times while 1 call it started was still open");
    expect(requests).toHaveLength(4);
    expect(pad.commits).toEqual([]);
  });

  it("fails the prompt, saying the model returned no reply, when it answers with nothing twice and nothing is open", async () => {
    const failure = await prompt("blank say something").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ServiceError);
    const err = failure as ServiceError;
    expect(err.code).toBe(500);
    expect(err.message).toContain("the model returned no reply: its answer was empty 2 times");
    // The empty answer, then the word asking for one, then the second empty answer.
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.messages.at(-1)!.content).toBe(
      "Your last answer was empty. Answer the prompt you are serving in words.",
    );
    expect(pad.commits).toEqual([]);
  });

  it("commits its reply, grants the verified caller read on it, and only then appends the reference", async () => {
    const reply = await prompt("a plain question");
    const root = edges.find((e) => e.record.parent_id === null)!;
    // Committed under the served thread's name, on the served thread.
    expect(pad.commits).toHaveLength(1);
    expect(pad.commits[0]).toMatchObject({
      text: "plain answer to: a plain question",
      path: `/replies/${root.record.thread_id}.md`,
    });
    expect(pad.commits[0]!.trace?.threadId).toBe(root.record.thread_id);
    // One grant, first-hand, to the caller's verified identity, on that reference.
    expect(pad.grants).toHaveLength(1);
    expect(pad.grants[0]!.reference).toBe(pad.token(`/replies/${root.record.thread_id}.md`));
    expect(pad.grants[0]!.grantee.user).toBe(callerUser.publicKey);
    expect(pad.grants[0]!.trace?.threadId).toBe(root.record.thread_id);
    expect(pad.grants[0]!.kind).toBe("first-hand");
    // The reference the caller got is the one the grant is on.
    expect(reference(reply)).toBe(pad.grants[0]!.reference);
  });

  it("hands a reference of its own on to the prompted agent, with a read grant under the model's call", async () => {
    // The caller hands the agent one of its earlier replies, by reference.
    const own = pad.token("/replies/earlier.md");
    const reply = await prompt(`please delegate to ${target.subject.prompt}: read ${own}`);
    expect(words(reply)).toBe(`they said: pong: read ${own}`);
    const root = edges.find((e) => e.record.parent_id === null)!;
    // The grant to the target came before the prompt, first-hand, on the
    // served thread, named after the model's call; then the caller's grant
    // on the new reply.
    expect(pad.grants).toHaveLength(2);
    expect(pad.grants[0]).toMatchObject({ reference: own, toolCallId: "call_fake_1", kind: "first-hand" });
    expect(`${pad.grants[0]!.grantee.account}.${pad.grants[0]!.grantee.user}`).toBe(target.identity);
    expect(pad.grants[0]!.trace?.threadId).toBe(root.record.thread_id);
    expect(pad.grants[1]!.grantee.user).toBe(callerUser.publicKey);
  });

  it("answers a grant request about its reply in code: the caller it granted asks for the target", async () => {
    const reply = await prompt("something worth handing on");
    const handed = reference(reply)!;
    const before = requests.length;
    const answer = await requestGrant(caller, agent.address, { reference: handed, grantee: target.identity! });
    expect(answer).toEqual({ granted: true });
    // The agent made the grant itself, to the target; its model was not asked.
    // Its record says which grant it made of its own accord and which on request.
    expect(pad.grants.map((g) => g.grantee.user)).toEqual([callerUser.publicKey, target.identity!.split(".")[1]]);
    expect(pad.grants.map((g) => g.kind)).toEqual(["first-hand", "on-request"]);
    expect(pad.grants[1]!.reference).toBe(handed);
    expect(requests).toHaveLength(before);
    // Someone it never granted that reference to is refused.
    const other = new Agents({ nc: ncTarget, identity: { signer: signerFromSeed(targetSeed) } });
    try {
      pad.grants.length = 1;
      expect(await requestGrant(other, agent.address, { reference: handed, grantee: `$G.${callerUser.publicKey}` })).toEqual({
        granted: false,
        reason: expect.stringMatching(/no live read grant/),
      });
      expect(pad.grants).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("reads what it was handed by reference and puts the content in front of the model", async () => {
    const token = pad.token("/replies/theirs.md");
    await prompt(`summarise ${token}`);
    expect(pad.reads.map((r) => r.reference)).toEqual([token]);
    // The latest user message: the history holds the earlier prompts too.
    const user = [...requests[0]!.body.messages].reverse().find((m) => m.role === "user")!;
    expect(user.content).toContain(`summarise ${token}`);
    expect(user.content).toContain(`--- content handed over as ${token} ---\nthe content behind sp-ref:`);
  });

  it("gives an unsigned caller the reply in words only: no grant, no reference", async () => {
    const unsigned = new Agents({ nc: ncCaller, interceptors: [tracing.promptInterceptor] });
    try {
      const [found] = await unsigned.discover({ filter: { agent: "assistant" }, timeoutMs: 500 });
      let reply = "";
      for await (const msg of await found!.prompt("hello, anonymously")) {
        if (msg.type === "response") reply += msg.text;
      }
      expect(reply).toBe("plain answer to: hello, anonymously");
      expect(pad.commits).toHaveLength(1);
      expect(pad.grants).toHaveLength(0);
      // And no history: an unsigned claim names no caller to keep one for.
      expect(requests[0]!.body.messages.map((m) => m.role)).toEqual(["system", "user"]);
    } finally {
      await unsigned.close();
    }
  });

  it("offers its own tools after the agent tools, and with AGENT_TOOLS=none only them, and runs the model's call", async () => {
    const own = {
      name: "read_lines",
      description: "The state of the plant's lines.",
      parameters: { type: "object", properties: {} },
      run: async () => ({ lines: [{ id: 1, state: "running" }] }),
    };
    const sensors = await startAgent(
      { ...cfg, agent: { ...cfg.agent, kind: "sensors", tools: "none", readyFile: undefined } },
      () => {},
      { scratchpad: pad, ownTools: [own] },
    );
    try {
      const [found] = await caller.discover({ filter: { agent: "sensors" }, timeoutMs: 500 });
      let reply = "";
      for await (const msg of await found!.prompt("use read_lines")) {
        if (msg.type === "response") reply += msg.text;
      }
      expect(requests.map((r) => r.body.tools?.map((t) => t.function.name))).toEqual([["read_lines"], ["read_lines"]]);
      expect(toolResult(requests[1]!)).toEqual({ lines: [{ id: 1, state: "running" }] });
      expect(words(reply)).toBe(`they said: ${JSON.stringify({ lines: [{ id: 1, state: "running" }] })}`);
    } finally {
      await sensors.stop();
    }
  });

  it("refuses to start with an own tool named like an agent tool, or two own tools with one name", async () => {
    const tool = (name: string) => ({ name, description: "", parameters: {}, run: async () => ({}) });
    await expect(startAgent(cfg, () => {}, { scratchpad: pad, ownTools: [tool("prompt_agent")] })).rejects.toThrow(
      'own tool "prompt_agent" has the name of an agent tool',
    );
    await expect(startAgent(cfg, () => {}, { scratchpad: pad, ownTools: [tool("stop_line"), tool("stop_line")] })).rejects.toThrow(
      'two own tools are named "stop_line"',
    );
  });
});
