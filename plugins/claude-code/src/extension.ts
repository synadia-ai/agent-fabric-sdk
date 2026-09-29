// The fabric add-on for the Claude Code channel plugin: the factory the
// plugin's MCP server calls once at start, and the extension it returns
// (`docs/plugins.md` §2.3, §2.4, §3.1, §3.4).
//
// What it does, in one screen. The fabric package's `fabricTracing()` gives
// the three hooks the SDK takes; the plugin puts the request interceptor and
// the heartbeat extras on its `AgentService` and the prompt interceptor on
// the `Agents` client its agent tools prompt through. That alone makes the
// session what an SDK-built agent is on the wire: the envelope's pair
// adopted or a root minted per served prompt, an `edge` record before every
// prompt Claude Code's model sends, the record counts on the heartbeat.
//
// The harness piece is the join of Claude Code's own model calls. Claude
// Code sends `X-Claude-Code-Session-ID` on every model request and the
// proxy files the calls under the session id; the plugin, an MCP server
// inside the session, cannot touch those headers. So per served prompt the
// add-on publishes the binding as the signed `served` pair on the edge
// subject: `start` stamped with the arrival, naming the served thread and
// the session the prompt was delivered to, and `end` with the outcome.
//
// The turn does not end with the reply. After `reply` completes the
// request with `done`, Claude Code makes at least one more model call to
// write its closing text. So an `ok` turn stays pending until the plugin's
// `Stop` hook reports the turn's end (`turnStopped`) at a time after the
// reply, and `end` carries that time; with no `Stop` within the bound
// (`stopWaitMs`, 120 s by default) it carries the reply's. A failed or
// expired request ends at once.
//
// The served request's scope is kept by the plugin's request id from
// `promptAccepted` to `promptEnded` and bound around every agent-tool
// call. The plugin already re-enters the handler's async context (a
// snapshot taken after the interceptors ran) before `aroundToolCall`, so
// the binding is a no-op rebind the add-on makes anyway. The `409` loop
// guard is the fabric package's two interceptors, after tracing's, and its
// `aroundToolCall` inside the add-on's, which lifts the mark once the
// request's calls have settled.
//
// ScratchPad (§9.13): when a volume is configured, the add-on keeps the
// variables the package's skill (`skills/scratchpad`, loaded with the
// package as a Claude Code plugin) reads through `scripts/sp` in a file the
// package's SessionStart hook names to the Bash tool: the connection, the
// workspace and the volume at start, the served prompt's trace and caller
// from its arrival to its end (`scratchpad.ts`). It registers Claude Code as
// reading references, hands the references Claude Code's model puts into
// `prompt_agent` to the fabric package's ScratchPad extension, and answers
// grant requests for what Claude Code published, by an SDK-built agent's
// rule.

import {
  activeTrace,
  bindActiveTrace,
  fabricTracing,
  loopGuard,
  resolveEdgeSubject,
  servedPublisher,
  type AgentExtension,
  type AgentExtensionContext,
  type Outcome,
  type ServedPublisher,
  type ServedRequest,
  type ServedTurn,
  type TraceScope,
  READS_REFERENCES_KEY,
} from "@synadia-ai/agent-fabric";
import { NatsAgentError } from "@synadia-ai/agents";
import {
  exportScratchPad,
  resolveScratchPad,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  SpEnvFile,
  spEnvFilePath,
  spPort,
  type ScratchPadSettings,
} from "./scratchpad.js";

/** The extension's name, as the plugin's status output lists it. */
export const EXTENSION_NAME = "agent-fabric";

/** The name the proxy files Claude Code's calls under, and the served records carry. */
export const SERVED_HARNESS = "claude";

/** How long an answered turn waits for the `Stop` hook before `end` carries the reply's time. */
export const DEFAULT_STOP_WAIT_MS = 120_000;

/** The warning logged once at start when the plugin's identity is off. */
export const IDENTITY_OFF_WARNING =
  `${EXTENSION_NAME}: senderIdentity is off; trace records are signed, so none will be ` +
  "published and each counts as dropped on the heartbeat. Set senderIdentity to signed.";

/** The line logged for a prompt that arrives while no session is known. */
export const NO_SESSION_LINE =
  `${EXTENSION_NAME}: no Claude Code session id known for this prompt, so no served pair; ` +
  "its model calls stand as a harness thread of their own. Are the plugin's hooks registered?";

// Claude Code's session ids are UUIDs; the rule is the one the pre-split
// plugin checked before it published a pair (`isClaudeSessionId`,
// `agents/claude-code/src/session-id.ts` at `fbd16ab`): header-safe, so
// nothing a header value could never hold reaches the record.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** `true` iff `value` is shaped like a session id Claude Code would send. */
export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

/** One served prompt, from `promptAccepted` to `promptEnded`. */
interface Served {
  readonly request: ServedRequest;
  /** The scope tracing bound around the prompt's handler. */
  readonly scope: TraceScope;
  /** The session the pair names; absent when none was known. */
  readonly sessionId: string | undefined;
  /** The pair; absent when the add-on publishes no records or knew no session. */
  readonly turn: ServedTurn | undefined;
}

/** An answered prompt whose turn waits for the `Stop` hook. */
interface AwaitingStop {
  readonly sessionId: string;
  readonly turn: ServedTurn;
  /** When `reply` completed the request: `promptEnded`'s time. */
  readonly repliedAtMs: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

function stopWaitFrom(options: Readonly<Record<string, unknown>>): number {
  const value = options["stopWaitMs"];
  if (value === undefined) return DEFAULT_STOP_WAIT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new NatsAgentError(`${EXTENSION_NAME}: options.stopWaitMs must be a number of ms ≥ 0`);
  }
  return value;
}

/**
 * The factory: the module's default export. Called once by the plugin's
 * MCP server, before it connects, with what it knows then. Resolves
 * ScratchPad's settings (which may read the plugin's NATS context) and
 * builds the extension with them. Throws `NatsAgentError` for an edge
 * subject that can never be published to, or a `stopWaitMs` option that
 * is not a duration.
 *
 * `env` is where the variables are read from; a test passes its own.
 */
export async function fabricExtension(
  ctx: AgentExtensionContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentExtension> {
  return createFabricExtension(ctx, env, await resolveScratchPad(ctx, env));
}

/**
 * The extension, built synchronously from settings already resolved:
 * without `scratchPad`, tracing, the `served` pair and the guard alone.
 */
export function createFabricExtension(
  ctx: AgentExtensionContext,
  env: NodeJS.ProcessEnv = process.env,
  scratchPad?: ScratchPadSettings,
): AgentExtension {
  const edgeSubject = resolveEdgeSubject(ctx.options, env);
  const stopWaitMs = stopWaitFrom(ctx.options);
  const tracing = fabricTracing({ edgeSubject });
  const guard = loopGuard();
  const log = ctx.logger;

  // Made at `started`, from the plugin's client, which signs as the
  // plugin's identity. A prompt accepted before then gets no pair. With
  // the edge subject `null` (propagate-only) there is never one.
  let publisher: ServedPublisher | undefined;
  // The session Claude Code is in now, as the `SessionStart` hook last
  // reported it; the fallback when the plugin names none on a request.
  let currentSession: string | undefined;
  const served = new Map<string, Served>();
  // Answered turns in the order they were answered.
  const awaitingStop: AwaitingStop[] = [];

  const release = (waiting: AwaitingStop): void => {
    const at = awaitingStop.indexOf(waiting);
    if (at >= 0) awaitingStop.splice(at, 1);
    clearTimeout(waiting.timer);
  };

  let warnedIdentityOff = false;

  // ScratchPad's variables, in the file the package's hook names to the
  // Bash tool. Without the plugin's state directory there is no file to
  // name, and the skill's scripts/sp finds no configuration.
  let spEnv: SpEnvFile | undefined;
  if (scratchPad !== undefined) {
    if (ctx.settings.stateDir !== undefined) {
      spEnv = new SpEnvFile(spEnvFilePath(ctx.settings.stateDir, env));
    } else {
      log.warn(
        `${EXTENSION_NAME}: the plugin names no state directory, so the skill's ` +
          "scripts/sp gets no ScratchPad settings",
      );
    }
  }
  const writeSpEnv = (): void => {
    if (spEnv === undefined) return;
    try {
      spEnv.write();
    } catch (err) {
      log.warn(`${EXTENSION_NAME}: ScratchPad's settings for scripts/sp: ${String(err)}`);
    }
  };
  if (scratchPad !== undefined && spEnv !== undefined) {
    exportScratchPad(scratchPad, spEnv.vars);
    writeSpEnv();
  }
  const promptEnv = spEnv !== undefined ? new ServedPromptEnv(spEnv.vars) : undefined;
  const handOn = scratchPad !== undefined ? new ScratchPadHandOn() : undefined;

  return {
    name: EXTENSION_NAME,
    // The service: tracing first, so the guard runs inside the scope tracing
    // bound and a malformed pair is refused with 400 before the guard
    // looks; the plugin appends its own (the tools' scope) after these.
    // The ScratchPad extension's, last, remembers the references each
    // served prompt brings, which Claude Code may hand on.
    requestInterceptors: [
      tracing.requestInterceptor,
      guard.requestInterceptor,
      ...(handOn !== undefined ? [handOn.requestInterceptor] : []),
    ],
    // The client Claude Code's agent tools prompt through: the edge and the
    // pair, then the waiting mark. Both read the ambient scope, so the
    // order between them does not matter.
    promptInterceptors: [tracing.promptInterceptor, guard.promptInterceptor],
    heartbeatExtras: tracing.heartbeatExtras,
    ...(handOn !== undefined
      ? {
          // References in Claude Code's `prompt_agent`: granted to a
          // receiver that reads them, removed with a note for any other.
          toolExtensions: [handOn],
          // So a caller's `prompt_agent` hands references to Claude Code.
          metadata: { [READS_REFERENCES_KEY]: "true" },
        }
      : {}),

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
      if (scratchPad !== undefined && handOn !== undefined) {
        if (spEnv !== undefined) {
          spEnv.vars[SP_VARS.creator] = service.subject.prompt;
          writeSpEnv();
        }
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
            (spEnv !== undefined ? `, for the skill's scripts/sp through ${spEnv.path}` : ""),
        );
      }
    },

    async stopping() {
      // The plugin calls this before it fails the requests still open, and
      // no `Stop` will come any more: every turn ends here, an answered one
      // at its reply, an open one now.
      for (const waiting of [...awaitingStop]) {
        release(waiting);
        waiting.turn.settle("ok", waiting.repliedAtMs);
      }
      for (const [id, entry] of served) {
        served.delete(id);
        entry.turn?.settle("error");
      }
      // No served prompt any more, and no server to serve one.
      spEnv?.remove();
      await publisher?.flush();
    },

    events: {
      sessionStarted(sessionId) {
        if (isClaudeSessionId(sessionId)) currentSession = sessionId;
      },

      promptAccepted(request) {
        // In the handler's async context, inside the scope tracing bound.
        const scope = activeTrace();
        // From here to its end this prompt is the one Claude Code works on,
        // and the one `scripts/sp` works for.
        if (promptEnv !== undefined) {
          promptEnv.enter(request, scope);
          writeSpEnv();
        }
        if (scope === undefined) return;
        const named = request.sessionId ?? currentSession;
        const sessionId = isClaudeSessionId(named) ? named : undefined;
        let turn: ServedTurn | undefined;
        if (sessionId === undefined) {
          log.warn(NO_SESSION_LINE);
        } else {
          // `beginTurn` stamps the arrival now; `bind` publishes `start`.
          // The session is bound at arrival, so a `/clear` during the turn
          // does not move the binding.
          turn = publisher?.beginTurn(scope, SERVED_HARNESS);
          turn?.bind(sessionId);
        }
        served.set(request.id, { request, scope, sessionId, turn });
      },

      promptEnded(request, outcome: Outcome, atMs) {
        const entry = served.get(request.id);
        served.delete(request.id);
        if (promptEnv !== undefined) {
          // Claude Code may hold a second prompt in the same turn: the
          // variables go back to the latest one still open.
          promptEnv.leave(request);
          const open = [...served.values()].at(-1);
          if (open !== undefined) promptEnv.enter(open.request, open.scope);
          writeSpEnv();
        }
        if (entry === undefined) return;
        const { turn, sessionId } = entry;
        if (turn === undefined || sessionId === undefined) return;
        if (outcome !== "ok") {
          turn.settle(outcome, atMs);
          return;
        }
        // Answered, but Claude Code is still writing its closing text.
        const waiting: AwaitingStop = {
          sessionId,
          turn,
          repliedAtMs: atMs,
          timer: setTimeout(() => {
            release(waiting);
            turn.settle("ok", atMs);
          }, stopWaitMs),
        };
        waiting.timer.unref?.();
        awaitingStop.push(waiting);
      },

      turnStopped(sessionId, atMs) {
        // One `Stop` ends one turn of Claude Code's, and every prompt
        // answered in it before the stop: the oldest first, so two
        // prompts answered in one turn share its end, and a prompt
        // answered after this stop waits for the next.
        for (const waiting of [...awaitingStop]) {
          if (sessionId !== undefined && waiting.sessionId !== sessionId) continue;
          if (waiting.repliedAtMs >= atMs) continue;
          release(waiting);
          waiting.turn.settle("ok", atMs);
        }
      },

      aroundToolCall(request: ServedRequest | undefined, _toolName, run) {
        const scope = request === undefined ? undefined : served.get(request.id)?.scope;
        return scope === undefined
          ? run()
          : bindActiveTrace(scope, () => guard.aroundToolCall(scope, run));
      },
    },
  };
}
