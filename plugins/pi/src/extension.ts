// The fabric add-on for the PI channel plugin: the factory the plugin calls
// once at start, and the extension it returns (`docs/plugins.md` §2.3, §2.4,
// §3.1, §3.2).
//
// What it does, in one screen. The fabric package's `fabricTracing()` gives
// the three hooks the SDK takes; the plugin puts the request interceptor and
// the heartbeat extras on its `AgentService` and the prompt interceptor on
// the `Agents` client its agent tools prompt through. That alone makes PI
// what an SDK-built agent is on the wire: the envelope's pair adopted or a
// root minted per served prompt, an `edge` record before every prompt PI's
// model sends, the record counts on the heartbeat. The harness piece is the
// scope: PI's loop does not run in the handler's async context, so the
// add-on keeps each served request's scope by the plugin's request id and
// binds it where the plugin says the request is being worked on —
// `aroundInject` around the hand-over to PI's loop, `aroundToolCall` around
// every agent-tool call, and `providerHeaders`, which returns the fabric's
// two headers for the request so the proxy files PI's own model calls on
// the served thread. The `409` loop guard is its own two interceptors,
// after tracing's (`loopGuard`, from the fabric package).

import {
  activeTrace,
  bindActiveTrace,
  fabricTracing,
  loopGuard,
  resolveEdgeSubject,
  traceHeaders,
  type AgentExtension,
  type AgentExtensionContext,
  type ServedRequest,
  type TraceScope,
} from "@synadia-ai/agent-fabric";

/** The extension's name, as the plugin's status output lists it. */
export const EXTENSION_NAME = "agent-fabric";

/** The warning logged once at start when the plugin's identity is off. */
export const IDENTITY_OFF_WARNING =
  `${EXTENSION_NAME}: senderIdentity is off; trace records are signed, so none will be ` +
  "published and each counts as dropped on the heartbeat. Set senderIdentity to signed.";

/**
 * The factory: the module's default export. Called once by the plugin,
 * before it connects, with what it knows then. Throws `NatsAgentError` for
 * an edge subject that can never be published to.
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

  // Each served request's scope, the one tracing bound around its handler,
  // by the plugin's request id: kept from `promptAccepted`, which the plugin
  // calls inside the handler, to `promptEnded`. `bindActiveTrace` runs its
  // function inside an `AsyncLocalStorage.run`, which *replaces* the
  // ambient context — as it must: PI's turn, its provider requests and the
  // tools it executes all run in the async context of whoever called
  // `pi.sendUserMessage()`, and when the plugin injects the next queued
  // prompt from the previous turn's settle hook that context is the
  // previous request's (measured on PI 0.85.1, `docs/plugins.md` §3.5 gap 3).
  const scopes = new Map<string, TraceScope>();
  const scopeOf = (request: ServedRequest | undefined): TraceScope | undefined =>
    request === undefined ? undefined : scopes.get(request.id);

  let warnedIdentityOff = false;

  return {
    name: EXTENSION_NAME,
    // The service: tracing first, so the guard runs inside the scope tracing
    // bound and a malformed pair is refused with 400 before the guard
    // looks; the plugin appends its own (the tools' scope) after these.
    requestInterceptors: [tracing.requestInterceptor, guard.requestInterceptor],
    // The client PI's agent tools prompt through: the edge and the pair,
    // then the waiting mark. Both read the ambient scope, so the order
    // between them does not matter.
    promptInterceptors: [tracing.promptInterceptor, guard.promptInterceptor],
    heartbeatExtras: tracing.heartbeatExtras,
    // No `toolExtensions`: a harness reads no ScratchPad reference in the
    // MVP (level D, Phase III; `docs/plugins.md` §3.1). No `stopping`: an
    // edge record is published before the prompt it describes and counted
    // as it goes, so there is nothing to flush when the plugin stops.

    started({ service }) {
      if (ctx.settings.senderIdentity !== "signed" && !warnedIdentityOff) {
        warnedIdentityOff = true;
        log.warn(IDENTITY_OFF_WARNING);
      }
      log.info(
        `${EXTENSION_NAME}: tracing ${service.subject.prompt}` +
          (edgeSubject === null
            ? " (propagate-only: lineage forwarded, no edge record published)"
            : `, edge records on ${edgeSubject}`),
      );
    },

    events: {
      promptAccepted(request) {
        // In the handler's async context, inside the scope tracing bound.
        const scope = activeTrace();
        if (scope !== undefined) scopes.set(request.id, scope);
      },
      promptEnded(request) {
        scopes.delete(request.id);
      },
      aroundInject(request, run) {
        const scope = scopes.get(request.id);
        return scope === undefined ? run() : bindActiveTrace(scope, run);
      },
      providerHeaders(request) {
        // One call per provider request: `traceHeaders()` counts each
        // against the scope, so an edge PI's model spawns later says how
        // many calls came before it — retries included.
        const scope = scopes.get(request.id);
        return scope === undefined ? undefined : bindActiveTrace(scope, traceHeaders);
      },
      aroundToolCall(request, _toolName, run) {
        // The same binding as the injection's, for the case PI's tool
        // runner does not inherit it; a no-op rebind when it does.
        const scope = scopeOf(request);
        return scope === undefined ? run() : bindActiveTrace(scope, run);
      },
    },
  };
}
