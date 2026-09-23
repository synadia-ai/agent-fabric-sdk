// A fake of the Claude Code channel plugin's side of the contract, for the
// unit tests: it composes the extension's request interceptors the way the
// plugin's `AgentService` does (the first outermost, the handler inside),
// runs the client's prompt interceptors' first phase the way `Agents` does
// (in order, in the caller's async context), and drives the events in the
// MCP server's order (`server.ts` at `85a69c8`): `promptAccepted`
// synchronously inside the handler, which then stays open until the model
// calls `reply` with `done`; `promptEnded` as the handler closes, with the
// reply's time for `ok`. An agent-tool call arrives as an MCP request of its
// own, outside the handler's context, and is put back into it through the
// snapshot the handler took, then run inside `aroundToolCall` — as the
// plugin's `runAgentTool` does. The session events, `sessionStarted` and
// `turnStopped`, are the test's to call. The served records go to a fake
// client that keeps them. No server, no Claude Code.

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentService,
  RequestInterceptor,
  RequestInterceptorContext,
} from "@synadia-ai/agent-service";
import {
  newAgentId,
  type AgentId,
  type Agents,
  type Logger,
  type PromptExtras,
  type PromptInterceptor,
  type PromptInterceptorContext,
  type SenderInfo,
} from "@synadia-ai/agents";
import type {
  AgentExtension,
  AgentExtensionContext,
  Outcome,
  ServedRequest,
} from "@synadia-ai/agent-fabric";

export interface LogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
}

/** A logger that keeps every line. */
export function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const at =
    (level: LogLine["level"]) =>
    (message: string): void => {
      lines.push({ level, message });
    };
  return {
    lines,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

export interface ContextOverrides {
  readonly senderIdentity?: "off" | "signed";
  readonly options?: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
}

/** What the plugin hands the factory, as the MCP server fills it. */
export function extensionContext(overrides: ContextOverrides = {}): AgentExtensionContext {
  return {
    harness: "claude-code",
    plugin: { name: "nats-channel", version: "0.5.1" },
    settings: {
      owner: "team",
      name: "claude",
      senderIdentity: overrides.senderIdentity ?? "signed",
      minSenderTrust: "signed",
      stateDir: "/tmp/claude-state",
      config: { owner: "team", sessionName: "claude", senderIdentity: "signed" },
    },
    options: overrides.options ?? {},
    logger: overrides.logger ?? recordingLogger().logger,
  };
}

// alice in ACME, from test-fixtures/identity/operator/keys.json: the
// operator-mode `{account NKEY}.{user NKEY}` form `served.json` requires.
export const PLUGIN_AGENT_ID = newAgentId(
  "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
  "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
);

/** One signed publish the fake client took. */
export interface Published {
  readonly subject: string;
  readonly record: Record<string, unknown>;
  readonly nonce: string | undefined;
}

/**
 * The plugin's `Agents`, as far as the served publisher uses it: `selfId`
 * and `publishSigned`. Signed by default; unsigned, it refuses the way the
 * SDK does, with a `SenderSignatureRequiredError` of its own copy.
 */
export function fakeClient(signed = true): { agents: Agents; published: Published[] } {
  const published: Published[] = [];
  const agents = {
    selfId: () => Promise.resolve(PLUGIN_AGENT_ID),
    publishSigned(subject: string, payload: Uint8Array, opts?: { nonce?: string }) {
      if (!signed) {
        const err = new Error(`${subject} requires a signed Agent-Sender header`);
        err.name = "SenderSignatureRequiredError";
        return Promise.reject(err);
      }
      published.push({
        subject,
        record: JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>,
        nonce: opts?.nonce,
      });
      return Promise.resolve();
    },
  } as unknown as Agents;
  return { agents, published };
}

/** The plugin's service, as far as `started` reads it. */
export function fakeService(prompt = "agents.prompt.cc.team.claude"): AgentService {
  return { subject: { prompt } } as unknown as AgentService;
}

/** The verified sender `id`, as the SDK classifies one. */
export function verifiedSender(id: string): SenderInfo {
  // Only `trust` and `id` are read here; the rest of a `VerifiedSender` is the SDK's.
  return { trust: "verified", id: id as AgentId } as unknown as SenderInfo;
}

/** A request interceptor context, as the service builds it from the envelope. */
export function requestContext(
  extras: Readonly<Record<string, unknown>>,
  sender?: SenderInfo,
): RequestInterceptorContext {
  return {
    envelope: { prompt: "hi", extras },
    sender,
    subject: "agents.prompt.cc.team.claude",
    headers: undefined,
  };
}

/** Nest `interceptors` around `handler` as the service does: the first outermost. */
export function throughInterceptors(
  interceptors: ReadonlyArray<RequestInterceptor>,
  ctx: RequestInterceptorContext,
  handler: () => Promise<void>,
): Promise<void> {
  let next = handler;
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const interceptor = interceptors[i]!;
    const inner = next;
    next = () => interceptor.aroundRequest(ctx, inner);
  }
  return next();
}

/** Phase one of every prompt interceptor, in order, for a prompt with `context`. */
export async function phaseOne(
  interceptors: ReadonlyArray<PromptInterceptor>,
  context: Readonly<Record<string, unknown>> = {},
): Promise<Array<PromptExtras | undefined>> {
  const ctx = { context } as unknown as PromptInterceptorContext;
  const out: Array<PromptExtras | undefined> = [];
  for (const interceptor of interceptors)
    out.push((await interceptor.beforePrompt(ctx)) ?? undefined);
  return out;
}

/** What the fabric's prompt interceptor plans, from its phase-one extras. */
export interface EdgePlan {
  readonly threadId: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly toolCallId: string | null;
  readonly turnCountHint: number;
}

export function planOf(extras: PromptExtras | undefined): EdgePlan {
  if (extras?.state === undefined) throw new Error("the tracing interceptor returned no plan");
  return extras.state as EdgePlan;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A served prompt, from the ack to the plugin's settle. */
export interface ServedPrompt {
  readonly request: ServedRequest;
  /** Resolves once the handler ran `promptAccepted`; rejects when an interceptor refused. */
  readonly accepted: Promise<void>;
  /** The whole request: the interceptors around the handler. */
  readonly done: Promise<void>;
  /**
   * An agent-tool call the model makes for this request: `fn` re-entered
   * into the handler's context and run inside `aroundToolCall`, as the
   * plugin runs `tools.execute()`.
   */
  toolCall<T>(toolName: string, fn: () => T): T;
  /**
   * End the request as the plugin would: `ok` when `reply` completed it
   * with `done`, `error` on a handler failure, `timeout` at the request
   * TTL; `promptEnded` with that outcome at `atMs`, now by default.
   */
  end(outcome?: Outcome, atMs?: number): Promise<void>;
}

let requestCounter = 0;

/**
 * Serve one prompt as the MCP server does: through the extension's request
 * interceptors; in the handler `promptAccepted` with `sessionId` when the
 * plugin knows it, then open until `end()`, then `promptEnded`.
 */
export function serve(
  ext: AgentExtension,
  extras: Readonly<Record<string, unknown>>,
  opts: { readonly caller?: string; readonly sessionId?: string } = {},
): ServedPrompt {
  const { caller, sessionId } = opts;
  const request: ServedRequest = Object.freeze({
    id: String(++requestCounter),
    extras: Object.freeze({ ...extras }),
    ...(caller === undefined ? {} : { caller }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  const accepted = deferred();
  const completion = deferred<{ outcome: Outcome; atMs: number | undefined }>();
  let enter: (<T>(fn: () => T) => T) | undefined;

  const done = throughInterceptors(
    ext.requestInterceptors ?? [],
    requestContext(extras, caller === undefined ? undefined : verifiedSender(caller)),
    async () => {
      enter = AsyncLocalStorage.snapshot();
      ext.events?.promptAccepted?.(request);
      accepted.resolve();
      const { outcome, atMs } = await completion.promise;
      ext.events?.promptEnded?.(request, outcome, atMs ?? Date.now());
      if (outcome !== "ok") throw new Error(`the request ended: ${outcome}`);
    },
  );
  done.catch((e: unknown) => accepted.reject(e));
  // Nothing in a test need observe this when the request is refused.
  accepted.promise.catch(() => undefined);

  return {
    request,
    accepted: accepted.promise,
    done,
    toolCall<T>(toolName: string, fn: () => T): T {
      if (enter === undefined) throw new Error("the request was not accepted");
      const events = ext.events;
      return enter(() =>
        events?.aroundToolCall ? events.aroundToolCall(request, toolName, fn) : fn(),
      );
    },
    async end(outcome = "ok", atMs) {
      completion.resolve({ outcome, atMs });
      await done.catch((e: unknown) => {
        if (outcome === "ok") throw e;
      });
    },
  };
}
