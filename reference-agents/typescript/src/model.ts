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
  /**
   * How many times the model is asked again when it answers with nothing
   * while calls it started are still open. One more empty answer fails the
   * turn ({@link EmptyReplyError}). Default 2.
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
 * The model answered with nothing, again and again, while calls it started
 * were still open: the turn is not done, and it has no reply. The agent
 * fails the prompt with this message rather than answer it with nothing.
 */
export class EmptyReplyError extends Error {
  override readonly name = "EmptyReplyError";
  constructor(
    readonly emptyReplies: number,
    readonly openCalls: readonly OpenCall[],
  ) {
    super(
      `the model returned an empty reply ${emptyReplies} times while ${describeOpen(openCalls)}; ` +
        "no reply was produced",
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
 * of it. On the last permitted round the model gets no tools, so it has to
 * answer.
 *
 * An empty answer is not a reply while a call the model started is still
 * open, waiting on a question it has to answer or still running: the turn
 * is not done. The empty answer is dropped, the model is told which calls
 * wait and on what, and asked again, at most `maxEmptyReplies` times; then
 * the turn fails with {@link EmptyReplyError}. Which calls are open comes
 * from the tools' own results: each carries the call's `call_id` and
 * `state`, and a question while it is `input_required`. An empty answer
 * with nothing open is the reply, as before.
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
    if (calls.length === 0) {
      const reply = message.content ?? "";
      if (reply.trim() !== "" || open.size === 0) return { reply, modelCalls, toolCalls };
      emptyReplies += 1;
      const waiting = [...open.values()];
      if (emptyReplies > maxEmptyReplies) throw new EmptyReplyError(emptyReplies, waiting);
      log(`  empty reply while ${describeOpen(waiting)}: asking again (${emptyReplies} of ${maxEmptyReplies})`);
      // The empty answer is no turn of the conversation: out of the history,
      // and a word to the model in its place.
      options.messages.pop();
      options.messages.push({ role: "user", content: stillOpen(waiting) });
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

/** What the model is told in place of its empty answer. */
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
