// model.ts — one chat-completions client pointed at the fabric's proxy, and
// the loop that runs the model's tool calls.
//
// The agent never talks to a model provider. It talks to the proxy with its
// virtual key, and the proxy resolves the key to a provider (Ollama on a
// laptop, OpenRouter, OpenAI) and records the call on the agent's thread.
// The agent holds three things: the proxy's URL, its virtual key and a
// model name. Two headers on every call, `X-Synadia-Thread-ID` and
// `X-Synadia-Root-ID` from the fabric package's `traceHeaders()`, tell the
// proxy which thread the call belongs to; the proxy sees no NATS traffic,
// so nothing else about the tree has to reach it.
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
  readonly function: { readonly name: string };
}

export interface ModelClientOptions {
  /** The proxy's root URL; `/v1/chat/completions` is appended. */
  readonly proxyUrl: string;
  /** Issued through the console, resolved by the proxy to a provider. Never in a file this repo tracks. */
  readonly virtualKey: string;
  /** The model name the provider behind the key understands, for example `llama3.1:8b` or `openai/gpt-4o-mini`. */
  readonly model: string;
  /** Per call. A local model on a laptop can take a while; default two minutes. */
  readonly timeoutMs?: number;
}

export interface ModelClient {
  /** For log lines: the model and where the calls go. */
  readonly label: string;
  /**
   * One chat-completions call. `headers` are merged into the request; the
   * agent passes the fabric package's `traceHeaders()` here, once per call.
   */
  complete(
    messages: readonly ChatMessage[],
    tools: readonly ToolDefinitionLike[],
    headers: Record<string, string>,
  ): Promise<Completion>;
}

export function createModelClient(options: ModelClientOptions): ModelClient {
  const root = options.proxyUrl.endsWith("/") ? options.proxyUrl : `${options.proxyUrl}/`;
  const endpoint = new URL("v1/chat/completions", root);
  const timeoutMs = options.timeoutMs ?? 120_000;
  return {
    label: `${options.model} through ${endpoint.host}`,
    async complete(messages, tools, headers) {
      const body = {
        model: options.model,
        messages,
        // No `tools` key at all when there are none: some providers reject
        // an empty list.
        ...(tools.length > 0 ? { tools } : {}),
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
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new Error(`model call failed: ${res.status} ${res.statusText} ${text}`.trim());
      }
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
  readonly log?: (line: string) => void;
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
 * of it. On the last permitted round the model gets no tools, so it has to
 * answer.
 */
export async function converse(options: ConverseOptions): Promise<ConverseResult> {
  const maxToolRounds = options.maxToolRounds ?? 8;
  const log = options.log ?? (() => {});
  let modelCalls = 0;
  let toolCalls = 0;
  for (let round = 0; ; round += 1) {
    const toolsOffered = round < maxToolRounds ? options.tools.definitions : [];
    const { message, usage } = await options.model.complete(
      options.messages,
      toolsOffered,
      options.traceHeaders(),
    );
    modelCalls += 1;
    options.messages.push(message);
    const calls = toolsOffered.length > 0 ? (message.tool_calls ?? []) : [];
    log(
      `model call ${modelCalls}: ${calls.length} tool call(s), ` +
        `${usage?.prompt_tokens ?? "?"} in / ${usage?.completion_tokens ?? "?"} out tokens`,
    );
    if (calls.length === 0) return { reply: message.content ?? "", modelCalls, toolCalls };
    for (const call of calls) {
      log(`  ${call.function.name}(${call.function.arguments.slice(0, 120)}) [${call.id}]`);
      const content = await options.tools.call(call.function.name, call.function.arguments, call.id);
      toolCalls += 1;
      options.messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}
