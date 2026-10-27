// A fake of the OpenClaw channel plugin's side of the contract, for the
// unit tests: it composes the extension's request interceptors the way the
// plugin's `AgentService` does (the first outermost, the handler inside),
// runs the client's prompt interceptors' first phase the way `Agents` does
// (in order, in the caller's async context), and drives the events in the
// gateway's order — `promptAccepted` synchronously inside the handler, the
// turn's dispatch inside `aroundDispatch`, `promptEnded` once the dispatch
// settled, still inside the handler (`serveTurn` in `gateway.ts`). A tool
// call runs in the dispatch's async context, as OpenClaw 2026.8 and later
// carry it. The served records go to a fake client that keeps them. No
// server, no OpenClaw.

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
  EndReason,
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
  readonly stateDir?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

/** What the plugin hands the factory, as the OpenClaw gateway fills it. */
export function extensionContext(overrides: ContextOverrides = {}): AgentExtensionContext {
  return {
    harness: "openclaw",
    plugin: { name: "@synadia-ai/nats-channel", version: "0.5.6" },
    settings: {
      owner: "team",
      name: "summarizer",
      senderIdentity: overrides.senderIdentity ?? "signed",
      minSenderTrust: "signed",
      stateDir: overrides.stateDir ?? "/tmp/openclaw-state",
      config: overrides.config ?? {
        owner: "team",
        agentName: "summarizer",
        senderIdentity: "signed",
      },
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
export function fakeService(prompt = "agents.prompt.oc.team.summarizer"): AgentService {
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
    subject: "agents.prompt.oc.team.summarizer",
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
  /** Resolves once the turn's dispatch runs, inside `aroundDispatch`. */
  readonly dispatched: Promise<void>;
  /** The whole request: the interceptors around the handler. */
  readonly done: Promise<void>;
  /** Run `fn` in the dispatch's async context: OpenClaw's turn, its model calls, its tool runner. */
  inTurn<T>(fn: () => T): T;
  /**
   * End the turn as OpenClaw would: the dispatch resolves (`ok`), or
   * rejects (`error`); the handler then calls `promptEnded` with that
   * outcome at `atMs`, now by default, and settles. With `reason`, the
   * fourth argument as the plugin passes it: `no_reply` for a run that
   * failed and whose last reply said so.
   */
  end(outcome?: Exclude<Outcome, "timeout">, atMs?: number, reason?: EndReason): Promise<void>;
}

let requestCounter = 0;

/**
 * Serve one prompt as the gateway does: through the extension's request
 * interceptors; in the handler `promptAccepted`, then the dispatch inside
 * `aroundDispatch`, pending until `end()`, then `promptEnded` with the
 * dispatch's outcome.
 */
export function serve(
  ext: AgentExtension,
  extras: Readonly<Record<string, unknown>>,
  caller?: string,
): ServedPrompt {
  const request: ServedRequest = Object.freeze({
    id: String(++requestCounter),
    extras: Object.freeze({ ...extras }),
    ...(caller === undefined ? {} : { caller }),
  });
  const accepted = deferred();
  const dispatched = deferred();
  const turnEnd = deferred<{
    outcome: Exclude<Outcome, "timeout">;
    atMs: number | undefined;
    reason: EndReason | undefined;
  }>();
  let enterTurn: (<T>(fn: () => T) => T) | undefined;
  let endedAt: number | undefined;
  let endReason: EndReason | undefined;

  const turn = async (): Promise<void> => {
    enterTurn = AsyncLocalStorage.snapshot();
    dispatched.resolve();
    const { outcome, atMs, reason } = await turnEnd.promise;
    endedAt = atMs;
    endReason = reason;
    if (outcome === "error") throw new Error("the turn failed");
  };

  const done = throughInterceptors(
    ext.requestInterceptors ?? [],
    requestContext(extras, caller === undefined ? undefined : verifiedSender(caller)),
    async () => {
      ext.events?.promptAccepted?.(request);
      accepted.resolve();
      let outcome: Outcome = "ok";
      try {
        await (ext.events?.aroundDispatch ? ext.events.aroundDispatch(request, turn) : turn());
      } catch (e) {
        outcome = "error";
        throw e;
      } finally {
        // The reason only when there is one, as the plugin passes it.
        if (endReason === undefined) {
          ext.events?.promptEnded?.(request, outcome, endedAt ?? Date.now());
        } else {
          ext.events?.promptEnded?.(request, outcome, endedAt ?? Date.now(), endReason);
        }
      }
    },
  );
  done.catch((e: unknown) => {
    accepted.reject(e);
    dispatched.reject(e);
  });
  // Nothing in a test need observe these when the request is refused.
  accepted.promise.catch(() => undefined);
  dispatched.promise.catch(() => undefined);

  return {
    request,
    accepted: accepted.promise,
    dispatched: dispatched.promise,
    done,
    inTurn<T>(fn: () => T): T {
      if (enterTurn === undefined) throw new Error("the turn was not dispatched");
      return enterTurn(fn);
    },
    async end(outcome = "ok", atMs, reason) {
      turnEnd.resolve({ outcome, atMs, reason });
      await done.catch((e: unknown) => {
        if (outcome !== "error") throw e;
      });
    },
  };
}
