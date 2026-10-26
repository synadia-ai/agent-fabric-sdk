# Changelog

All notable changes to `@synadia-ai/agent-fabric-claude-code` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-26

### Added

- **A turn typed at the terminal is a thread of its own.** The Claude Code channel plugin
  reports a turn no NATS prompt started as a local turn; the add-on mints a root for it, opens
  the `409` guard on it, publishes the root's `served` pair on the turn's session from its start
  to its end, and runs the turn's agent-tool calls in the root, so the agents it prompts hang
  beneath it. ScratchPad's variables are the local turn's while it runs.
- ScratchPad's bootstrap: `options.scratchpad.bootstrapFile` or `SCRATCHPAD_BOOTSTRAP_FILE` names a public creation descriptor that `scripts/sp init` imports; it can give the volume, must match a configured one, and needs a persistent workspace.
- ScratchPad's skill covers reusable lifetimes: `renew`, `remove` and `retire`, maintenance on a reusable deployment, and `--end-promises` as a flag without a value in `scripts/sp`.

### Changed

- **A prompt's pair starts when Claude Code takes it into a turn** (`promptStarted`, with the
  time Claude Code took it and the session the turn runs in), no longer at the accept: a prompt
  queued behind a running turn no longer cuts that turn's window, nor takes ScratchPad's
  variables. A prompt that ends while it waits gets its pair stamped with the end of the turn
  running then, after that turn's `end`; with no turn running, at its own end. `stopping` ends
  the local turn first, then those pairs, then the served prompts.

- ScratchPad's `sp` connects as the Claude Code channel does. A non-empty `NATS_CONTEXT` wins
  over `NATS_URL` and `NATS_CREDS` for `sp` too; with `NATS_CONTEXT` set but empty, or
  `NATS_URL`, `NATS_CREDS` or `NATS_CREDENTIALS` set, `sp` takes the variables and never a
  context; otherwise the `context` in the channel's `config.json`. `NATS_CREDENTIALS` is read
  as `NATS_CREDS`'s alias, `NATS_CREDS` winning.
- The bundled Claude Code channel plugin from `synadia-agents` reads the `context` in
  `config.json` only when the environment names no server, and names where the connection
  came from on stderr.
- The bundled channel follows Claude Code's turns by their prompt ids: a prompt belongs to the turn Claude Code took it into, its own or, folded, the running one; channel messages taken together are one turn; a turn that fails on a model API error ends its prompt at once with an error that names it.

## [0.2.0] — 2026-10-11

### Changed

- `@synadia-ai/agent-fabric-claude-code` is the whole plugin now: the Claude Code channel plugin from
  `synadia-agents`, this add-on and ScratchPad's skill, bundled by `bundles/build.sh` into one plugin
  folder that Claude Code installs from a marketplace with an npm source (this repo's
  `.claude-plugin/marketplace.json`). Its `.mcp.json` names the add-on; its main export is the add-on,
  as before. This folder is the add-on's source and is not published alone.

## [0.1.0] — 2026-10-06

### Added

- The extension module for the Claude Code channel plugin, named in `SYNADIA_CLAUDE_CODE_EXTENSIONS`: `fabricTracing()` on the plugin's service and agent-tools client.
- The signed `served` pair binding each served prompt to the Claude Code session, its `end` at the turn's `Stop`.
- The `409` loop guard in front of the channel's handler.
- The settings: the edge subject (`options.edgeSubject`, `SYNADIA_FABRIC_EDGE_SUBJECT`, or `TRACE.edges`) and `options.stopWaitMs`.
- The Claude Code plugin `agent-fabric`: the ScratchPad skill with the sp command line for darwin and linux, and the `SessionStart` hook that names the file `scripts/sp` reads.
- ScratchPad: references in and out, and grant requests.

[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/plugins/claude-code
