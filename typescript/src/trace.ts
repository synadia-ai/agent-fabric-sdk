// Tracing for the Synadia Agent Fabric — the vocabulary shared by the caller
// side and the host side (`tracing.ts` builds the SDK's hooks from it).
// Mirrors `synadia_ai/agent_fabric/trace.py` in the Python package; the two
// must stay wire-identical.
//
// The ambient binding is what lets a client used as a tool inside a prompt
// handler inherit lineage with no plumbing through user code:
// AsyncLocalStorage flows into awaited work and into tasks created inside
// the bound scope (Node and Bun alike).
//
// A thread ID names one prompt execution: minted by the caller at
// `prompt()` time, 128-bit random as 32 lowercase hex characters, and
// adopted by the receiving service. `rootId` has the same shape — it IS a
// thread ID, the tree's first execution.

import { AsyncLocalStorage } from "node:async_hooks";
import { NatsAgentError, type AgentId } from "@synadia-ai/agents";

// Bump every time you change the trace record schema
// (be sure the Python package is updated in lockstep)
export const EDGE_RECORD_VERSION = 1;

/** Default subject edge records are published to — the tenant-side short
 * form; the account's import qualifies it to `TRACE.{account}.edges`. */
export const DEFAULT_EDGE_SUBJECT = "TRACE.edges";

/** The envelope fields that carry the lineage to the receiver. */
export const THREAD_ID_FIELD = "thread_id";
export const ROOT_ID_FIELD = "root_id";

/** The headers an agent stamps on its model requests (see {@link traceHeaders}). */
export const THREAD_ID_HEADER = "X-Synadia-Thread-ID";
export const ROOT_ID_HEADER = "X-Synadia-Root-ID";

/**
 * Tracing configuration for {@link fabricTracing}; `{}` takes every
 * default.
 */
export interface TraceOptions {
  /**
   * Where edge records are published. `null` selects propagate-only mode
   * — mint IDs and forward lineage, but publish no edge records.
   */
  readonly edgeSubject?: string | null;
}

// Spelled out rather than `\s`, which means different things in the two
// languages: JavaScript's includes U+FEFF and Python's does not, Python's
// includes the C0 separators and JavaScript's does not. An explicit class
// is the only way the two packages reject exactly the same subjects.
// Shared with `served.ts`, whose harness thread id is held to the same
// class; not part of the package's surface.
export const SUBJECT_FORBIDDEN =
  /[\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;

/**
 * Throws {@link NatsAgentError} when `options.edgeSubject` names a subject
 * that can never be published to: empty, an empty token, whitespace or
 * NUL, or a wildcard. Publishing is fail-open, so without this check a
 * misconfigured subject would only ever show up as a warning on every
 * prompt; checking where the options are accepted makes it fail at
 * construction instead.
 */
export function assertValidTraceOptions(options: TraceOptions | undefined): void {
  if (options === undefined) return;
  const subject = options.edgeSubject;
  if (subject === undefined || subject === null) return;
  const reject = (reason: string): never => {
    throw new NatsAgentError(`trace.edgeSubject ${JSON.stringify(subject)}: ${reason}`);
  };
  if (typeof subject !== "string") reject("must be a string or null");
  if (subject.length === 0) reject("must not be empty");
  for (const token of subject.split(".")) {
    if (token.length === 0) reject("must not contain an empty token");
    if (SUBJECT_FORBIDDEN.test(token)) reject("must not contain whitespace or control characters");
    if (token.includes("*") || token.includes(">")) reject("must not contain wildcards");
  }
}

/**
 * How many trace records this process has published and dropped so far —
 * `edge` records today, counted from process start. Process-wide, not per
 * client: the records are written by whichever client a prompt handler
 * happens to use, while the agent service that owns the heartbeat is
 * another object; one counter for the process is the one they share. The
 * host reports both numbers as `records_published` and `records_dropped`
 * in its heartbeat's extras (`fabricTracing().heartbeatExtras`), so
 * whoever consumes the heartbeat knows how many records this process
 * failed to publish.
 */
export interface TraceRecordCounts {
  /**
   * Records handed to the connection for publishing. Handed, not
   * delivered: a record lost after that — a reconnect buffer that
   * overflowed, a process that exited before the flush — is not seen
   * here. The counts cover what this process could observe; nothing past
   * the connection is visible to them.
   */
  readonly published: number;
  /**
   * Records that were due but never went out: no identity to sign them
   * with, or a publish that threw. "Due" means the prompt the record
   * describes actually went out — a prompt never iterated or rejected by
   * validation owes no record and counts nothing. A record in
   * propagate-only mode (`edgeSubject: null`) is never due either.
   */
  readonly dropped: number;
}

interface MutableCounters {
  published: number;
  dropped: number;
}

// Kept on `globalThis` under a well-known symbol rather than in module
// state: a deployment can end up with two installed copies of this module
// (a harness pinning its own version, or the ESM and CJS builds both
// loaded), and the copy whose caller interceptor counts need not be the
// copy whose heartbeat provider reads. Module state would split the
// counter between the copies and the heartbeat would report 0/0 while
// records were being dropped. One process, one counter, whichever copy
// asks.
const COUNTERS_KEY = Symbol.for("@synadia-ai/agent-fabric:trace-record-counts");
const counters: MutableCounters = (() => {
  const g = globalThis as unknown as Record<symbol, MutableCounters | undefined>;
  return (g[COUNTERS_KEY] ??= { published: 0, dropped: 0 });
})();

/** Count one trace record published. Called by the edge publisher. */
export function countTraceRecordPublished(): void {
  counters.published += 1;
}

/** Count one trace record dropped. Called by the edge publisher. */
export function countTraceRecordDropped(): void {
  counters.dropped += 1;
}

/** A snapshot of the process-wide {@link TraceRecordCounts}. */
export function traceRecordCounts(): TraceRecordCounts {
  return Object.freeze({ published: counters.published, dropped: counters.dropped });
}

/** Identity of the prompt execution running in the current async context. */
export interface TraceScope {
  /** This execution's own thread ID — the parent of any thread it spawns. */
  readonly threadId: string;
  /** The tree's root thread ID, inherited unchanged; equals `threadId` on a root. */
  readonly rootId: string;
  /**
   * Where in this execution any thread it spawns next was sent out: how
   * many times it has stamped trace headers on a model request so far.
   * Deliberately mutable and shared — work spawned inside the handler
   * holds the same scope object, so its turns count against this
   * execution.
   */
  turnCountHint: number;
}

// Kept on `globalThis` under a well-known symbol, for the reason the
// counters above are: the scope is bound by the host interceptor and read
// by a client's prompt interceptor used as a tool inside the handler, and
// the two can come from different installed copies of this module — a
// nested install, a harness pinning its own version, the ESM and CJS
// builds both loaded. One AsyncLocalStorage per copy would keep the scope
// the host bound invisible to the client, and every child thread would
// silently become a root. One process, one storage, whichever copy asks.
const STORAGE_KEY = Symbol.for("@synadia-ai/agent-fabric:trace-scope");
const storage: AsyncLocalStorage<TraceScope> = (() => {
  const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<TraceScope> | undefined>;
  return (g[STORAGE_KEY] ??= new AsyncLocalStorage<TraceScope>());
})();

/**
 * Run `fn` with `scope` as the ambient execution (what the host
 * interceptor does around a prompt handler). AsyncLocalStorage restores
 * the previous binding on exit, so nothing leaks into the next request.
 */
export function bindActiveTrace<T>(scope: TraceScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The ambient {@link TraceScope}, or `undefined` outside a bound handler. */
export function activeTrace(): TraceScope | undefined {
  return storage.getStore();
}

/**
 * Headers for every model request this execution issues.
 *
 * An agent stamps these on each completion request so the model proxy
 * files the call under the right thread and tree without seeing any NATS
 * traffic. Hierarchy is the edge records' job, so the proxy needs no
 * parent or tool-call header.
 *
 * `{}` outside a traced handler, so harness code needs no plumbing and
 * degrades to nothing.
 *
 * Each call counts against this execution: the running total is recorded
 * on the edge of any thread it spawns afterwards.
 */
export function traceHeaders(): Record<string, string> {
  const scope = activeTrace();
  if (scope === undefined) return {};
  scope.turnCountHint += 1;
  return {
    [THREAD_ID_HEADER]: scope.threadId,
    [ROOT_ID_HEADER]: scope.rootId,
  };
}

/** Length in hex characters of a thread ID — 128 bits. */
export const THREAD_ID_HEX_LEN = 32;

const THREAD_ID_RE = new RegExp(`^[0-9a-f]{${THREAD_ID_HEX_LEN}}$`);

/**
 * `true` iff `value` has the shape of a thread ID: exactly
 * {@link THREAD_ID_HEX_LEN} lowercase hex characters. Ids arriving on the
 * wire are untrusted input that ends up in the headers an agent stamps on
 * its model requests, so a receiver adopts nothing that is not shaped
 * exactly like what the packages mint.
 */
export function isThreadId(value: string): boolean {
  return THREAD_ID_RE.test(value);
}

export function randomThreadId(): string {
  // Thread IDs don't need to be secure and any random generator will
  // suffice. Still, using crypto.getRandomValues() doesn't cost us much.
  const bytes = new Uint8Array(THREAD_ID_HEX_LEN / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * A fresh root: a scope whose thread is its own root, minted here, with no
 * model call counted yet. What a receiver mints for an envelope that names
 * no thread, and what a harness add-on binds around a local turn, a turn
 * the harness runs that no served prompt started.
 */
export function rootTraceScope(): TraceScope {
  const threadId = randomThreadId();
  return { threadId, rootId: threadId, turnCountHint: 0 };
}

/** Longest accepted tool call id, in Unicode code points. */
export const TOOL_CALL_ID_MAX = 256;

// A surrogate half with no partner: not a Unicode scalar value, so it has
// no UTF-8 form. `JSON.stringify` would escape it while Python could not
// encode the record at all, and the two packages must write the same bytes.
// Shared with `served.ts`; not part of the package's surface.
export const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function validToolCallId(toolCallId: string): boolean {
  // This isn't intended as strict validation. It's just a basic
  // pass to avoid obvious garbage gets into the tracing system.
  // Counted in code points — not UTF-16 units — so the Python package,
  // whose `len()` counts code points, accepts exactly the same ids.
  if (LONE_SURROGATE.test(toolCallId)) return false;
  const codePoints = Array.from(toolCallId).length;
  return codePoints > 0 && codePoints <= TOOL_CALL_ID_MAX;
}

/** One built edge record: its wire bytes and the id that de-duplicates it. */
export interface BuiltEdgeRecord {
  readonly recordId: string;
  readonly payload: Uint8Array;
}

/**
 * One edge record, ready to publish. The record id comes back alongside
 * the payload: the publisher signs with it as the `Agent-Sender` nonce,
 * which the SDK's signed publish also stamps as `Nats-Msg-Id`, so body,
 * header and message id carry one id and a stream de-duplicates a record
 * it already stored. Its 32 hex characters fit the nonce's
 * `[A-Za-z0-9_-]{1,64}`.
 *
 * `agent` is the writer — the caller that spawned the thread, the parent
 * side of the edge — in canonical `{account}.{user}` form. It is the same
 * identity that signs the record's `Agent-Sender` header, so a consumer
 * can cross-check the body against the verified header.
 */
export function buildEdgeRecord(
  agent: AgentId,
  threadId: string,
  parentId: string | null,
  rootId: string,
  toolCallId: string | null,
  turnCountHint: number,
): BuiltEdgeRecord {
  // `turnCountHint` says where in the spawning thread this subprompt went
  // out: turns completed when it was spawned, 0 on a root (nothing spawned
  // it). A position marker, not a total — turns the parent takes after its
  // last spawn are recorded nowhere.
  const recordId = randomThreadId();
  const record = {
    version: EDGE_RECORD_VERSION,
    kind: "edge",
    record_id: recordId,
    ts: Math.floor(Date.now() / 1000),
    agent,
    thread_id: threadId,
    parent_id: parentId,
    root_id: rootId,
    tool_call_id: toolCallId,
    turn_count_hint: turnCountHint,
  };
  return { recordId, payload: new TextEncoder().encode(JSON.stringify(record)) };
}
