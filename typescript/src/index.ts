// @synadia-ai/agent-fabric — the SDK for agents on the Synadia Agent Fabric.
//
// Built on the hooks of the protocol SDK (`@synadia-ai/agents`,
// `@synadia-ai/agent-service`); it never reaches into their internals.
// It carries tracing and the agent tools' ScratchPad extension:
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
//   - {@link servedPublisher}, {@link buildServedRecord} — the `served`
//                             record, a harness plugin's binding of a served
//                             thread to the harness's own thread id, and its
//                             publisher over the plugin's client.
//   - {@link scratchPadExtension} — the fabric's rules for ScratchPad
//                             references on `AgentTools`' three extension
//                             hooks, over the agent's own client behind the
//                             {@link ScratchPad} port.
//   - {@link requestGrant}, {@link grantRequestEndpoint} — the grant request,
//                             both sides: asking a reference's creator to let
//                             one more agent read it, and answering.
//   - {@link findReferences}, {@link removeReferences} and the rest of the
//                             references' vocabulary.
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

export {
  HARNESS_THREAD_ID_MAX,
  SERVED_RECORD_VERSION,
  ServedPublisher,
  buildServedRecord,
  servedPublisher,
  unixSeconds,
  validHarnessThreadId,
  type BuiltServedRecord,
  type Harness,
  type ServedPhase,
  type ServedPublisherOptions,
  type ServedStatus,
  type ServedTurn,
} from "./served.js";

export {
  READS_REFERENCES_KEY,
  REFERENCE_PREFIX,
  findReferences,
  granteeFromIdentity,
  readsReferences,
  referenceCreator,
  removeReferences,
  type GrantKind,
  type Grantee,
  type ScratchPad,
  type TraceIds,
} from "./scratchpad.js";

export {
  DEFAULT_GRANT_REQUEST_TIMEOUT_MS,
  GRANT_REQUEST_ENDPOINT,
  answerGrantRequest,
  encodeGrantReply,
  encodeGrantRequest,
  grantRequestEndpoint,
  grantSubject,
  requestGrant,
  type GrantReply,
  type GrantRequest,
  type GrantRequestEndpointOptions,
  type RequestGrantOptions,
} from "./grant-request.js";

export {
  READS_SCRATCHPAD_REFERENCES_FIELD,
  ScratchPadExtension,
  scratchPadExtension,
  type ScratchPadExtensionOptions,
} from "./scratchpad-extension.js";
