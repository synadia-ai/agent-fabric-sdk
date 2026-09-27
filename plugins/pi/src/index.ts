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
// The named exports are the same factory, the extension's constants, and,
// re-exported from `@synadia-ai/agent-fabric` where every add-on shares
// them, the one setting, the loop guard on its own and the contract's
// types, declared there structurally so nothing of the plugin or of PI is
// imported.

export {
  createFabricExtension,
  fabricExtension,
  fabricExtension as default,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
} from "./extension.js";

// ScratchPad for PI's model: the option and the variables the skill's
// `scripts/sp` reads (`docs/plugins.md` §9).
export { SCRATCHPAD_OPTION, SP_VARS, ScratchPadHandOn, spBinary } from "./scratchpad.js";

// What every add-on shares, from the fabric package, re-exported so this
// package's API is what it was before they moved there.
export {
  EDGE_SUBJECT_OPTION,
  EDGE_SUBJECT_VAR,
  resolveEdgeSubject,
  loopGuard,
  loopGuardDescription,
  LOOP_GUARD_CODE,
  type LoopGuard,
  type AgentExtension,
  type AgentExtensionContext,
  type AgentExtensionFactory,
  type AgentExtensionHandles,
  type AgentExtensionSettings,
  type PluginHarness as Harness,
  type HarnessEvents,
  type Outcome,
  type ServedRequest,
} from "@synadia-ai/agent-fabric";
