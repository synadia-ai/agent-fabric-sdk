// @synadia-ai/agent-fabric-pi — the Synadia Agent Fabric add-on for the PI
// channel plugin (`@synadia-ai/nats-pi-channel` in `synadia-agents`).
//
// One default export: the factory the plugin calls when
// `SYNADIA_PI_EXTENSIONS` (or `SYNADIA_AGENT_EXTENSIONS`, or the
// `extensions` field of `nats-channel.json`) names this package. It returns
// the extension that wires the fabric package's tracing into the plugin's
// service and client, stamps the fabric's headers on PI's own model calls,
// and refuses a prompt of a tree PI's model is waiting in with `409`.
//
// The named exports are the same factory, the extension's constants, the
// loop guard on its own, and the contract's types, declared here
// structurally so nothing of the plugin or of PI is imported.

export {
  createFabricExtension,
  createFabricExtension as default,
  resolveEdgeSubject,
  EDGE_SUBJECT_OPTION,
  EDGE_SUBJECT_VAR,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
} from "./extension.js";

export { loopGuard, loopGuardDescription, LOOP_GUARD_CODE, type LoopGuard } from "./loop-guard.js";

export type {
  AgentExtension,
  AgentExtensionContext,
  AgentExtensionFactory,
  AgentExtensionHandles,
  AgentExtensionSettings,
  Harness,
  HarnessEvents,
  Outcome,
  ServedRequest,
} from "./contract.js";
