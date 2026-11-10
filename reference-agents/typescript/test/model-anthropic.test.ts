// The model client on Anthropic's Messages API (MODEL_PROVIDER=anthropic):
// the conversation translated from the chat-completions shape and back, the
// request as it reaches the proxy, and the last round's tools. The proxy
// meters an Anthropic call only on /v1/messages, so this is what puts the
// agent's tokens and content on its thread.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
  anthropicCompletion,
  apiOf,
  anthropicRequest,
  converse,
  createModelClient,
  type ChatMessage,
  type CompleteOptions,
  type ModelClient,
  type ToolDefinitionLike,
} from "../src/model.js";

const TOOLS: ToolDefinitionLike[] = [
  {
    type: "function",
    function: {
      name: "prompt_agent",
      description: "Ask another agent.",
      parameters: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
    },
  },
];

describe("anthropicRequest", () => {
  it("puts the system prompt on top, the tool calls as tool_use, and a round's results in one user turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are under test." },
      { role: "user", content: "ask two agents" },
      {
        role: "assistant",
        content: "Asking both.",
        tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "prompt_agent", arguments: '{"address":"a"}' } },
          { id: "toolu_2", type: "function", function: { name: "prompt_agent", arguments: '{"address":"b"}' } },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: '{"state":"completed"}' },
      { role: "tool", tool_call_id: "toolu_2", content: '{"state":"completed"}' },
      { role: "user", content: "Your last answer was empty." },
    ];
    const body = anthropicRequest({ model: "claude-sonnet-5-5", maxTokens: 100, messages, tools: TOOLS, toolChoice: "auto" });
    expect(body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 100,
      system: "You are under test.",
      messages: [
        { role: "user", content: [{ type: "text", text: "ask two agents" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Asking both." },
            { type: "tool_use", id: "toolu_1", name: "prompt_agent", input: { address: "a" } },
            { type: "tool_use", id: "toolu_2", name: "prompt_agent", input: { address: "b" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: '{"state":"completed"}' },
            { type: "tool_result", tool_use_id: "toolu_2", content: '{"state":"completed"}' },
            { type: "text", text: "Your last answer was empty." },
          ],
        },
      ],
      tools: [
        {
          name: "prompt_agent",
          description: "Ask another agent.",
          input_schema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] },
        },
      ],
      tool_choice: { type: "auto" },
    });
  });

  it("sends an assistant message's own Anthropic blocks back unchanged, thinking included", () => {
    const blocks = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "tool_use", id: "toolu_1", name: "prompt_agent", input: { address: "a" } },
    ];
    const messages: ChatMessage[] = [
      { role: "user", content: "ask a" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "toolu_1", type: "function", function: { name: "prompt_agent", arguments: '{"address":"a"}' } }],
        anthropic_content: blocks,
      },
      { role: "tool", tool_call_id: "toolu_1", content: "done" },
    ];
    const body = anthropicRequest({ model: "m", maxTokens: 1, messages, tools: TOOLS, toolChoice: "auto" });
    expect((body["messages"] as { content: unknown }[])[1]).toEqual({ role: "assistant", content: blocks });
  });

  it("keeps the tools on an answer-only call and says none; with no tools, sends neither key", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const none = anthropicRequest({ model: "m", maxTokens: 1, messages, tools: TOOLS, toolChoice: "none" });
    expect(none["tool_choice"]).toEqual({ type: "none" });
    expect((none["tools"] as unknown[]).length).toBe(1);
    const bare = anthropicRequest({ model: "m", maxTokens: 1, messages, tools: [], toolChoice: "none" });
    expect(bare).not.toHaveProperty("tools");
    expect(bare).not.toHaveProperty("tool_choice");
    expect(bare).not.toHaveProperty("system");
  });

  it("leaves out text that is empty or only whitespace, and an empty tool result's content", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "  " },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: " \n",
        tool_calls: [{ id: "t1", type: "function", function: { name: "prompt_agent", arguments: "not json" } }],
      },
      { role: "tool", tool_call_id: "t1", content: "" },
    ];
    const body = anthropicRequest({ model: "m", maxTokens: 1, messages, tools: TOOLS, toolChoice: "auto" });
    expect(body).not.toHaveProperty("system");
    expect(body["messages"]).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "prompt_agent", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] },
    ]);
  });

  it("gives a tool without a schema, or with an empty one, the empty object schema", () => {
    const bare: ToolDefinitionLike[] = [
      { type: "function", function: { name: "ping" } },
      { type: "function", function: { name: "pong", parameters: {} } },
    ];
    const body = anthropicRequest({ model: "m", maxTokens: 1, messages: [{ role: "user", content: "x" }], tools: bare, toolChoice: "auto" });
    expect(body["tools"]).toEqual([
      { name: "ping", input_schema: { type: "object", properties: {} } },
      { name: "pong", input_schema: { type: "object", properties: {} } },
    ]);
  });

  it("takes JSON nulls as missing: blocks of null are rebuilt from the message, a schema of null is the empty one", () => {
    const messages = [
      { role: "user", content: "go" },
      { role: "assistant", content: "Hi.", anthropic_content: null },
    ] as unknown as ChatMessage[];
    const tools = [{ type: "function", function: { name: "ping", parameters: null } }] as unknown as ToolDefinitionLike[];
    const body = anthropicRequest({ model: "m", maxTokens: 1, messages, tools, toolChoice: "auto" });
    expect((body["messages"] as { content: unknown }[])[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "Hi." }] });
    expect(body["tools"]).toEqual([{ name: "ping", input_schema: { type: "object", properties: {} } }]);
  });

  it("leaves a whitespace-only text block out of the blocks it sends back, and keeps the rest as they came", () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const use = { type: "tool_use", id: "t1", name: "prompt_agent", input: {} };
    const messages: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: null, anthropic_content: [thinking, { type: "text", text: "\n\n" }, use] },
      { role: "tool", tool_call_id: "t1", content: "done" },
    ];
    const body = anthropicRequest({ model: "m", maxTokens: 1, messages, tools: TOOLS, toolChoice: "auto" });
    expect((body["messages"] as { content: unknown }[])[1]).toEqual({ role: "assistant", content: [thinking, use] });
  });
});

describe("anthropicCompletion", () => {
  it("joins the text, turns tool_use into tool calls, keeps every block, and counts the usage", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: "Asking " },
      { type: "text", text: "a." },
      { type: "tool_use", id: "toolu_9", name: "prompt_agent", input: { address: "a" } },
    ];
    const { message, usage } = anthropicCompletion({
      content,
      stop_reason: "tool_use",
      usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 20, output_tokens: 7 },
    });
    expect(message).toEqual({
      role: "assistant",
      content: "Asking a.",
      tool_calls: [{ id: "toolu_9", type: "function", function: { name: "prompt_agent", arguments: '{"address":"a"}' } }],
      anthropic_content: content,
    });
    expect(usage).toEqual({ prompt_tokens: 35, completion_tokens: 7, total_tokens: 42 });
  });

  it("gives null content when the reply has no text, so the loop sees an empty answer", () => {
    const { message } = anthropicCompletion({ content: [{ type: "thinking", thinking: "", signature: "s" }], stop_reason: "end_turn" });
    expect(message.content).toBeNull();
    expect(message.tool_calls).toBeUndefined();
  });

  it("fails on a refusal, naming its category", () => {
    expect(() =>
      anthropicCompletion({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }),
    ).toThrow("the model declined the request (refusal: cyber)");
    expect(() => anthropicCompletion({ content: [], stop_reason: "refusal", stop_details: null })).toThrow(
      "the model declined the request (refusal)",
    );
  });

  it("fails on a reply cut off at max_tokens, naming MODEL_MAX_TOKENS, whatever it holds", () => {
    for (const content of [[{ type: "thinking", thinking: "", signature: "s" }], [{ type: "text", text: "Half an ans" }], [{ type: "tool_use", id: "t", name: "prompt_agent", input: {} }]]) {
      expect(() => anthropicCompletion({ content, stop_reason: "max_tokens" })).toThrow(/raise MODEL_MAX_TOKENS/);
    }
  });

  it("fails when the conversation outgrew the context window", () => {
    expect(() => anthropicCompletion({ content: [], stop_reason: "model_context_window_exceeded" })).toThrow(/context window/);
  });

  it("takes a null usage as none", () => {
    expect(anthropicCompletion({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: null }).usage).toBeUndefined();
  });

  it("fails on a reply without content", () => {
    expect(() => anthropicCompletion({ error: { type: "overloaded_error" } })).toThrow("model reply carries no content");
  });
});

interface Seen {
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

/** A stand-in proxy on a free port: records each request and answers with the next scripted reply. */
async function standIn(replies: unknown[]): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(replies.shift() ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, server };
}

describe("createModelClient", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("with the provider anthropic, posts to /v1/messages with the virtual key, the version and the trace headers", async () => {
    const proxy = await standIn([{ content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }]);
    server = proxy.server;
    const client = createModelClient({ proxyUrl: proxy.url, virtualKey: "sk_syn_test", model: "claude-sonnet-5-5", provider: "anthropic" });
    expect(client.label).toContain("Anthropic's Messages API");
    const { message, usage } = await client.complete(
      [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
      TOOLS,
      { "X-Synadia-Thread-ID": "t".repeat(32), "X-Synadia-Root-ID": "r".repeat(32) },
    );
    expect(message.content).toBe("Hello.");
    expect(usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const [call] = proxy.seen;
    expect(call?.path).toBe("/v1/messages");
    expect(call?.headers["authorization"]).toBe("Bearer sk_syn_test");
    expect(call?.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    expect(call?.headers["x-synadia-thread-id"]).toBe("t".repeat(32));
    expect(call?.headers["x-synadia-root-id"]).toBe("r".repeat(32));
    expect(call?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: DEFAULT_MAX_TOKENS,
      system: "Be brief.",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tool_choice: { type: "auto" },
    });
  });

  it("sends maxTokens as max_tokens", async () => {
    const proxy = await standIn([{ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }]);
    server = proxy.server;
    const client = createModelClient({ proxyUrl: `${proxy.url}/`, virtualKey: "k", model: "m", provider: "anthropic", maxTokens: 512 });
    await client.complete([{ role: "user", content: "hi" }], [], {});
    expect(proxy.seen[0]?.body["max_tokens"]).toBe(512);
  });

  it("fails with the proxy's answer when the call fails", async () => {
    const failing = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unknown virtual key");
    });
    server = failing;
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    const { port } = failing.address() as AddressInfo;
    const client = createModelClient({ proxyUrl: `http://127.0.0.1:${port}`, virtualKey: "k", model: "m", provider: "anthropic" });
    await expect(client.complete([{ role: "user", content: "hi" }], [], {})).rejects.toThrow(
      "model call failed: 401 Unauthorized unknown virtual key",
    );
  });

  it("with any other provider, or none, stays on /v1/chat/completions and sends no tools on an answer-only call", async () => {
    const reply = { choices: [{ message: { role: "assistant", content: "ok" } }] };
    const proxy = await standIn([reply, reply]);
    server = proxy.server;
    for (const provider of [undefined, "openrouter"]) {
      const client = createModelClient({ proxyUrl: proxy.url, virtualKey: "k", model: "m", provider });
      await client.complete([{ role: "user", content: "hi" }], TOOLS, {}, { toolChoice: "none" });
    }
    expect(proxy.seen.map((s) => s.path)).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    for (const s of proxy.seen) {
      expect(s.body).not.toHaveProperty("tools");
      expect(s.body).not.toHaveProperty("max_tokens");
      expect(s.headers["anthropic-version"]).toBeUndefined();
    }
  });
});

describe("loadConfig: the provider and the token limit", () => {
  const env = { MODEL_PROXY_URL: "http://proxy", MODEL_VIRTUAL_KEY: "vk", MODEL_NAME: "m", NATS_CREDS: "/dev/null" };

  it("reads MODEL_PROVIDER trimmed and in lower case, and none when it is unset", () => {
    expect(loadConfig(env).model.provider).toBeUndefined();
    expect(loadConfig({ ...env, MODEL_PROVIDER: " Anthropic " }).model.provider).toBe("anthropic");
    expect(loadConfig({ ...env, MODEL_PROVIDER: "openrouter" }).model.provider).toBe("openrouter");
  });

  it("reads MODEL_MAX_TOKENS as a whole number above 0, and none when it is unset", () => {
    expect(loadConfig(env).model.maxTokens).toBeUndefined();
    expect(loadConfig({ ...env, MODEL_MAX_TOKENS: "512" }).model.maxTokens).toBe(512);
    expect(loadConfig({ ...env, MODEL_MAX_TOKENS: "16000.0" }).model.maxTokens).toBe(16000);
    for (const value of ["0", "-1", "2.5", "abc", " "]) {
      expect(() => loadConfig({ ...env, MODEL_MAX_TOKENS: value })).toThrow(/MODEL_MAX_TOKENS must be a whole number above 0/);
    }
  });

  it("names the API for the startup line", () => {
    expect(apiOf("anthropic")).toBe("Anthropic's Messages API");
    expect(apiOf("openrouter")).toBe("the OpenAI chat-completions API");
    expect(apiOf(undefined)).toBe("the OpenAI chat-completions API");
  });
});

describe("converse: no tool runs where none may", () => {
  const call: ChatMessage = {
    role: "assistant",
    content: "Words.",
    tool_calls: [{ id: "t1", type: "function", function: { name: "prompt_agent", arguments: '{"address":"a"}' } }],
  };
  const once = (message: ChatMessage): ModelClient => ({
    label: "scripted",
    async complete() {
      return { message, usage: undefined };
    },
  });

  it("on the answer-only round, a tool call in the reply is not run and the words are the reply", async () => {
    const ran: string[] = [];
    const result = await converse({
      model: once(call),
      tools: { definitions: TOOLS, call: async (name) => (ran.push(name), "{}") },
      messages: [{ role: "user", content: "go" }],
      traceHeaders: () => ({}),
      maxToolRounds: 0,
    });
    expect(ran).toEqual([]);
    expect(result).toEqual({ reply: "Words.", modelCalls: 1, toolCalls: 0 });
  });

  it("for an agent shown no tools, a tool call in the reply is not run", async () => {
    const ran: string[] = [];
    const result = await converse({
      model: once(call),
      tools: { definitions: [], call: async (name) => (ran.push(name), "{}") },
      messages: [{ role: "user", content: "go" }],
      traceHeaders: () => ({}),
    });
    expect(ran).toEqual([]);
    expect(result.reply).toBe("Words.");
  });
});

describe("converse on the last permitted round", () => {
  it("shows the model the same tools with toolChoice none, and takes its words", async () => {
    const options: (CompleteOptions | undefined)[] = [];
    const toolsSeen: number[] = [];
    const script: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "t1", type: "function", function: { name: "prompt_agent", arguments: '{"address":"a"}' } }],
      },
      { role: "assistant", content: "Done." },
    ];
    const model: ModelClient = {
      label: "scripted",
      async complete(_messages, tools, _headers, callOptions) {
        options.push(callOptions);
        toolsSeen.push(tools.length);
        const next = script.shift();
        if (next === undefined) throw new Error("called more often than scripted");
        return { message: next, usage: undefined };
      },
    };
    const result = await converse({
      model,
      tools: { definitions: TOOLS, call: async () => '{"state":"completed"}' },
      messages: [{ role: "user", content: "go" }],
      traceHeaders: () => ({}),
      maxToolRounds: 1,
    });
    expect(result).toEqual({ reply: "Done.", modelCalls: 2, toolCalls: 1 });
    expect(options).toEqual([{ toolChoice: "auto" }, { toolChoice: "none" }]);
    expect(toolsSeen).toEqual([1, 1]);
  });
});
