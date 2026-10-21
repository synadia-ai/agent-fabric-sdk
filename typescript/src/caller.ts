// A caller on the fabric: code that prompts agents with a creds file and
// nothing else. `fabricCaller()` connects with the file, signs every prompt
// with its key, traces it (each prompt starts a task of its own), and hands
// back the task's root id with the reply. Mirrors
// `synadia_ai/agent_fabric/caller.py`.
//
// What a caller may do on the wire is narrow: it publishes prompts, status
// and discovery requests, its edge records and its own identity lookup, and
// it receives only on `_INBOX.agents.>` and the heartbeats. So the
// connection's inbox prefix is `_INBOX.agents`: discovery, status and the
// identity lookup all reply on the connection's inbox.
//
// The root id: tracing's prompt interceptor mints the thread and its root
// at the stream's first iteration. The caller's own interceptor wraps it,
// reads the root from the fields it returns, and resolves the prompt's
// `rootId` with it. Nothing is bound around the prompt, so it is always the
// root of a task of its own, never a child.

import { connect } from "@nats-io/transport-node";
import {
  Agents,
  resolveNatsConnectionBundle,
  withAgentReconnectDefaults,
  type Agent,
  type PromptInterceptor,
  type PromptOptions,
  type PromptStream,
  type QueryEvent,
} from "@synadia-ai/agents";
import { ROOT_ID_FIELD, type TraceOptions } from "./trace.js";
import { fabricTracing } from "./tracing.js";

/** The inbox prefix a caller's permissions allow it to receive on. */
export const CALLER_INBOX_PREFIX = "_INBOX.agents";

/** What `ask()` replies to a question from the agent when no `onQuery` is given. */
export const CANNOT_ANSWER =
  "The caller is a command line and cannot answer; continue with your best judgement.";

/** How long `list()` and `find()` listen for agents, by default. */
export const DEFAULT_DISCOVER_TIMEOUT_MS = 1_000;

/** The variables {@link fabricCallerFromEnv} reads. */
export const NATS_URL_VAR = "NATS_URL";
export const NATS_CREDS_VAR = "NATS_CREDS";

/** Why a caller could not be set up, or could not find its agent. */
export type FabricCallerErrorReason = "config" | "connect" | "not-found" | "ambiguous";

/** A caller's own error: a missing setting, no connection, or no such agent. */
export class FabricCallerError extends Error {
  constructor(
    readonly reason: FabricCallerErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "FabricCallerError";
  }
}

export interface FabricCallerOptions {
  /** The path to the creds file. */
  readonly creds: string;
  /**
   * The server's URL, as the console showed it next to the creds file.
   * Default: `NATS_URL`. There is no built-in default.
   */
  readonly url?: string;
  /** The client's name, on the connection and in its identity. */
  readonly name?: string;
  /** Where the edge records go; `null` publishes none. Default: tracing's. */
  readonly edgeSubject?: TraceOptions["edgeSubject"];
}

/** A prompt on its way: the SDK's stream, and the root of the task it starts. */
export interface CallerPrompt {
  /** The SDK's `PromptStream`, unchanged: iterate it for the reply. */
  readonly stream: PromptStream;
  /**
   * The root id of the task the prompt starts. Resolves at the stream's
   * first iteration, before any chunk arrives; await it after iteration
   * has begun, never before.
   */
  readonly rootId: Promise<string>;
}

export interface AskOptions extends PromptOptions {
  /**
   * Answers a question the agent asks mid-reply. Without it, the agent is
   * told the caller cannot answer and goes on.
   */
  readonly onQuery?: (query: QueryEvent) => string | Promise<string>;
}

/** The whole reply to a prompt, and the root of the task it started. */
export interface CallerReply {
  readonly text: string;
  readonly rootId: string;
}

export interface FabricCaller {
  /** The SDK's client, for anything beyond. */
  readonly agents: Agents;
  /** The URL the caller connected to. */
  readonly url: string;
  /** The agents on the fabric. */
  list(opts?: { readonly timeoutMs?: number }): Promise<Agent[]>;
  /**
   * One agent: by its prompt address, else by its kind when exactly one
   * agent has it. Throws {@link FabricCallerError} naming what is there.
   */
  find(who: string, opts?: { readonly timeoutMs?: number }): Promise<Agent>;
  /**
   * Prompt an agent: an address, a kind, or an `Agent` this caller's
   * `list()` or `find()` returned.
   */
  prompt(who: string | Agent, text: string, options?: PromptOptions): Promise<CallerPrompt>;
  /** Prompt an agent and wait for the whole reply. */
  ask(who: string | Agent, text: string, options?: AskOptions): Promise<CallerReply>;
  /** Close the client and the connection, then wipe the credentials. */
  close(): Promise<void>;
}

// The key of `PromptOptions.context` the root's deferred travels under. It
// is read only by the caller's own interceptor; the SDK never reads the
// context, and tracing reads only its tool call id key.
const ROOT_SINK_KEY = "agentFabricCallerRootSink";

type RootSink = (rootId: string) => void;

/** Connect a caller with a creds file. */
export async function fabricCaller(options: FabricCallerOptions): Promise<FabricCaller> {
  const creds = options.creds;
  if (typeof creds !== "string" || creds.length === 0) {
    throw new FabricCallerError(
      "config",
      `no creds file: pass creds, or set ${NATS_CREDS_VAR} to the creds file the console gave you`,
    );
  }
  const url = options.url ?? process.env[NATS_URL_VAR];
  if (url === undefined || url.length === 0) {
    throw new FabricCallerError(
      "config",
      `no server URL: pass url, or set ${NATS_URL_VAR} to the URL the console showed next to your creds file`,
    );
  }
  // Fails here, before anything connects, for an edge subject that can
  // never be published to.
  const tracing = fabricTracing(
    options.edgeSubject !== undefined ? { edgeSubject: options.edgeSubject } : {},
  );

  const bundle = await resolveNatsConnectionBundle({ url, creds }, { identity: "signed" });
  let nc: Awaited<ReturnType<typeof connect>>;
  try {
    nc = await connect(
      withAgentReconnectDefaults({
        ...bundle.connectionOptions,
        inboxPrefix: CALLER_INBOX_PREFIX,
        ...(options.name !== undefined ? { name: options.name } : {}),
        // A caller is short-lived: a wrong URL fails now, naming the URL,
        // instead of retrying forever before the first connection.
        waitOnFirstConnect: false,
      }),
    );
  } catch (err) {
    bundle.wipe();
    throw new FabricCallerError(
      "connect",
      `could not connect to ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const agents = new Agents({
    nc,
    identity: {
      signer: bundle.signer,
      ...(options.name !== undefined ? { name: options.name } : {}),
    },
    interceptors: [rootCapturing(tracing.promptInterceptor)],
  });

  const list = (opts: { readonly timeoutMs?: number } = {}): Promise<Agent[]> =>
    agents.discover({ timeoutMs: opts.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS });

  const find = async (who: string, opts: { readonly timeoutMs?: number } = {}): Promise<Agent> =>
    pickAgent(await list(opts), who);

  const prompt = async (
    who: string | Agent,
    text: string,
    promptOptions: PromptOptions = {},
  ): Promise<CallerPrompt> => {
    const target = typeof who === "string" ? await find(who) : who;
    let sink!: RootSink;
    const rootId = new Promise<string>((resolve) => {
      sink = resolve;
    });
    const stream = await target.prompt(text, {
      ...promptOptions,
      context: { ...(promptOptions.context ?? {}), [ROOT_SINK_KEY]: sink },
    });
    return { stream, rootId };
  };

  const ask = async (
    who: string | Agent,
    text: string,
    askOptions: AskOptions = {},
  ): Promise<CallerReply> => {
    const { onQuery, ...promptOptions } = askOptions;
    const { stream, rootId } = await prompt(who, text, promptOptions);
    let reply = "";
    for await (const msg of stream) {
      if (msg.type === "response") reply += msg.text;
      else if (msg.type === "query") {
        // Every question is answered: an agent left waiting would stall.
        await msg.reply(onQuery !== undefined ? await onQuery(msg) : CANNOT_ANSWER);
      }
    }
    return { text: reply, rootId: await rootId };
  };

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await agents.close();
      await nc.close();
    } finally {
      bundle.wipe();
    }
  };

  return { agents, url, list, find, prompt, ask, close };
}

/** {@link fabricCaller} from `NATS_URL` and `NATS_CREDS`. */
export function fabricCallerFromEnv(
  options: Omit<FabricCallerOptions, "creds" | "url"> = {},
): Promise<FabricCaller> {
  return fabricCaller({ ...options, creds: process.env[NATS_CREDS_VAR] ?? "" });
}

/**
 * The rule {@link FabricCaller.find} applies: the agent whose prompt address
 * is `who`, else the one agent of kind `who`; otherwise an error that names
 * what is there.
 */
export function pickAgent(found: ReadonlyArray<Agent>, who: string): Agent {
  const byAddress = found.find((a) => a.promptSubject === who);
  if (byAddress !== undefined) return byAddress;
  const ofKind = distinctAddresses(found.filter((a) => a.agent === who));
  if (ofKind.length === 1) return ofKind[0]!;
  if (ofKind.length > 1) {
    throw new FabricCallerError(
      "ambiguous",
      `${ofKind.length} agents of kind "${who}": ${ofKind.map((a) => a.promptSubject).join(", ")}; name one by its address`,
    );
  }
  const there = distinctAddresses(found)
    .map((a) => a.promptSubject)
    .join(", ");
  throw new FabricCallerError("not-found", `no agent "${who}"; there: ${there || "nobody"}`);
}

// One handle per prompt address: two instances of one agent share it.
function distinctAddresses(agents: ReadonlyArray<Agent>): Agent[] {
  const seen = new Map<string, Agent>();
  for (const a of agents) if (!seen.has(a.promptSubject)) seen.set(a.promptSubject, a);
  return [...seen.values()];
}

/**
 * Tracing's prompt interceptor, with the root it mints handed to the
 * prompt's sink. Both phases are forwarded; the extras go back verbatim,
 * so the SDK hands tracing's own extras to its second phase.
 */
function rootCapturing(inner: PromptInterceptor): PromptInterceptor {
  return {
    async beforePrompt(ctx) {
      const extras = await inner.beforePrompt(ctx);
      const sink = ctx.context[ROOT_SINK_KEY];
      const root = extras?.fields?.[ROOT_ID_FIELD];
      if (typeof sink === "function" && typeof root === "string") (sink as RootSink)(root);
      return extras;
    },
    async beforePublish(ctx, extras) {
      await inner.beforePublish?.(ctx, extras);
    },
  };
}
