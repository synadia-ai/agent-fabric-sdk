// @synadia-ai/agent-fabric-openclaw — the Synadia Agent Fabric add-on for
// the OpenClaw channel plugin (`@synadia-ai/nats-channel`, `agents/openclaw`
// in `synadia-agents`).
//
// One default export: the factory the plugin calls when
// `SYNADIA_OPENCLAW_EXTENSIONS` (or `SYNADIA_AGENT_EXTENSIONS`, or the
// `extensions` field of the account's block under `channels.nats.accounts`)
// names this package. It returns the extension that wires the fabric
// package's tracing into the plugin's service and client, seeds each
// served prompt's OpenClaw turn with a trace id of its own and binds it to
// the served thread with the signed `served` pair, and refuses a prompt of
// a tree OpenClaw's model is waiting in with `409`.
//
// The named exports are the same factory, the extension's constants, and
// the trace scope seed on its own. The contract's types, the one setting
// and the loop guard are the fabric package's (`@synadia-ai/agent-fabric`),
// shared by every add-on.

export {
  createFabricExtension,
  createFabricExtension as default,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
  SERVED_HARNESS,
} from "./extension.js";

export {
  newTraceId,
  OPENCLAW_TRACE_SCOPE_KEY,
  openClawTraceScope,
  runWithTraceId,
  validTraceId,
  type OpenClawTraceContext,
} from "./trace-scope.js";
