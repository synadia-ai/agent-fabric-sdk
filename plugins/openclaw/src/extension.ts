// The fabric add-on for the OpenClaw channel plugin: the factory the plugin
// calls once per account at gateway start, and the extension it returns
// (`docs/plugins.md` §2.3, §2.4, §3.1, §3.3).
//
// What it does, in one screen. The fabric package's `fabricTracing()` gives
// the three hooks the SDK takes; the plugin puts the request interceptor and
// the heartbeat extras on its `AgentService` and the prompt interceptor on
// the `Agents` client its agent tools prompt through. That alone makes
// OpenClaw what an SDK-built agent is on the wire: the envelope's pair
// adopted or a root minted per served prompt, an `edge` record before every
// prompt OpenClaw's model sends, the record counts on the heartbeat.
//
// The harness piece is the join of OpenClaw's own model calls. The plugin
// cannot put the fabric's headers on them, but OpenClaw stamps a W3C
// `traceparent` on every call of a turn, its trace id inherited from the
// trace scope the turn was dispatched in. So per served prompt the add-on
// mints a fresh trace id, seeds OpenClaw's scope with it around the
// dispatch (`trace-scope.ts`), and publishes the binding as the signed
// `served` pair on the edge subject: `start` stamped with the arrival,
// `end` with the outcome and the time the plugin reports, both naming the
// served thread and the trace id, bare. The reader attaches the calls the
// proxy filed under that id between the two to the thread.
//
// The served request's scope is kept by the plugin's request id from
// `promptAccepted` to `promptEnded`, and bound around the dispatch and
// every agent-tool call. On OpenClaw 2026.8 and later both already run in
// the handler's async context, so the binding is a no-op rebind the add-on
// makes anyway; on 2026.5.4 the plugin puts a tool call back into the
// oldest pending request's context itself. The `409` loop guard is the
// fabric package's two interceptors, after tracing's.

import {
  activeTrace,
  bindActiveTrace,
  fabricTracing,
  loopGuard,
  resolveEdgeSubject,
  servedPublisher,
  type AgentExtension,
  type AgentExtensionContext,
  type ServedPublisher,
  type ServedRequest,
  type ServedTurn,
  type TraceScope,
} from "@synadia-ai/agent-fabric";
import { newTraceId, runWithTraceId } from "./trace-scope.js";

/** The extension's name, as the plugin's status output lists it. */
export const EXTENSION_NAME = "agent-fabric";

/** The name the proxy files OpenClaw's calls under, and the served records carry. */
export const SERVED_HARNESS = "openclaw";

/** The warning logged once at start when the plugin's identity is off. */
export const IDENTITY_OFF_WARNING =
  `${EXTENSION_NAME}: senderIdentity is off; trace records are signed, so none will be ` +
  "published and each counts as dropped on the heartbeat. Set senderIdentity to signed.";

/** One served prompt, from `promptAccepted` to `promptEnded`. */
interface Served {
  /** The scope tracing bound around the prompt's handler. */
  readonly scope: TraceScope;
  /** The trace id seeded into OpenClaw's turn: the pair's `harness_thread_id`. */
  readonly traceId: string;
  /** The pair; absent when the add-on publishes no records. */
  readonly turn: ServedTurn | undefined;
}

/**
 * The factory: the module's default export. Called once by the plugin per
 * account, before it connects, with what it knows then. Throws
 * `NatsAgentError` for an edge subject that can never be published to.
 *
 * `env` is where the variable is read from; a test passes its own.
 */
export function createFabricExtension(
  ctx: AgentExtensionContext,
  env: NodeJS.ProcessEnv = process.env,
): AgentExtension {
  const edgeSubject = resolveEdgeSubject(ctx.options, env);
  const tracing = fabricTracing({ edgeSubject });
  const guard = loopGuard();
  const log = ctx.logger;

  // Made at `started`, from the plugin's client, which signs as the
  // plugin's identity. A prompt accepted before then — the plugin starts
  // its service a moment before it calls `started` — gets its trace id
  // seeded and no pair. With the edge subject `null` (propagate-only)
  // there is never one: no record of any kind is published.
  let publisher: ServedPublisher | undefined;
  const served = new Map<string, Served>();
  const scopeOf = (request: ServedRequest | undefined): TraceScope | undefined =>
    request === undefined ? undefined : served.get(request.id)?.scope;

  let warnedIdentityOff = false;

  return {
    name: EXTENSION_NAME,
    // The service: tracing first, so the guard runs inside the scope tracing
    // bound and a malformed pair is refused with 400 before the guard
    // looks; the plugin appends its own (the tools' scope) after these.
    requestInterceptors: [tracing.requestInterceptor, guard.requestInterceptor],
    // The client OpenClaw's agent tools prompt through: the edge and the
    // pair, then the waiting mark. Both read the ambient scope, so the
    // order between them does not matter.
    promptInterceptors: [tracing.promptInterceptor, guard.promptInterceptor],
    heartbeatExtras: tracing.heartbeatExtras,
    // No `toolExtensions`: a harness reads no ScratchPad reference in the
    // MVP (level D, Phase III; `docs/plugins.md` §3.1).

    started({ agents, service }) {
      if (ctx.settings.senderIdentity !== "signed" && !warnedIdentityOff) {
        warnedIdentityOff = true;
        log.warn(IDENTITY_OFF_WARNING);
      }
      if (edgeSubject !== null) {
        publisher = servedPublisher({ agents, subject: edgeSubject, logger: log });
      }
      log.info(
        `${EXTENSION_NAME}: tracing ${service.subject.prompt}` +
          (edgeSubject === null
            ? " (propagate-only: lineage forwarded, no edge or served record published)"
            : `, edge and served records on ${edgeSubject}`),
      );
    },

    async stopping() {
      // The last `end` records are due as the gateway stops; let them out.
      await publisher?.flush();
    },

    events: {
      promptAccepted(request) {
        // In the handler's async context, inside the scope tracing bound.
        const scope = activeTrace();
        if (scope === undefined) return;
        const traceId = newTraceId();
        // `beginTurn` stamps the arrival now; `bind` publishes `start`.
        const turn = publisher?.beginTurn(scope, SERVED_HARNESS);
        turn?.bind(traceId);
        served.set(request.id, { scope, traceId, turn });
      },
      promptEnded(request, outcome, atMs) {
        const entry = served.get(request.id);
        if (entry === undefined) return;
        served.delete(request.id);
        entry.turn?.settle(outcome, atMs);
      },
      aroundDispatch(request, run) {
        // `run` is called synchronously inside both bindings and its own
        // promise returned: the plugin takes `run`'s promise, and nothing
        // here awaits before it.
        const entry = served.get(request.id);
        if (entry === undefined) return run();
        return runWithTraceId(entry.traceId, () => bindActiveTrace(entry.scope, run));
      },
      aroundToolCall(request, _toolName, run) {
        const scope = scopeOf(request);
        return scope === undefined ? run() : bindActiveTrace(scope, run);
      },
    },
  };
}
