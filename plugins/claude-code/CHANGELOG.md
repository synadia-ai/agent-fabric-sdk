# Changelog

All notable changes to `@synadia-ai/agent-fabric-claude-code` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
