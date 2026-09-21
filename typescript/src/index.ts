// @synadia-ai/agent-fabric — the SDK for agents on the Synadia Agent Fabric.
//
// Built on the hooks of the protocol SDK (`@synadia-ai/agents`,
// `@synadia-ai/agent-service`); it never reaches into their internals.
// Today it carries tracing:
//
//   - {@link fabricTracing} — the prompt interceptor, the request
//                             interceptor and the heartbeat extras provider
//                             the SDK takes, which together publish the
//                             signed edge record before each prompt, carry
//                             `thread_id` / `root_id` in the envelope, adopt
//                             or mint them on the host, and report the
//                             record counts on the heartbeat.
//   - {@link traceHeaders}  — `X-Synadia-Thread-ID` / `X-Synadia-Root-ID`
//                             for the model calls a handler makes.
//   - {@link activeTrace}, {@link bindActiveTrace} — the ambient scope.
//   - {@link buildEdgeRecord}, {@link traceRecordCounts} and the rest of the
//                             vocabulary.
//
// Mirrors the Python package `synadia_ai.agent_fabric`; the two are
// wire-identical.

export { fabricTracing, TOOL_CALL_ID_CONTEXT_KEY, type FabricTracing } from "./tracing.js";

export {
  DEFAULT_EDGE_SUBJECT,
  EDGE_RECORD_VERSION,
  ROOT_ID_FIELD,
  ROOT_ID_HEADER,
  THREAD_ID_FIELD,
  THREAD_ID_HEADER,
  THREAD_ID_HEX_LEN,
  TOOL_CALL_ID_MAX,
  activeTrace,
  assertValidTraceOptions,
  bindActiveTrace,
  buildEdgeRecord,
  countTraceRecordDropped,
  countTraceRecordPublished,
  isThreadId,
  randomThreadId,
  traceHeaders,
  traceRecordCounts,
  validToolCallId,
  type BuiltEdgeRecord,
  type TraceOptions,
  type TraceRecordCounts,
  type TraceScope,
} from "./trace.js";
