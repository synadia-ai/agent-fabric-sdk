// A fake of the PI channel plugin's side of the contract, for the unit
// tests: it composes the extension's request interceptors the way the
// plugin's `AgentService` does (the first outermost, the handler inside),
// runs the client's prompt interceptors' first phase the way `Agents` does
// (in order, in the caller's async context), and drives the events in the
// plugin's order — `promptAccepted` inside the handler, the request open
// until the plugin's completion promise settles, `promptEnded` after — and
// a local turn's two events, as the plugin calls them at PI's
// `agent_start` and `agent_settled`. No server, no PI.

import type { RequestInterceptor, RequestInterceptorContext } from "@synadia-ai/agent-service";
import type {
  AgentId,
  Logger,
  PromptExtras,
  PromptInterceptor,
  PromptInterceptorContext,
  SenderInfo,
} from "@synadia-ai/agents";
import type {
  AgentExtension,
  AgentExtensionContext,
  LocalTurn,
  Outcome,
  ServedRequest,
} from "../../src/index.js";

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

/** What the plugin hands the factory, as the PI plugin fills it. */
export function extensionContext(overrides: ContextOverrides = {}): AgentExtensionContext {
  return {
    harness: "pi",
    plugin: { name: "@synadia-ai/nats-pi-channel", version: "0.5.6" },
    settings: {
      owner: "team",
      name: "editor",
      senderIdentity: overrides.senderIdentity ?? "signed",
      minSenderTrust: "signed",
      ...(overrides.stateDir === undefined ? {} : { stateDir: overrides.stateDir }),
      config: overrides.config ?? { context: "fabric", owner: "team", sessionName: "editor" },
    },
    options: overrides.options ?? {},
    logger: overrides.logger ?? recordingLogger().logger,
  };
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
    subject: "agents.prompt.pi.team.editor",
    headers: undefined,
  };
}

/** The plugin's `ServedRequest` for that envelope. */
export function servedRequest(
  id: string,
  extras: Readonly<Record<string, unknown>>,
  caller?: string,
): ServedRequest {
  return Object.freeze({
    id,
    extras: Object.freeze({ ...extras }),
    ...(caller === undefined ? {} : { caller }),
  });
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

export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
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
  /** Settle the request as the plugin would: the handler's promise resolves, then `promptEnded`. */
  end(outcome?: Outcome): Promise<void>;
}

/**
 * Serve one prompt as the plugin does: through the extension's request
 * interceptors, `promptAccepted` inside the handler, the handler pending
 * on the plugin's completion promise until `end()`, `promptEnded` after.
 */
export function serve(
  ext: AgentExtension,
  id: string,
  extras: Readonly<Record<string, unknown>>,
  caller?: string,
): ServedPrompt {
  const request = servedRequest(id, extras, caller);
  const completion = deferred();
  const accepted = deferred();
  const done = throughInterceptors(
    ext.requestInterceptors ?? [],
    requestContext(extras, caller === undefined ? undefined : verifiedSender(caller)),
    async () => {
      ext.events?.promptAccepted?.(request);
      accepted.resolve();
      await completion.promise;
    },
  );
  done.catch((e: unknown) => accepted.reject(e));
  return {
    request,
    accepted: accepted.promise,
    done,
    async end(outcome: Outcome = "ok") {
      completion.resolve();
      await done;
      ext.events?.promptEnded?.(request, outcome, Date.now());
    },
  };
}

/** A local turn, from `localTurnStarted` to `end()`. */
export interface RunningLocalTurn {
  readonly turn: LocalTurn;
  /** End the turn as the plugin would, at PI's `agent_settled`. */
  end(outcome?: Outcome): void;
}

/**
 * Run a local turn as the plugin does: a run no served prompt started,
 * named `local-<n>`, with `localTurnStarted` at its start and
 * `localTurnEnded` at `end()`.
 */
export function runLocalTurn(ext: AgentExtension, id = "local-1"): RunningLocalTurn {
  const turn: LocalTurn = Object.freeze({ id, local: true as const });
  ext.events?.localTurnStarted?.(turn, Date.now());
  return {
    turn,
    end(outcome: Outcome = "ok") {
      ext.events?.localTurnEnded?.(turn, outcome, Date.now());
    },
  };
}
