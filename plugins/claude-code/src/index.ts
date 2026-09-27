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
// With a ScratchPad volume configured, it also gives Claude Code's model
// ScratchPad through the package's skill, loaded with the package as a
// Claude Code plugin of its own (`docs/plugins.md` §9.13).
//
// The named exports are the same factory and the extension's constants.
// The contract's types, the one setting and the loop guard are the fabric
// package's (`@synadia-ai/agent-fabric`), shared by every add-on.

export {
  createFabricExtension,
  fabricExtension,
  fabricExtension as default,
  DEFAULT_STOP_WAIT_MS,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
  isClaudeSessionId,
  NO_SESSION_LINE,
  SERVED_HARNESS,
} from "./extension.js";

// ScratchPad for Claude Code's model: the option, the variables the skill's
// `scripts/sp` reads and the file they go to, the tool extension and this
// package's sp (`docs/plugins.md` §9).
export {
  SCRATCHPAD_OPTION,
  SP_ENV_FILE_VAR,
  SP_VARS,
  ScratchPadHandOn,
  SpEnvFile,
  spBinary,
  spEnvFilePath,
} from "./scratchpad.js";
