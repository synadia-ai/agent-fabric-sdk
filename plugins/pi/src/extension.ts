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
// after tracing's, and its `aroundToolCall` inside the add-on's, which lifts
// the mark once the request's calls have settled (`loopGuard`, from the
// fabric package).
//
// ScratchPad (§9): when a volume is configured, the add-on sets the
// environment the package's skill (`skill/scratchpad`, given to PI with
// `--skill`) reads through `scripts/sp`: the connection, the workspace and
// the volume before the plugin connects, the served prompt's trace and
// caller from its hand-over to its end. It registers PI as reading
// references, hands the references PI's model puts into `prompt_agent`
// to the fabric package's ScratchPad extension (`scratchpad.ts`), and
// answers grant requests for what PI published, by an SDK-built agent's
// rule.

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
  READS_REFERENCES_KEY,
} from "@synadia-ai/agent-fabric";
import {
  exportScratchPad,
  resolveScratchPad,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  spPort,
  type ScratchPadSettings,
} from "./scratchpad.js";

/** The extension's name, as the plugin's status output lists it. */
export const EXTENSION_NAME = "agent-fabric";

/** The warning logged once at start when the plugin's identity is off. */
export const IDENTITY_OFF_WARNING =
  `${EXTENSION_NAME}: senderIdentity is off; trace records are signed, so none will be ` +
  "published and each counts as dropped on the heartbeat. Set senderIdentity to signed.";

/**
 * The factory: the module's default export. Called once by the plugin,
 * before it connects, with what it knows then. Resolves ScratchPad's
 * settings (which may read the plugin's NATS context) and builds the
 * extension with them. Throws `NatsAgentError` for an edge subject that can
 * never be published to.
 *
 * `env` is where the variables are read from, and where ScratchPad's are
 * set for PI's bash tool; a test passes its own.
 */
export async function fabricExtension(
  ctx: AgentExtensionContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentExtension> {
  return createFabricExtension(ctx, env, await resolveScratchPad(ctx, env));
}

/**
 * The extension, built synchronously from settings already resolved:
 * without `scratchPad`, tracing and the guard alone.
 */
export function createFabricExtension(
  ctx: AgentExtensionContext,
  env: NodeJS.ProcessEnv = process.env,
  scratchPad?: ScratchPadSettings,
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
  const scratchPadOn = scratchPad !== undefined;
  const promptEnv = new ServedPromptEnv(env);
  // Set before the plugin connects, so a command PI runs at any time finds them.
  if (scratchPad !== undefined) exportScratchPad(scratchPad, env);
  const handOn = scratchPad !== undefined ? new ScratchPadHandOn() : undefined;

  return {
    name: EXTENSION_NAME,
    // The service: tracing first, so the guard runs inside the scope tracing
    // bound and a malformed pair is refused with 400 before the guard
    // looks; the plugin appends its own (the tools' scope) after these.
    // The ScratchPad extension's, last, remembers the references each
    // served prompt brings, which PI may hand on.
    requestInterceptors: [
      tracing.requestInterceptor,
      guard.requestInterceptor,
      ...(handOn !== undefined ? [handOn.requestInterceptor] : []),
    ],
    // The client PI's agent tools prompt through: the edge and the pair,
    // then the waiting mark. Both read the ambient scope, so the order
    // between them does not matter.
    promptInterceptors: [tracing.promptInterceptor, guard.promptInterceptor],
    heartbeatExtras: tracing.heartbeatExtras,
    ...(handOn !== undefined
      ? {
          // References in PI's `prompt_agent`: granted to a receiver that
          // reads them, removed with a note for any other.
          toolExtensions: [handOn],
          // So a caller's `prompt_agent` hands references to PI.
          metadata: { [READS_REFERENCES_KEY]: "true" },
        }
      : {}),
    // No `stopping`: an
    // edge record is published before the prompt it describes and counted
    // as it goes, so there is nothing to flush when the plugin stops.

    started({ agents, service }) {
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
      if (scratchPad !== undefined && handOn !== undefined) {
        env[SP_VARS.creator] = service.subject.prompt;
        const port = spPort(scratchPad, service.subject.prompt, env);
        if (port !== undefined) handOn.start({ scratchPad: port, agents, service, logger: log });
        else
          log.warn(
            `${EXTENSION_NAME}: no sp for this platform (set SCRATCHPAD_BIN); ` +
              "references in prompt_agent are not handed on, and grant requests not answered",
          );
        log.info(
          `${EXTENSION_NAME}: ScratchPad volume ${scratchPad.volume}` +
            (scratchPad.dir !== undefined ? `, workspace ${scratchPad.dir}` : ", no workspace") +
            ", for the skill's scripts/sp",
        );
      }
    },

    events: {
      promptAccepted(request) {
        // In the handler's async context, inside the scope tracing bound.
        const scope = activeTrace();
        if (scope !== undefined) scopes.set(request.id, scope);
      },
      promptEnded(request) {
        scopes.delete(request.id);
        promptEnv.leave(request);
      },
      aroundInject(request, run) {
        const scope = scopes.get(request.id);
        // The hand-over to PI's loop: from here to its end this prompt is
        // the one PI works on, and the one `scripts/sp` works for.
        if (scratchPadOn) promptEnv.enter(request, scope);
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
        return scope === undefined
          ? run()
          : bindActiveTrace(scope, () => guard.aroundToolCall(scope, run));
      },
    },
  };
}
