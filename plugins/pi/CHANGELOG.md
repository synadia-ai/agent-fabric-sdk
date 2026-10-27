# Changelog

All notable changes to `@synadia-ai/agent-fabric-pi` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-10-27

### Fixed

- The add-on's own sp, for the references its model hands on and the grant requests it
  answers, is the first executable file of `SCRATCHPAD_BIN` and the binary the package ships.
  Without one, the add-on says so once at start, with what it tried and that `SCRATCHPAD_BIN`
  fixes it, and grants nothing: a reference in `prompt_agent` is removed with a note, as for a
  receiver that reads none, a prompt of nothing but references is refused, and grant requests
  are not answered. Before, a missing binary showed only when a call to it failed,
  and on a platform the package ships no binary for, a prompt with references was refused.
- A `SCRATCHPAD_BIN` that is set but missing or not executable is warned about once at start,
  with its path and why: the add-on passes it over, but the skill's `scripts/sp` takes it as
  it is and refuses every call until it names an executable sp or is unset.

## [0.3.1] — 2026-10-27

### Changed

- Built with this release's channel plugins from `synadia-agents`; no change of its own.

## [0.3.0] — 2026-10-26

### Added

- A turn typed at PI's terminal is traced as a task of its own, with the agents it prompts
  beneath it. The PI channel plugin reports a run no NATS prompt started as a local turn
  (`localTurnStarted`, `localTurnEnded`); the add-on mints a root for it, puts the root's two
  headers on the turn's model calls, runs its agent-tool calls inside it so their edges name it,
  guards it with the `409` loop guard, and sets ScratchPad's trace variables for it, with no
  caller. No edge is written for the root itself.
- ScratchPad's bootstrap: `options.scratchpad.bootstrapFile` or `SCRATCHPAD_BOOTSTRAP_FILE` names a public creation descriptor that `scripts/sp init` imports; it can give the volume, must match a configured one, and needs a persistent workspace.
- ScratchPad's skill covers reusable lifetimes: `renew`, `remove` and `retire`, maintenance on a reusable deployment, and `--end-promises` as a flag without a value in `scripts/sp`.

### Changed

- ScratchPad's `sp` connects as PI's channel does. A non-empty `NATS_CONTEXT` wins over
  `NATS_URL` and `NATS_CREDS` for `sp` too; with `NATS_CONTEXT` set but empty, or `NATS_URL`,
  `NATS_CREDS` or `NATS_CREDENTIALS` set, `sp` takes the variables and never a context;
  otherwise the `context` in `nats-channel.json`. `NATS_CREDENTIALS` is read as
  `NATS_CREDS`'s alias, `NATS_CREDS` winning.
- The bundled PI channel plugin from `synadia-agents` reads the `context` in
  `nats-channel.json` only when the environment names no server, and its start line names
  where the connection came from.

## [0.2.0] — 2026-10-11

### Changed

- `@synadia-ai/agent-fabric-pi` is the whole plugin now: the PI channel plugin from
  `synadia-agents`, this add-on and ScratchPad's skill, bundled by `bundles/build.sh` into one
  package that pi installs its own way. Its entry loads the add-on unless an extension
  variable names other extensions; its main export is the add-on, as before. This folder is the
  add-on's source and is not published alone.

## [0.1.0] — 2026-10-06

### Added

- The extension module for the PI channel plugin, named in `SYNADIA_PI_EXTENSIONS`: `fabricTracing()` on the plugin's service and agent-tools client.
- The `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` headers on PI's own model calls, with each served request's scope bound at PI's events.
- The `409` loop guard in front of PI's handler.
- The edge subject setting: `options.edgeSubject`, `SYNADIA_FABRIC_EDGE_SUBJECT`, or `TRACE.edges`.
- ScratchPad: the shared skill with the sp command line for darwin and linux, its variables for `scripts/sp`, references in and out, and grant requests.

[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/plugins/pi
