// The `served` record — a harness plugin's binding of one prompt execution
// to the harness's own thread id, two per received prompt (afo-design.md
// §8.3; the contract is `docs/schemas/served.json`, vendored under
// `test-fixtures/schemas/`). Mirrors `synadia_ai/agent_fabric/served.py`
// in the Python package; the two must stay wire-identical.
//
// An SDK-built agent stamps the thread on every model request it makes
// (`traceHeaders()`), so the proxy files those calls under the thread the
// caller minted. A harness makes its own model calls, and its plugin cannot
// put a header on them: OpenClaw's carry the W3C `traceparent` of the turn,
// Claude Code's the session id. The plugin publishes the binding instead —
// one record at `start`, stamped with the prompt's arrival and naming the
// thread and the harness's id, bare, under the harness's name, and one at
// `end` with the outcome. The proxy files the harness's calls under the
// same id, so the reader attaches the calls made between the two records
// to the thread, and gets the thread's outcome and duration with them.
//
// Both records are signed with the plugin's own identity, which is also
// the record's `agent`, and carry one id as body `record_id`, header nonce
// and `Nats-Msg-Id`, like the edge record; they count on the same
// process-wide trace record counts the host reports on its heartbeat.
// Publishing is asynchronous and fail-open: a prompt is never delayed or
// failed by it.

import {
  SenderSignatureRequiredError,
  type AgentId,
  type Agents,
  type Logger,
} from "@synadia-ai/agents";
import {
  countTraceRecordDropped,
  countTraceRecordPublished,
  DEFAULT_EDGE_SUBJECT,
  LONE_SURROGATE,
  randomThreadId,
  SUBJECT_FORBIDDEN,
  type TraceScope,
} from "./trace.js";

// Bump every time you change the served record schema
// (be sure the Python package is updated in lockstep)
export const SERVED_RECORD_VERSION = 1;

/**
 * The harnesses whose plugins write `served` records: the ones that cannot
 * put the fabric's headers on their own model calls. PI can, and writes
 * none. The value is what the proxy files the harness's calls under
 * (afo-design.md §8.1).
 */
export type Harness = "claude" | "openclaw";

const HARNESSES: ReadonlySet<string> = new Set<Harness>(["claude", "openclaw"]);

/** `start` when the prompt arrives, `end` when the turn is over. */
export type ServedPhase = "start" | "end";

const PHASES: ReadonlySet<string> = new Set<ServedPhase>(["start", "end"]);

/** How the turn ended: answered, failed, or expired on the request's TTL. */
export type ServedStatus = "ok" | "error" | "timeout";

const STATUSES: ReadonlySet<string> = new Set<ServedStatus>(["ok", "error", "timeout"]);

/** Longest accepted harness thread id, in Unicode code points. */
export const HARNESS_THREAD_ID_MAX = 256;

/**
 * `true` iff `value` can be the harness thread id a served record names:
 * a non-empty string of at most {@link HARNESS_THREAD_ID_MAX} code points
 * — counted as the Python package's `len()` counts, not in UTF-16 units —
 * with no whitespace or control character (the class the SDK holds a
 * subject token to: the id is matched against a header value the proxy
 * saw, and a header value can never hold those) and no lone surrogate,
 * which has no UTF-8 form. Claude Code's session id and OpenClaw's 32-hex
 * trace id pass; the packages accept exactly the same ids.
 */
export function validHarnessThreadId(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (SUBJECT_FORBIDDEN.test(value)) return false;
  if (LONE_SURROGATE.test(value)) return false;
  return Array.from(value).length <= HARNESS_THREAD_ID_MAX;
}

/** Now, in unix seconds — the served record's `ts` resolution. */
export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** One built served record: its wire bytes and the id that de-duplicates it. */
export interface BuiltServedRecord {
  readonly recordId: string;
  readonly payload: Uint8Array;
}

/**
 * One served record, ready to publish. The record id comes back alongside
 * the payload: the publisher signs with it as the `Agent-Sender` nonce,
 * which the SDK's signed publish also stamps as `Nats-Msg-Id`, so body,
 * header and message id carry one id and a stream de-duplicates a record
 * it already stored. Its 32 hex characters fit the nonce's
 * `[A-Za-z0-9_-]{1,64}`.
 *
 * `agent` is the plugin's own identity, the executing agent, in canonical
 * `{account}.{user}` form — the same identity that signs the record.
 * `threadId` and `rootId` are the served prompt's, from its scope.
 * `harnessThreadId` is the harness's own id, bare — never prefixed — and
 * must pass {@link validHarnessThreadId}. `status` is required on `end`
 * and must be absent on `start`. `ts` is unix seconds: when the prompt
 * arrived for `start`, when the turn ended for `end`; now by default.
 *
 * Throws `Error` for a record the contract would refuse, so a plugin's
 * mistake is its own and never a malformed record on the wire.
 */
export function buildServedRecord(
  agent: AgentId,
  threadId: string,
  rootId: string,
  harness: Harness,
  harnessThreadId: string,
  phase: ServedPhase,
  status?: ServedStatus,
  ts: number = unixSeconds(),
): BuiltServedRecord {
  if (!HARNESSES.has(harness)) {
    throw new Error(`buildServedRecord: harness must be "claude" or "openclaw", got ${harness}`);
  }
  if (!PHASES.has(phase)) {
    throw new Error(`buildServedRecord: phase must be "start" or "end", got ${phase}`);
  }
  if (phase === "end" && status === undefined) {
    throw new Error("buildServedRecord: an end record needs a status");
  }
  if (phase === "start" && status !== undefined) {
    throw new Error("buildServedRecord: a start record carries no status");
  }
  if (status !== undefined && !STATUSES.has(status)) {
    throw new Error(`buildServedRecord: status must be "ok", "error" or "timeout", got ${status}`);
  }
  if (!validHarnessThreadId(harnessThreadId)) {
    throw new Error("buildServedRecord: harnessThreadId is not a usable harness thread id");
  }
  if (!Number.isInteger(ts) || ts < 0) {
    throw new Error("buildServedRecord: ts must be a non-negative integer of unix seconds");
  }
  const recordId = randomThreadId();
  const record = {
    version: SERVED_RECORD_VERSION,
    kind: "served",
    record_id: recordId,
    ts,
    agent,
    thread_id: threadId,
    root_id: rootId,
    harness,
    harness_thread_id: harnessThreadId,
    phase,
    ...(status !== undefined ? { status } : {}),
  };
  return { recordId, payload: new TextEncoder().encode(JSON.stringify(record)) };
}

export interface ServedPublisherOptions {
  /**
   * The plugin's own client: it signs every record as its identity, which
   * is also the record's `agent`. Without a signer nothing is published —
   * an unsigned record cannot be attributed — the publisher warns once and
   * each record owed counts as dropped.
   */
  readonly agents: Agents;
  /**
   * Where the records go: the edge subject, the same the plugin's tracing
   * runs with. {@link DEFAULT_EDGE_SUBJECT} by default.
   */
  readonly subject?: string;
  /** Where a refused binding or a failed publish is reported; the console by default. */
  readonly logger?: Logger;
}

/**
 * One prompt's served pair. `bind` names the harness thread id once and
 * publishes `start`, stamped with the prompt's arrival — the moment
 * {@link ServedPublisher.beginTurn} was called — however late the id
 * becomes known; `settle` records the outcome when the turn ends and
 * publishes `end` if the id is known. An id bound after settling is
 * refused: the pair is the turn's window, not something to backfill. Both
 * are synchronous and return at once; the records go out behind them.
 */
export interface ServedTurn {
  /**
   * The harness's own id for this prompt's turn, bare. An unusable id
   * (see {@link validHarnessThreadId}) is refused with a warning and the
   * prompt gets no pair; a second binding is ignored, with a warning when
   * it names another id.
   */
  bind(harnessThreadId: string): void;
  /**
   * End the turn. `atMs` is the turn's end in milliseconds since the epoch,
   * as the plugin's events report it; now by default. A second call does
   * nothing.
   */
  settle(status: ServedStatus, atMs?: number): void;
}

const defaultLogger = (): Logger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: (msg, ctx) => console.warn(`@synadia-ai/agent-fabric: ${msg}`, ctx ?? ""),
  error: (msg, ctx) => console.error(`@synadia-ai/agent-fabric: ${msg}`, ctx ?? ""),
});

/**
 * Publishes served records through the plugin's client, one after another
 * in the order they were due, so a pair's `end` never overtakes its
 * `start` on the wire and two prompts' pairs interleave as they happened.
 * See {@link servedPublisher}.
 */
export class ServedPublisher {
  readonly #agents: Agents;
  readonly #subject: string;
  readonly #logger: Logger;
  #unsignedWarned = false;
  // Records are built, signed and handed to the connection one after
  // another, in the order they were due. A failed record never rejects the
  // chain: `#send` catches everything.
  #chain: Promise<void> = Promise.resolve();

  constructor(options: ServedPublisherOptions) {
    this.#agents = options.agents;
    this.#subject = options.subject ?? DEFAULT_EDGE_SUBJECT;
    this.#logger = options.logger ?? defaultLogger();
  }

  /** Where the records go. */
  get subject(): string {
    return this.#subject;
  }

  /**
   * Start a prompt's pair: `scope` is the served prompt's trace scope —
   * the one the fabric's request interceptor bound around the handler,
   * `activeTrace()` inside it — and `harness` the one whose id `bind` will
   * name. The arrival, `start`'s `ts`, is now.
   */
  beginTurn(scope: TraceScope, harness: Harness): ServedTurn {
    const arrivedAt = unixSeconds();
    let harnessThreadId: string | undefined;
    let settled = false;
    return {
      bind: (id: string): void => {
        if (settled) {
          this.#logger.warn(
            "served: harness thread id bound after the turn ended; no served record",
          );
          return;
        }
        if (harnessThreadId !== undefined) {
          if (id !== harnessThreadId) {
            this.#logger.warn("served: harness thread id already bound for this prompt; ignored");
          }
          return;
        }
        if (!validHarnessThreadId(id)) {
          this.#logger.warn("served: unusable harness thread id bound; no served record");
          return;
        }
        harnessThreadId = id;
        void this.publish(scope, harness, id, "start", undefined, arrivedAt);
      },
      settle: (status: ServedStatus, atMs?: number): void => {
        if (settled) return;
        settled = true;
        if (harnessThreadId === undefined) return;
        const ts = atMs === undefined ? unixSeconds() : Math.floor(atMs / 1000);
        void this.publish(scope, harness, harnessThreadId, "end", status, ts);
      },
    };
  }

  /**
   * Publish one signed record, after every record handed over before it.
   * Fail-open and asynchronous: the returned promise never rejects and
   * nothing awaits it on the prompt path. A record that cannot go out — no
   * signer, a client already closed, a publish that threw — is logged and
   * counts as dropped; one that went out counts as published. Every record
   * moves the process-wide {@link traceRecordCounts}.
   */
  publish(
    scope: TraceScope,
    harness: Harness,
    harnessThreadId: string,
    phase: ServedPhase,
    status: ServedStatus | undefined,
    ts: number,
  ): Promise<void> {
    const next = this.#chain.then(() =>
      this.#send(scope, harness, harnessThreadId, phase, status, ts),
    );
    this.#chain = next;
    return next;
  }

  /**
   * Resolves once every record handed to `publish` so far has been signed
   * and handed to the connection, or dropped. For shutdown and tests.
   */
  flush(): Promise<void> {
    return this.#chain;
  }

  async #send(
    scope: TraceScope,
    harness: Harness,
    harnessThreadId: string,
    phase: ServedPhase,
    status: ServedStatus | undefined,
    ts: number,
  ): Promise<void> {
    try {
      const agent = await this.#agents.selfId();
      const record = buildServedRecord(
        agent,
        scope.threadId,
        scope.rootId,
        harness,
        harnessThreadId,
        phase,
        status,
        ts,
      );
      await this.#agents.publishSigned(this.#subject, record.payload, { nonce: record.recordId });
      countTraceRecordPublished();
    } catch (err) {
      countTraceRecordDropped();
      if (isSignatureRequired(err)) {
        // Consumers ignore unsigned records, so publishing without a
        // signer would be pure waste. One warning per publisher: a
        // per-prompt log would itself disturb the agent.
        if (this.#unsignedWarned) return;
        this.#unsignedWarned = true;
        this.#logger.warn(
          "served: no identity signer is configured; served records are not published " +
            "(consumers ignore unsigned records). Pass identity: { signer } to sign them.",
        );
        return;
      }
      this.#logger.warn("served: failed to publish served record", {
        subject: this.#subject,
        phase,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * `true` for the client's refusal to publish without a signer. By `name` as
 * well as by class: an add-on hands this publisher the plugin's `Agents`,
 * which runs on the plugin's own copy of the SDK and throws that copy's
 * class (`docs/plugins.md` §2.7), the way the host recognizes a
 * `RequestRejectedError` from another copy.
 */
function isSignatureRequired(err: unknown): boolean {
  return (
    err instanceof SenderSignatureRequiredError ||
    (err instanceof Error && err.name === "SenderSignatureRequiredError")
  );
}

/**
 * The served records' publisher for a harness plugin's add-on, over the
 * plugin's own client: `agents.publishSigned` with the record id as nonce,
 * on `subject` ({@link DEFAULT_EDGE_SUBJECT} by default), the records in
 * the order they were due, every one counted on the process-wide
 * {@link traceRecordCounts}. Per served prompt the add-on calls
 * {@link ServedPublisher.beginTurn} with the prompt's scope, `bind`s the
 * harness's id once it knows it, and `settle`s with the outcome;
 * {@link ServedPublisher.flush} before the plugin stops.
 */
export function servedPublisher(options: ServedPublisherOptions): ServedPublisher {
  return new ServedPublisher(options);
}
