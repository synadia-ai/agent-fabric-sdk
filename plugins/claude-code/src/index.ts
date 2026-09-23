// @synadia-ai/agent-fabric-claude-code — the Synadia Agent Fabric add-on
// for the Claude Code channel plugin (`nats-channel`, `agents/claude-code`
// in `synadia-agents`).
//
// One default export: the factory the plugin's MCP server calls when
// `SYNADIA_CLAUDE_CODE_EXTENSIONS` (or `SYNADIA_AGENT_EXTENSIONS`, or the
// `extensions` field of the channel's `config.json`) names this package.
// It returns the extension that wires the fabric package's tracing into the
// plugin's service and client, binds each served prompt to the Claude Code
// session it was delivered to with the signed `served` pair — `end` at the
// turn's `Stop`, so the closing model call falls inside the window — and
// refuses a prompt of a tree Claude Code's model is waiting in with `409`.
//
// The named exports are the same factory and the extension's constants.
// The contract's types, the one setting and the loop guard are the fabric
// package's (`@synadia-ai/agent-fabric`), shared by every add-on.

export {
  createFabricExtension,
  createFabricExtension as default,
  DEFAULT_STOP_WAIT_MS,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
  isClaudeSessionId,
  NO_SESSION_LINE,
  SERVED_HARNESS,
} from "./extension.js";
