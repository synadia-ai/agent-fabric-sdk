// Tracing on the protocol SDK's hooks: `fabricTracing()` returns the three
// things the SDK takes — a prompt interceptor for `Agents`, a request
// interceptor and a heartbeat extras provider for `AgentService` — built
// from the vocabulary in `trace.ts`. Mirrors
// `synadia_ai/agent_fabric/tracing.py`; the two must stay wire-identical.
//
// The caller side, per prompt:
//   - phase one (`beforePrompt`, in the async context `prompt()` was called
//     in) mints the new thread's ID and inherits root and parent from the
//     ambient scope — a root when none is bound — and adds `thread_id` and
//     `root_id` to the envelope. The parent stays in the edge record and
//     never transits the child;
//   - phase two (`beforePublish`, after the prompt is signed and its size
//     checked, immediately before it is published) builds and publishes
//     the signed edge record, so an observer sees the node before it runs
//     and a prompt that never goes out owes no record.
//
// The host side, per request: adopt the envelope's pair, mint a root when
// there is none, refuse a half pair or a malformed ID with `400` before the
// handler runs, and run the handler inside the scope — which is what
// `traceHeaders()` reads, and what a traced client used inside the handler
// inherits. The host writes no record.

import { RequestRejectedError, type RequestInterceptor } from "@synadia-ai/agent-service";
import type { PromptInterceptor, PromptInterceptorContext } from "@synadia-ai/agents";
import {
  activeTrace,
  assertValidTraceOptions,
  bindActiveTrace,
  buildEdgeRecord,
  countTraceRecordDropped,
  countTraceRecordPublished,
  DEFAULT_EDGE_SUBJECT,
  isThreadId,
  randomThreadId,
  rootTraceScope,
  ROOT_ID_FIELD,
  THREAD_ID_FIELD,
  THREAD_ID_HEX_LEN,
  traceRecordCounts,
  validToolCallId,
  type TraceOptions,
  type TraceScope,
} from "./trace.js";

/** The key of `PromptOptions.context` the caller interceptor reads the tool call ID from. */
export const TOOL_CALL_ID_CONTEXT_KEY = "toolCallId";

/** What {@link fabricTracing} returns: the SDK's three hooks, ready to pass in. */
export interface FabricTracing {
  /** For the caller: `new Agents({ ..., interceptors: [tracing.promptInterceptor] })`. */
  readonly promptInterceptor: PromptInterceptor;
  /** For the host: `new AgentService({ ..., interceptors: [tracing.requestInterceptor] })`. */
  readonly requestInterceptor: RequestInterceptor;
  /**
   * For the host: `new AgentService({ ..., heartbeatExtras: tracing.heartbeatExtras })`.
   * `records_published` and `records_dropped` — the process-wide
   * {@link traceRecordCounts} — read fresh for every heartbeat and status
   * reply. `{}` in propagate-only mode, which publishes no records and
   * would otherwise report a constant 0/0 that looks like a healthy zero.
   */
  readonly heartbeatExtras: () => Readonly<Record<string, unknown>>;
}

/**
 * Tracing for an agent on the fabric, as the protocol SDK's hooks.
 *
 * Throws `NatsAgentError` for an `edgeSubject` that can never be published
 * to (see {@link assertValidTraceOptions}). `options.edgeSubject` defaults
 * to {@link DEFAULT_EDGE_SUBJECT}; `null` is propagate-only mode.
 */
export function fabricTracing(options: TraceOptions = {}): FabricTracing {
  assertValidTraceOptions(options);
  const edgeSubject =
    options.edgeSubject === undefined ? DEFAULT_EDGE_SUBJECT : options.edgeSubject;
  return {
    promptInterceptor: promptInterceptor(edgeSubject),
    requestInterceptor,
    heartbeatExtras:
      edgeSubject === null
        ? () => ({})
        : () => {
            const counts = traceRecordCounts();
            return { records_published: counts.published, records_dropped: counts.dropped };
          },
  };
}

/**
 * What phase one decided to record; built into a record in phase two. The
 * lineage is fixed when the prompt is planned — when the ambient trace is
 * still the caller's — but the record's `ts` and `agent` are resolved
 * immediately before the publish.
 */
interface EdgePlan {
  readonly threadId: string;
  readonly parentId: string | null;
  readonly rootId: string;
  readonly toolCallId: string | null;
  readonly turnCountHint: number;
}

function promptInterceptor(edgeSubject: string | null): PromptInterceptor {
  return {
    beforePrompt(ctx) {
      // Tracing is best-effort and shouldn't stop an agent from sending out
      // a prompt. Invalid tool call ids are just ignored.
      const raw = ctx.context[TOOL_CALL_ID_CONTEXT_KEY];
      const toolCallId = typeof raw === "string" && validToolCallId(raw) ? raw : null;
      const plan = { ...mintLineage(), toolCallId };
      // The envelope carries only what the receiver must inherit; the
      // parent stays in the edge record and never transits the child.
      return {
        fields: { [THREAD_ID_FIELD]: plan.threadId, [ROOT_ID_FIELD]: plan.rootId },
        state: plan,
      };
    },
    async beforePublish(ctx, extras) {
      const plan = extras?.state as EdgePlan | undefined;
      if (edgeSubject === null || plan === undefined) return;
      await publishEdge(ctx, edgeSubject, plan);
    },
  };
}

// The thread ID names this prompt's execution. Inside a prompt handler the
// ambient trace supplies the tree root and this prompt's parent; with none
// bound, the prompt starts its own tree.
function mintLineage(): Omit<EdgePlan, "toolCallId"> {
  const threadId = randomThreadId();
  const ambient = activeTrace();
  if (ambient === undefined) {
    return { threadId, parentId: null, rootId: threadId, turnCountHint: 0 };
  }
  return {
    threadId,
    parentId: ambient.threadId,
    rootId: ambient.rootId,
    turnCountHint: ambient.turnCountHint,
  };
}

/**
 * Build and publish one signed edge record.
 *
 * The signature covers the short-form subject the record is published to:
 * per the identity design a remap that only drops the account token is not
 * a rename, so no `sub` override is needed. Consumers verify in stored
 * mode. The record's `agent` is the client's own identity — the one that
 * signs it — so body and header agree. Its `record_id` is the header's
 * nonce and, through the SDK's signed publish, the `Nats-Msg-Id` as well:
 * one id, so a reader de-duplicating on `(user, record_id)` and a stream
 * de-duplicating on the message id see the same record once.
 *
 * Fail-open — a failed publish never fails the prompt. It is counted:
 * every record that goes out or fails to moves the process-wide
 * {@link traceRecordCounts}, which the host reports on its heartbeat.
 */
async function publishEdge(
  ctx: PromptInterceptorContext,
  subject: string,
  plan: EdgePlan,
): Promise<void> {
  // Consumers ignore unsigned records, so publishing without a signer
  // would be pure waste: warn once per connection and skip. Minting and
  // envelope lineage need no identity and still happen, so downstream
  // agents that do have one keep tracing. The record was due — the prompt
  // is about to go out — and cannot go out: a drop, counted here rather
  // than when the prompt was planned, so a prompt that is never sent owes
  // nothing and counts nothing.
  if (!ctx.identity.canSign) {
    warnEdgesUnsigned(ctx.connection);
    countTraceRecordDropped();
    return;
  }
  try {
    const agent = await ctx.identity.selfId();
    const record = buildEdgeRecord(
      agent,
      plan.threadId,
      plan.parentId,
      plan.rootId,
      plan.toolCallId,
      plan.turnCountHint,
    );
    await ctx.identity.publishSigned(subject, record.payload, { nonce: record.recordId });
    countTraceRecordPublished();
  } catch (err) {
    countTraceRecordDropped();
    console.warn(`@synadia-ai/agent-fabric: failed to publish edge record on ${subject}`, err);
  }
}

// Connections already warned that their edge records go nowhere. One
// warning per connection: a per-prompt log would itself be a way for
// observability to disturb an agent.
const warnedUnsigned = new WeakSet<PromptInterceptorContext["connection"]>();

function warnEdgesUnsigned(nc: PromptInterceptorContext["connection"]): void {
  if (warnedUnsigned.has(nc)) return;
  warnedUnsigned.add(nc);
  console.warn(
    "@synadia-ai/agent-fabric: tracing is enabled but no identity signer is configured; " +
      "edge records are not published (consumers ignore unsigned records). " +
      "Pass identity: { signer } to sign them.",
  );
}

/**
 * The host side: this execution's `(thread, root)`, adopted from the
 * envelope or minted, bound around the rest of the request. The host
 * writes no trace record.
 */
const requestInterceptor: RequestInterceptor = {
  async aroundRequest(ctx, next) {
    await bindActiveTrace(scopeFor(ctx.envelope.extras ?? {}), next);
  },
};

// The half pair's description; the pre-split SDK's decoder said the same.
const HALF_LINEAGE_PAIR = "envelope `thread_id` and `root_id` must be given together";

/**
 * The execution's scope from the envelope's lineage pair: adopted
 * verbatim when both fields are there, a fresh root when neither is.
 *
 * A half pair is never completed. The pair travels together: a caller
 * that traces sends both, one that does not sends neither, unless it
 * relays an envelope it received, which keeps the pair it came with
 * (§5.6). Exactly one
 * names a broken or hand-written caller, and adopting the lone field would
 * file this execution under a tree the caller never named, or root a
 * thread the caller meant as a child — so it is a malformed envelope, the
 * same `400` as a wrongly shaped id, before the handler runs. The Python
 * package reads the wire the same way.
 */
function scopeFor(extras: Readonly<Record<string, unknown>>): TraceScope {
  const threadId = lineageField(extras, THREAD_ID_FIELD);
  const rootId = lineageField(extras, ROOT_ID_FIELD);
  if ((threadId === undefined) !== (rootId === undefined)) {
    throw new RequestRejectedError(400, HALF_LINEAGE_PAIR);
  }
  if (threadId !== undefined && rootId !== undefined) {
    return { threadId, rootId, turnCountHint: 0 };
  }
  return rootTraceScope();
}

/**
 * One lineage field, absent when the key is missing or `null`.
 *
 * A present-but-not-a-string value is a malformed envelope (400), the same
 * as any other wrongly-typed field — and the same as the Python package,
 * which rejects it too. Silently dropping it would make the receiver mint
 * a fresh root and file the execution under a tree of its own. An empty
 * string is absent, again matching Python.
 */
function lineageField(
  extras: Readonly<Record<string, unknown>>,
  wireName: string,
): string | undefined {
  const value = Object.hasOwn(extras, wireName) ? extras[wireName] : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new RequestRejectedError(400, `envelope \`${wireName}\` must be a string`);
  }
  // An empty id names nothing. Treating it as absent keeps a receiver
  // from adopting "" as a thread and filing every child under it — and
  // keeps both packages reading the same wire the same way.
  if (value === "") return undefined;
  // Untrusted, bounded input: the id is adopted verbatim and later stamped
  // on the agent's model requests as a header value, so anything not
  // shaped like a minted id (a CRLF, a megabyte of garbage) is malformed.
  if (!isThreadId(value)) {
    throw new RequestRejectedError(
      400,
      `envelope \`${wireName}\` must be ${THREAD_ID_HEX_LEN} lowercase hex characters`,
    );
  }
  return value;
}
