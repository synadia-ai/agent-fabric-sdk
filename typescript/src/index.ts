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
//   - {@link durableRunId}, {@link durableTrace}, {@link durableHeaders},
//     {@link withDurableTrace} — a durable run joined to the task that
//                             started it: its run id, the trace for its
//                             input, the proxy's headers and the trace scope
//                             inside a step.
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
//   - {@link spCliScratchPad}, {@link scratchPadFromEnv} — the ready
//                             implementation of that port and the agent's
//                             commit and read ({@link ScratchPadClient}),
//                             over the sp v2 command line, built from
//                             options or from the four `SCRATCHPAD_*`
//                             variables; {@link ScratchPadError}, what it
//                             throws when `sp` refuses or fails.
//   - {@link requestGrant}, {@link grantRequestEndpoint} — the grant request,
//                             both sides: asking a reference's creator to let
//                             one more agent read it, and answering.
//   - {@link findReferences}, {@link removeReferences} and the rest of the
//                             references' vocabulary.
//   - {@link loopGuard}, {@link resolveEdgeSubject} and the harness plugins'
//                             extension contract ({@link AgentExtension} and
//                             its types) — what every add-on under
//                             `plugins/` shares: the `409` guard's two
//                             interceptors, the one setting, the shapes the
//                             plugins hand over and take back.
//
// Mirrors the Python package `synadia_ai.agent_fabric`; the two are
// wire-identical. The pieces for the harness add-ons are TypeScript only,
// like the plugins, and none of them is wire.

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
  durableHeaders,
  durableRunId,
  durableTrace,
  withDurableTrace,
  type DurableTrace,
} from "./durable.js";

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
  SHORT_REFERENCE_PREFIX,
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

export {
  DEFAULT_GRANT_TTL_S,
  DEFAULT_SP_BIN,
  SCRATCHPAD_BIN_VAR,
  SCRATCHPAD_DIR_VAR,
  SCRATCHPAD_GRANT_TTL_S_VAR,
  SCRATCHPAD_VOLUME_VAR,
  ScratchPadError,
  scratchPadFromEnv,
  spCliScratchPad,
  type ScratchPadClient,
  type ScratchPadFromEnvOptions,
  type SpCliScratchPadOptions,
} from "./scratchpad-cli.js";

export { loopGuard, loopGuardDescription, LOOP_GUARD_CODE, type LoopGuard } from "./loop-guard.js";

export {
  nativeScratchPad,
  nativeScratchPadFromEnv,
  NativeScratchPad,
  scratchPadReader,
  ScratchPadReader,
  NativeScratchPadError,
  DEFAULT_READ_LIMIT_BYTES,
  type NativeScratchPadOptions,
  type PublishOptions,
  type PublishResult,
  type RecoveryResult,
  type ScratchPadReaderOptions,
  type ReadBytesOptions,
  encodeReference,
  decodeReference,
  decodeShortReference,
  type Reference,
  type ShortReference,
} from "./scratchpad-native.js";

export { EDGE_SUBJECT_OPTION, EDGE_SUBJECT_VAR, resolveEdgeSubject } from "./plugin-settings.js";

export {
  exportScratchPad,
  readRecordedGrants,
  resolveScratchPad,
  SCRATCHPAD_OPTION,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  spBinary,
  spPort,
  withRecordedGrants,
  type RecordedGrant,
  type ScratchPadSettings,
} from "./plugin-scratchpad.js";

export type {
  AgentExtension,
  AgentExtensionContext,
  AgentExtensionFactory,
  AgentExtensionHandles,
  AgentExtensionSettings,
  HarnessEvents,
  Outcome,
  PluginHarness,
  ServedRequest,
} from "./plugin-contract.js";
