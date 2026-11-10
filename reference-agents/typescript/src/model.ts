// model.ts — one model client pointed at the fabric's proxy, and the loop
// that runs the model's tool calls.
//
// The agent never talks to a model provider. It talks to the proxy with its
// virtual key, and the proxy resolves the key to a provider (Ollama on a
// laptop, OpenRouter, OpenAI, Anthropic) and records the call on the agent's
// thread. The agent holds four things: the proxy's URL, its virtual key, a
// model name, and the provider behind the key. Two headers on every call,
// `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` from the fabric package's
// `traceHeaders()`, tell the proxy which thread the call belongs to; the
// proxy sees no NATS traffic, so nothing else about the tree has to reach it.
//
// Two APIs, picked by the provider. Anthropic is called on its own Messages
// API (`/v1/messages`), because that is where the proxy reads an Anthropic
// call's tokens and content; every other provider on the OpenAI
// chat-completions API (`/v1/chat/completions`). The loop below speaks the
// chat-completions shape either way: the Anthropic client translates on the
// way out and back.
//
// One request, one JSON reply, no streaming: a tool-calling loop is easiest
// to read that way, and the host SDK keeps the caller's stream alive with
// acks while the loop runs.

export type Role = "system" | "user" | "assistant" | "tool";

/** One tool call the model asked for, as the OpenAI shape carries it. */
export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    /** A JSON string, as the wire carries it. The tool parses it. */
    readonly arguments: string;
  };
}

export interface ChatMessage {
  readonly role: Role;
  readonly content: string | null;
  readonly tool_calls?: readonly ToolCall[];
  /** On a `tool` message: the id of the call this message answers. */
  readonly tool_call_id?: string;
  /**
   * On an assistant message from Anthropic's Messages API: the reply's
   * content blocks as the API returned them, its thinking blocks included.
   * They go back unchanged while the turn's tool loop runs, because the API
   * checks a replayed thinking block against the conversation that produced
   * it. The chat-completions client never sets it.
   */
  readonly anthropic_content?: readonly unknown[];
}

export interface Usage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly total_tokens?: number;
}

export interface Completion {
  readonly message: ChatMessage;
  readonly usage: Usage | undefined;
}

/** A tool definition as the request carries it; `tools.ts` supplies them. */
export interface ToolDefinitionLike {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    /** The arguments' JSON Schema, an object schema. */
    readonly parameters?: Readonly<Record<string, unknown>>;
  };
}

/** The provider whose own API the client speaks; every other provider gets chat completions. */
export const ANTHROPIC_PROVIDER = "anthropic";

/** The Messages API version the Anthropic client asks for. */
export const ANTHROPIC_VERSION = "2026-10-21";

/**
 * Anthropic's `max_tokens`, which its API requires, when `MODEL_MAX_TOKENS`
 * sets none: room for a long answer without streaming. Thinking counts
 * toward it.
 */
export const DEFAULT_MAX_TOKENS = 16_000;


/** Which API the client speaks for a provider, as the startup line says it. */
export function apiOf(provider: string | undefined): string {
  return provider === ANTHROPIC_PROVIDER ? "Anthropic's Messages API" : "the OpenAI chat-completions API";
}

export interface ModelClientOptions {
  /**
   * The proxy's root URL. `/v1/chat/completions` is appended, or
   * `/v1/messages` for Anthropic; for OpenRouter the root ends in `/api`.
   */
  readonly proxyUrl: string;
  /** Issued through the console, resolved by the proxy to a provider. Never in a file this repo tracks. */
  readonly virtualKey: string;
  /** The model name the provider behind the key understands, for example `llama3.1:8b`, `openai/gpt-4o-mini` or `claude-sonnet-5-5`. */
  readonly model: string;
  /**
   * The provider the virtual key names (`MODEL_PROVIDER`): `anthropic`
   * selects Anthropic's Messages API; any other value, or none, the OpenAI
   * chat-completions API.
   */
  readonly provider?: string | undefined;
  /** Anthropic's `max_tokens`; default {@link DEFAULT_MAX_TOKENS}. A chat-completions call sends none. */
  readonly maxTokens?: number | undefined;
  /**
   * Per call. A local model on a laptop can take a while; default two
   * minutes. Stated honestly, it has two ceilings: Node's fetch gives up on
   * a reply whose headers take more than five minutes; and a durable run's
   * work between two waits must end within the engine's max work (five
   * minutes by default): the step in flight when it passes is run again,
   * and a call longer than it never ends.
   */
  readonly timeoutMs?: number | undefined;
}

/** How one call may use the tools it is shown. */
export interface CompleteOptions {
  /**
   * `auto`, the default: the model may call the tools. `none`: it has to
   * answer in words. The chat-completions client then sends no tools at
   * all; the Anthropic client sends the same tools with `tool_choice`
   * `none`, since a change to the tools would invalidate the thinking blocks
   * already in the conversation.
   */
  readonly toolChoice?: "auto" | "none";
}

export interface ModelClient {
  /** For log lines: the model and where the calls go. */
  readonly label: string;
  /**
   * One model call. `headers` are merged into the request; the agent passes
   * the fabric package's `traceHeaders()` here, once per call.
   */
  complete(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinitionLike[],
    headers: Record<string, string>,
    options?: CompleteOptions,
  ): Promise<Completion>;
}

export function createModelClient(options: ModelClientOptions): ModelClient {
  return options.provider === ANTHROPIC_PROVIDER ? anthropicClient(options) : chatCompletionsClient(options);
}

function rootOf(proxyUrl: string): string {
  return proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`;
}

async function failed(res: Response): Promise<Error> {
  const text = (await res.text()).slice(0, 300);
  return new Error(`model call failed: ${res.status} ${res.statusText} ${text}`.trim());
}

function chatCompletionsClient(options: ModelClientOptions): ModelClient {
  const endpoint = new URL("v1/chat/completions", rootOf(options.proxyUrl));
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    label: `${options.model} through ${endpoint.host}`,
    async complete(messages, tools, headers, callOptions) {
      const offered = callOptions?.toolChoice === "none" ? [] : tools;
      const body = {
        model: options.model,
        messages,
        // No `tools` key at all when there are none: some providers reject
        // an empty list.
        ...(offered.length > 0 ? { tools: offered } : {}),
        stream: false,
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.virtualKey}`,
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw await failed(res);
      const reply = (await res.json()) as {
        choices?: { message?: ChatMessage }[];
        usage?: Usage;
      };
      const message = reply.choices?.[0]?.message;
      if (message === undefined) throw new Error("model reply carries no choices[0].message");
      return { message, usage: reply.usage };
    },
  };
}

function anthropicClient(options: ModelClientOptions): ModelClient {
  const endpoint = new URL("v1/messages", rootOf(options.proxyUrl));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    label: `${options.model} through ${endpoint.host}, on Anthropic's Messages API`,
    async complete(messages, tools, headers, callOptions) {
      const body = anthropicRequest({
        model: options.model,
        maxTokens,
        messages,
        tools,
        toolChoice: callOptions?.toolChoice ?? "auto",
      });
      // The virtual key as the bearer token, as on chat completions: the
      // proxy reads it there first, whatever the provider, and puts the
      // provider's own key in the header Anthropic reads.
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.virtualKey}`,
          "anthropic-version": ANTHROPIC_VERSION,
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw await failed(res);
      return anthropicCompletion(await res.json());
    },
  };
}

export interface AnthropicRequestInput {
  readonly model: string;
  readonly maxTokens: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinitionLike[];
  readonly toolChoice: "auto" | "none";
}

type AnthropicRole = "user" | "assistant";

/**
 * The Messages API request for a conversation in the chat-completions shape.
 * System messages become the top-level `system`. An assistant message goes
 * back as the content blocks Anthropic returned for it, when it carries
 * them, else as its text and its tool calls as `tool_use` blocks. A `tool`
 * message becomes a `tool_result` block in a user turn. Consecutive messages
 * of one role join one turn, so a round's tool results arrive together, in
 * one user turn, ahead of any text that follows them. Text that is empty or
 * only whitespace is left out, among the returned blocks too: the API
 * refuses such a block, and the check on replayed thinking ignores it.
 */
export function anthropicRequest(input: AnthropicRequestInput): Record<string, unknown> {
  const system: string[] = [];
  const turns: { role: AnthropicRole; content: unknown[] }[] = [];
  const add = (role: AnthropicRole, blocks: readonly unknown[]): void => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  for (const message of input.messages) {
    switch (message.role) {
      case "system":
        if (message.content !== null && message.content.trim() !== "") system.push(message.content);
        break;
      case "user":
        add("user", textBlocks(message.content));
        break;
      case "assistant":
        add(
          "assistant",
          Array.isArray(message.anthropic_content)
            ? message.anthropic_content.filter((block) => !blankText(block))
            : [...textBlocks(message.content), ...(message.tool_calls ?? []).map(toolUseBlock)],
        );
        break;
      case "tool":
        add("user", [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id ?? "",
            ...(message.content !== null && message.content !== "" ? { content: message.content } : {}),
          },
        ]);
        break;
    }
  }
  return {
    model: input.model,
    max_tokens: input.maxTokens,
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    messages: turns,
    // No `tools` key when there are none; with tools, the call's choice.
    ...(input.tools.length > 0
      ? { tools: input.tools.map(anthropicTool), tool_choice: { type: input.toolChoice } }
      : {}),
  };
}

/** A text block whose text is empty or only whitespace. */
function blankText(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false;
  const b = block as Record<string, unknown>;
  return b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim() === "";
}

function textBlocks(content: string | null): unknown[] {
  return content !== null && content.trim() !== "" ? [{ type: "text", text: content }] : [];
}

function toolUseBlock(call: ToolCall): unknown {
  return { type: "tool_use", id: call.id, name: call.function.name, input: toolInput(call.function.arguments) };
}

/** A tool call's arguments as the object `tool_use` carries: `{}` when they are not a JSON object. */
function toolInput(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function anthropicTool(tool: ToolDefinitionLike): Record<string, unknown> {
  const { name, description, parameters } = tool.function;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    input_schema:
      parameters !== undefined && parameters !== null && Object.keys(parameters).length > 0
        ? parameters
        : { type: "object", properties: {} },
  };
}

interface AnthropicUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number | null;
  readonly cache_read_input_tokens?: number | null;
}

/**
 * The completion in the chat-completions shape for a Messages API reply:
 * its text blocks joined as the content, its `tool_use` blocks as tool
 * calls, and all its blocks kept as `anthropic_content` for the next call
 * of the turn. A refusal fails the call with its category; it is not an
 * empty answer to ask again. A reply cut off at `max_tokens` fails too,
 * naming `MODEL_MAX_TOKENS`: half an answer is no reply, and a tool call
 * cut off has arguments that never arrived whole. So does a conversation
 * that outgrew the model's context window.
 */
export function anthropicCompletion(reply: unknown): Completion {
  const r = (typeof reply === "object" && reply !== null ? reply : {}) as {
    content?: unknown;
    stop_reason?: unknown;
    stop_details?: { category?: unknown } | null;
    usage?: AnthropicUsage | null;
  };
  if (r.stop_reason === "refusal") {
    const category = typeof r.stop_details?.category === "string" ? `: ${r.stop_details.category}` : "";
    throw new Error(`the model declined the request (refusal${category})`);
  }
  if (r.stop_reason === "max_tokens") {
    throw new Error("the model's reply was cut off at its token limit: raise MODEL_MAX_TOKENS, which counts thinking too");
  }
  if (r.stop_reason === "model_context_window_exceeded") {
    throw new Error("the conversation no longer fits the model's context window");
  }
  if (!Array.isArray(r.content)) throw new Error("model reply carries no content");
  const blocks: unknown[] = r.content;
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] === "text" && typeof b["text"] === "string") texts.push(b["text"]);
    if (b["type"] === "tool_use" && typeof b["id"] === "string" && typeof b["name"] === "string") {
      calls.push({
        id: b["id"],
        type: "function",
        function: { name: b["name"], arguments: JSON.stringify(b["input"] ?? {}) },
      });
    }
  }
  const text = texts.join("");
  const message: ChatMessage = {
    role: "assistant",
    content: text === "" ? null : text,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    anthropic_content: blocks,
  };
  return { message, usage: chatUsage(r.usage) };
}

/** Anthropic's usage counted the chat-completions way: every input token, cached or not, as a prompt token. */
function chatUsage(usage: AnthropicUsage | null | undefined): Usage | undefined {
  if (usage === undefined || usage === null) return undefined;
  const prompt =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const completion = usage.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** What the loop needs from the tools: their definitions and a way to run one. */
export interface ToolRunner {
  readonly definitions: readonly ToolDefinitionLike[];
  call(name: string, args: unknown, toolCallId: string): Promise<string>;
}

export interface ConverseOptions {
  readonly model: ModelClient;
  readonly tools: ToolRunner;
  /**
   * The conversation so far, ending with the user's message. Appended to in
   * place: the assistant's messages and every tool result, in order, so the
   * caller can keep them as history.
   */
  readonly messages: ChatMessage[];
  /**
   * Called once per model call, immediately before it. The agent passes
   * the fabric package's `traceHeaders`, which also counts the call as a
   * turn on the edge of any thread the model spawns afterwards.
   */
  readonly traceHeaders: () => Record<string, string>;
  /**
   * How many model calls may ask for tools before the model is asked to
   * answer in words. Guards against a model that keeps calling tools.
   * Default 8.
   */
  readonly maxToolRounds?: number;
  /**
   * How many times the model is asked again when it answers with nothing
   * while calls it started are still open. One more empty answer fails the
   * turn ({@link EmptyReplyError}). Default 2. With no call open the model
   * is asked again once, at most this many times.
   */
  readonly maxEmptyReplies?: number;
  readonly log?: (line: string) => void;
}

/** A call the model started that has not ended, as the tools last reported it. */
export interface OpenCall {
  readonly callId: string;
  readonly state: "running" | "input_required";
  /** Whom the call went to, when the model's `prompt_agent` said. */
  readonly address?: string;
  /** What the prompted agent asked, while the call is `input_required`. */
  readonly question?: string;
}

/**
 * The model answered with nothing, again, after it was asked for a reply:
 * the turn has no reply, and, when calls it started are still open, it is
 * not done either. The agent fails the prompt with this message rather than
 * answer it with nothing.
 */
export class EmptyReplyError extends Error {
  override readonly name = "EmptyReplyError";
  constructor(
    readonly emptyReplies: number,
    readonly openCalls: readonly OpenCall[],
  ) {
    super(
      openCalls.length > 0
        ? `the model returned an empty reply ${times(emptyReplies)} while ${describeOpen(openCalls)}; ` +
            "no reply was produced"
        : `the model returned no reply: its answer was empty ${times(emptyReplies)}`,
    );
  }
}

export interface ConverseResult {
  readonly reply: string;
  readonly modelCalls: number;
  readonly toolCalls: number;
}

/**
 * Run the model until it answers in words. Each round is one model call;
 * when the model asks for tools, every call is run and answered with a
 * `tool` message, and the model is called again with the results in front
 * of it. On the last permitted round the model may not call a tool
 * (`toolChoice: "none"`), so it has to answer.
 *
 * An empty answer is not a reply while a call the model started is still
 * open, waiting on a question it has to answer or still running: the turn
 * is not done. The empty answer is dropped, the model is told which calls
 * wait and on what, and asked again, at most `maxEmptyReplies` times; then
 * the turn fails with {@link EmptyReplyError}. Which calls are open comes
 * from the tools' own results: each carries the call's `call_id` and
 * `state`, and a question while it is `input_required`.
 *
 * An empty answer with nothing open is no reply either: the model is asked
 * once more for one, and a second empty answer fails the turn with
 * {@link EmptyReplyError}. A turn never ends `ok` with nothing.
 */
export async function converse(options: ConverseOptions): Promise<ConverseResult> {
  const maxToolRounds = options.maxToolRounds ?? 8;
  const maxEmptyReplies = options.maxEmptyReplies ?? 2;
  const log = options.log ?? (() => {});
  let modelCalls = 0;
  let toolCalls = 0;
  let emptyReplies = 0;
  const open = new Map<string, OpenCall>();
  for (let round = 0; ; round += 1) {
    // The same tools every round; on the last permitted one the model may
    // not call them and has to answer.
    const answerOnly = round >= maxToolRounds;
    const { message, usage } = await options.model.complete(
      options.messages,
      options.tools.definitions,
      options.traceHeaders(),
      { toolChoice: answerOnly ? "none" : "auto" },
    );
    modelCalls += 1;
    options.messages.push(message);
    // No tool runs on the answer-only round, nor for an agent shown none.
    const calls = answerOnly || options.tools.definitions.length === 0 ? [] : (message.tool_calls ?? []);
    log(
      `model call ${modelCalls}: ${calls.length} tool call(s), ` +
        `${usage?.prompt_tokens ?? "?"} in / ${usage?.completion_tokens ?? "?"} out tokens`,
    );
    if (calls.length === 0) {
      const reply = message.content ?? "";
      if (reply.trim() !== "") return { reply, modelCalls, toolCalls };
      emptyReplies += 1;
      const waiting = [...open.values()];
      // With calls open the model has work left; with none, one more chance.
      const bound = waiting.length > 0 ? maxEmptyReplies : Math.min(1, maxEmptyReplies);
      if (emptyReplies > bound) throw new EmptyReplyError(emptyReplies, waiting);
      log(
        waiting.length > 0
          ? `  empty reply while ${describeOpen(waiting)}: asking again (${emptyReplies} of ${bound})`
          : `  empty reply: asking again for one (${emptyReplies} of ${bound})`,
      );
      // The empty answer is no turn of the conversation: out of the history,
      // and a word to the model in its place.
      options.messages.pop();
      options.messages.push({ role: "user", content: waiting.length > 0 ? stillOpen(waiting) : NO_REPLY });
      continue;
    }
    for (const call of calls) {
      log(`  ${call.function.name}(${call.function.arguments.slice(0, 120)}) [${call.id}]`);
      const content = await options.tools.call(call.function.name, call.function.arguments, call.id);
      toolCalls += 1;
      options.messages.push({ role: "tool", tool_call_id: call.id, content });
      track(open, call.function.name, call.function.arguments, content);
    }
  }
}

/**
 * Note what a tool result says about the calls it names: a call `running`
 * or `input_required` is open, any other state has ended. A result that
 * names no call (discovery, an error) changes nothing; `list_agent_calls`
 * names every call of the prompt being served.
 */
function track(open: Map<string, OpenCall>, tool: string, args: string, content: string): void {
  let result: unknown;
  try {
    result = JSON.parse(content);
  } catch {
    return;
  }
  if (typeof result !== "object" || result === null) return;
  const r = result as Record<string, unknown>;
  const address = tool === "prompt_agent" ? addressOf(args) : undefined;
  const entries = Array.isArray(r["calls"]) ? (r["calls"] as unknown[]) : [r];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const callId = e["call_id"];
    const state = e["state"];
    if (typeof callId !== "string" || typeof state !== "string") continue;
    if (state !== "running" && state !== "input_required") {
      open.delete(callId);
      continue;
    }
    const known = open.get(callId);
    const to = typeof e["address"] === "string" ? e["address"] : (address ?? known?.address);
    // A question stands until the call leaves `input_required`.
    const asked = typeof e["question"] === "string" ? e["question"] : known?.question;
    const question = state === "input_required" ? asked : undefined;
    open.set(callId, {
      callId,
      state,
      ...(to !== undefined ? { address: to } : {}),
      ...(question !== undefined ? { question } : {}),
    });
  }
}

function addressOf(args: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return typeof parsed["address"] === "string" ? parsed["address"] : undefined;
  } catch {
    return undefined;
  }
}

function times(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

function describeCall(call: OpenCall): string {
  const to = call.address !== undefined ? ` to ${call.address}` : "";
  return call.state === "input_required"
    ? `${call.callId}${to} waits for an answer${call.question !== undefined ? ` to "${call.question}"` : ""}`
    : `${call.callId}${to} is still running`;
}

function describeOpen(calls: readonly OpenCall[]): string {
  const counted = calls.length === 1 ? "1 call it started was still open" : `${calls.length} calls it started were still open`;
  return `${counted} (${calls.map(describeCall).join("; ")})`;
}

/** What the model is told in place of an empty answer with nothing open. */
const NO_REPLY = "Your last answer was empty. Answer the prompt you are serving in words.";

/** What the model is told in place of its empty answer while calls are open. */
function stillOpen(calls: readonly OpenCall[]): string {
  const lines = calls.map((call) =>
    call.state === "input_required"
      ? `- ${describeCall(call)}: answer it with answer_agent.`
      : `- ${describeCall(call)}: collect its result before you answer.`,
  );
  return (
    "Your last answer was empty, but the prompt you are serving is not done: " +
    (calls.length === 1 ? "a call you started is still open.\n" : "calls you started are still open.\n") +
    lines.join("\n") +
    "\nDeal with them, then answer the prompt in words."
  );
}
