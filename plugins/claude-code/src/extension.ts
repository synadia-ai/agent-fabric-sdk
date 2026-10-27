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
// subject: `start` naming the served thread and the session, and `end` with
// the outcome. The reader files the session's calls between the two under
// the thread, and cuts a pair's cover at the next `start` on the session.
//
// When a prompt starts. Claude Code queues typed text and NATS prompts
// alike behind its running turn, and takes a waiting one at that turn's
// next tool result (folded into it) or after its `Stop` (a turn of its
// own). The plugin follows that by the turns' prompt ids and reports
// `promptStarted`, with the time Claude Code took the prompt and the
// session the turn runs in: `start` is stamped there, not at the accept,
// so a prompt queued behind a typed turn never cuts that turn's cover. A
// prompt that ends before Claude Code took it (cancelled, expired while it
// waited) gets its pair too, `start` and `end` both stamped with the end of
// the turn running then, published after that turn's `end`, so no `start`
// lands inside a turn; with no turn running, at once, at its own end. "A
// turn runs", as the add-on sees it: a local turn is open, a started prompt
// is open, or an answered prompt waits for its turn's `Stop`.
//
// The turn does not end with the reply. After `reply` completes the
// request with `done`, Claude Code makes at least one more model call to
// write its closing text. So an `ok` turn stays pending until the plugin's
// `Stop` hook reports the turn's end (`turnStopped`) at a time after the
// reply, and `end` carries that time; with no `Stop` within the bound
// (`stopWaitMs`, 120 s by default) it carries the reply's. A failed or
// expired request ends at once. So does a request the plugin answered
// with the turn's final text (reason `final_text`): the model wrote no
// reply, and the plugin sends that text at the turn's `Stop`, which has
// already come. The plugin's reason for an end the model did not make
// itself goes on `end` as the record's `reason`; the add-on's own end of
// an open request at `stopping` carries `shutdown`.
//
// Local turns (§3.1, §3.4): a turn no served prompt started — typed at the
// terminal, or begun by Claude Code itself — is a thread too. At
// `localTurnStarted` the add-on mints a root for it (`rootTraceScope()`),
// opens the loop guard on it and, with the turn's session, publishes the
// root's `served` pair from the turn's start to its end
// (`localTurnEnded`), so the turn's model calls are filed under the root;
// its agent-tool calls run in the root's scope, so the agents it prompts
// hang beneath it, and a child that prompts Claude Code back during the
// turn is refused with `409`. No edge is written for the root itself: it is
// implicit, without a caller.
//
// The served request's scope is kept by the plugin's request id from
// `promptAccepted` to `promptEnded`, a local turn's by its id, and bound
// around every agent-tool call. For a served request the plugin already
// re-enters the handler's async context (a snapshot taken after the
// interceptors ran) before `aroundToolCall`, so the binding is a no-op
// rebind the add-on makes anyway. The `409` loop guard is the fabric
// package's two interceptors, after tracing's, and its `aroundToolCall`
// inside the add-on's, which lifts the mark once the request's calls have
// settled.
//
// ScratchPad (§9.13): when a volume is configured, the add-on keeps the
// variables the package's skill (`skills/scratchpad`, loaded with the
// package as a Claude Code plugin) reads through `scripts/sp` in a file the
// package's SessionStart hook names to the Bash tool: the connection, the
// workspace and the volume at start, and the trace and caller of the turn
// Claude Code runs (`scratchpad.ts`): the open local turn's, else the
// latest started served prompt's. A prompt accepted but not yet taken into
// a turn never holds them. It registers Claude Code as reading references,
// hands the references Claude Code's model puts into `prompt_agent` to the
// fabric package's ScratchPad extension, and answers grant requests for
// what Claude Code published, by an SDK-built agent's rule.

import {
  activeTrace,
  bindActiveTrace,
  fabricTracing,
  loopGuard,
  noSpWarning,
  spBinPassedOverWarning,
  resolveEdgeSubject,
  rootTraceScope,
  servedPublisher,
  type AgentExtension,
  type AgentExtensionContext,
  type EndReason,
  type LocalTurn,
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
  findSp,
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
  /** The session known at the accept: the request's, else the one the hook last reported. */
  readonly acceptedSession: string | undefined;
  /** Set at `promptStarted`: the order Claude Code took the prompts in. */
  started: number | undefined;
  /** The session the pair names; absent when none was known. */
  sessionId: string | undefined;
  /** The pair, from the start; absent when the add-on publishes no records or knew no session. */
  turn: ServedTurn | undefined;
}

/** A turn no served prompt started, from `localTurnStarted` to `localTurnEnded`. */
interface Local {
  readonly turn: LocalTurn;
  /** The minted root, the turn's scope. */
  readonly scope: TraceScope;
  /** Closes the loop guard's registration. */
  readonly close: () => void;
  /** The root's pair; absent without a session or a publisher. */
  readonly pair: ServedTurn | undefined;
}

/** A served prompt that ended before Claude Code took it into a turn. */
interface Held {
  readonly entry: Served;
  readonly outcome: Outcome;
  readonly reason: EndReason | undefined;
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
  // The order Claude Code took the served prompts in.
  let startCount = 0;
  // The open local turns, by the plugin's turn id: one at a time in practice.
  const locals = new Map<string, Local>();
  // Prompts that ended before Claude Code took them, waiting for no turn to run.
  const held: Held[] = [];
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

  // ScratchPad's variables follow the turn Claude Code runs: the open local
  // turn's, else the latest started served prompt's; none between turns.
  let holderId: string | undefined;
  const setHolder = (): void => {
    if (promptEnv === undefined) return;
    const local = [...locals.values()].at(-1);
    let latest: Served | undefined;
    for (const entry of served.values()) {
      if (
        entry.started !== undefined &&
        (latest === undefined || entry.started > latest.started!)
      ) {
        latest = entry;
      }
    }
    const next =
      local !== undefined
        ? { holder: local.turn, scope: local.scope }
        : latest !== undefined
          ? { holder: latest.request, scope: latest.scope }
          : undefined;
    if (next?.holder.id === holderId) return;
    if (next !== undefined) promptEnv.enter(next.holder, next.scope);
    else if (holderId !== undefined) promptEnv.leave({ id: holderId });
    holderId = next?.holder.id;
    writeSpEnv();
  };

  /**
   * Begin a pair for `scope` on session `named`, `start` stamped `atMs`:
   * the turn and the session it names, or `undefined` without a usable
   * session (logged) or a publisher.
   */
  const beginPair = (
    scope: TraceScope,
    named: string | undefined,
    atMs: number,
  ): { turn: ServedTurn | undefined; sessionId: string } | undefined => {
    if (!isClaudeSessionId(named)) {
      log.warn(NO_SESSION_LINE);
      return undefined;
    }
    // `beginTurn` stamps the start; `bind` publishes it. The session is
    // bound now, so a `/clear` during the turn does not move the binding.
    const turn = publisher?.beginTurn(scope, SERVED_HARNESS, atMs);
    turn?.bind(named);
    return { turn, sessionId: named };
  };

  /** A turn runs: a local turn is open, a started prompt is open, or an answered one waits for its `Stop`. */
  const turnRuns = (): boolean =>
    locals.size > 0 ||
    awaitingStop.length > 0 ||
    [...served.values()].some((entry) => entry.started !== undefined);

  /**
   * The pairs of the prompts that ended before Claude Code took them, once
   * no turn runs (or `force`, at stopping): `start` and `end` both stamped
   * `atMs`, the end of the turn that ran, oldest first.
   */
  const publishHeld = (atMs: number, force = false): void => {
    if (held.length === 0 || (!force && turnRuns())) return;
    for (const { entry, outcome, reason } of held.splice(0)) {
      beginPair(entry.scope, entry.acceptedSession, atMs)?.turn?.settle(outcome, atMs, reason);
    }
  };

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
        const lookup = findSp(env);
        // A SCRATCHPAD_BIN that is set but unusable breaks the skill's scripts/sp.
        const passedOver = spBinPassedOverWarning(EXTENSION_NAME, lookup);
        if (passedOver !== undefined) log.warn(passedOver);
        if (port !== undefined) handOn.start({ scratchPad: port, agents, service, logger: log });
        else {
          // No sp of its own (`findSp`): nothing can be granted, never a turn.
          handOn.startWithoutScratchPad();
          log.warn(noSpWarning(EXTENSION_NAME, lookup));
        }
        log.info(
          `${EXTENSION_NAME}: ScratchPad volume ${scratchPad.volume}` +
            (scratchPad.dir !== undefined ? `, workspace ${scratchPad.dir}` : ", no workspace") +
            (spEnv !== undefined ? `, for the skill's scripts/sp through ${spEnv.path}` : ""),
        );
      }
    },

    async stopping() {
      // The plugin calls this before it fails the requests still open, and
      // no `Stop` will come any more: every turn ends here. The open local
      // turn first (the plugin has normally ended it already), then the
      // prompts that ended before Claude Code took them, at the same
      // instant, then the served ones: an answered one at its reply, an
      // open one now; one never taken into a turn gets its pair now.
      const now = Date.now();
      for (const [id, local] of locals) {
        locals.delete(id);
        local.pair?.settle("ok", now);
        local.close();
      }
      publishHeld(now, true);
      for (const waiting of [...awaitingStop]) {
        release(waiting);
        waiting.turn.settle("ok", waiting.repliedAtMs);
      }
      for (const [id, entry] of served) {
        served.delete(id);
        if (entry.started !== undefined) entry.turn?.settle("error", undefined, "shutdown");
        else
          beginPair(entry.scope, entry.acceptedSession, now)?.turn?.settle(
            "error",
            now,
            "shutdown",
          );
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
        // Kept until Claude Code takes the prompt into a turn: a prompt that
        // waits behind a running turn starts nothing yet, neither a pair nor
        // ScratchPad's variables.
        const scope = activeTrace();
        if (scope === undefined) return;
        const named = request.sessionId ?? currentSession;
        served.set(request.id, {
          request,
          scope,
          acceptedSession: isClaudeSessionId(named) ? named : undefined,
          started: undefined,
          sessionId: undefined,
          turn: undefined,
        });
      },

      promptStarted(request, atMs, sessionId) {
        // Claude Code took the prompt into a turn: its own, or the running
        // one at a fold. The pair starts here, on the turn's session.
        const entry = served.get(request.id);
        if (entry === undefined || entry.started !== undefined) return;
        entry.started = ++startCount;
        const pair = beginPair(
          entry.scope,
          isClaudeSessionId(sessionId) ? sessionId : entry.acceptedSession,
          atMs,
        );
        entry.turn = pair?.turn;
        entry.sessionId = pair?.sessionId;
        setHolder();
      },

      promptEnded(request, outcome: Outcome, atMs, reason?: EndReason) {
        const entry = served.get(request.id);
        served.delete(request.id);
        setHolder();
        if (entry === undefined) return;
        if (entry.started === undefined) {
          // Ended while it waited: its pair goes out once no turn runs, never
          // with a `start` inside a turn.
          held.push({ entry, outcome, reason });
          publishHeld(atMs);
          return;
        }
        const { turn, sessionId } = entry;
        if (turn === undefined || sessionId === undefined) {
          publishHeld(atMs);
          return;
        }
        // A failure ends at once, and so does an answer the plugin sent from
        // the turn's final text: it comes at the turn's `Stop`, so the turn
        // is already over.
        if (outcome !== "ok" || reason === "final_text") {
          turn.settle(outcome, atMs, reason);
          publishHeld(atMs);
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
            publishHeld(atMs);
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
        publishHeld(atMs);
      },

      localTurnStarted(turn, atMs) {
        // A turn no served prompt started: a root of its own, guarded like a
        // served request, its pair on the turn's session, until it ends.
        if (locals.has(turn.id)) return;
        const scope = rootTraceScope();
        const close = guard.open(scope);
        let pair: ServedTurn | undefined;
        if (isClaudeSessionId(turn.sessionId)) {
          pair = publisher?.beginTurn(scope, SERVED_HARNESS, atMs);
          pair?.bind(turn.sessionId);
        }
        locals.set(turn.id, { turn, scope, close, pair });
        setHolder();
      },

      localTurnEnded(turn, outcome, atMs) {
        const local = locals.get(turn.id);
        if (local === undefined) return;
        locals.delete(turn.id);
        local.pair?.settle(outcome, atMs);
        local.close();
        // After the local `end`: the prompts that ended while it ran.
        publishHeld(atMs);
        setHolder();
      },

      aroundToolCall(work: ServedRequest | LocalTurn | undefined, _toolName, run) {
        const scope =
          work === undefined
            ? undefined
            : (locals.get(work.id)?.scope ?? served.get(work.id)?.scope);
        return scope === undefined
          ? run()
          : bindActiveTrace(scope, () => guard.aroundToolCall(scope, run));
      },
    },
  };
}
