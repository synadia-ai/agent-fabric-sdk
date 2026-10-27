# Changelog

All notable changes to `@synadia-ai/agent-fabric-openclaw` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The add-on's own sp, for the references its model hands on and the grant requests it
  answers, is the first executable file of `SCRATCHPAD_BIN` and the binary the package ships;
  before, the shipped path was taken without a look. OpenClaw 2026.10 loads a plugin's code from
  a copy of its own. Where the add-on is a package of its own, loaded by path
  (`SYNADIA_OPENCLAW_EXTENSIONS`), the copy holds the add-on's `dist/` and `package.json` and no
  `skill/`, so the add-on ran an sp that was not there. In that layout, set `SCRATCHPAD_BIN` to
  the package's `skill/scratchpad/bin/sp-<os>-<arch>`. Installed as the one npm package, the
  copy holds the skill, and nothing changes.
- Without an sp, the add-on says so once at start, with what it tried and that
  `SCRATCHPAD_BIN` fixes it, and grants nothing: a reference OpenClaw's model puts into
  `prompt_agent` is removed with a note, as for a receiver that reads none, a prompt of nothing
  but references is refused, and grant requests are not answered. With `SCRATCHPAD_BIN` unset,
  the model's `scripts/sp` finds its own binary, as before.

## [0.3.1] — 2026-10-27

### Changed

- The `end` of a prompt whose run ended on a reply OpenClaw marked as an error, a failed
  run's among them, carries the reason `no_reply` (served record version 2). The channel now
  ends such a prompt with an error and passes `promptEnded` that reason; the add-on hands it
  to `settle`, as the Claude Code add-on does. A dispatch that threw, or a dispatch error
  OpenClaw reported, still carries none.

## [0.3.0] — 2026-10-26

### Added

- ScratchPad's bootstrap: `options.scratchpad.bootstrapFile` or `SCRATCHPAD_BOOTSTRAP_FILE` names a public creation descriptor that `scripts/sp init` imports; it can give the volume, must match a configured one, and needs a persistent workspace.
- ScratchPad's skill covers reusable lifetimes: `renew`, `remove` and `retire`, maintenance on a reusable deployment, and `--end-promises` as a flag without a value in `scripts/sp`.

### Changed

- ScratchPad's `sp` connects as OpenClaw's channel does. A non-empty `NATS_CONTEXT` wins over
  `NATS_URL` and `NATS_CREDS` for `sp` too; with `NATS_CONTEXT` set but empty, or `NATS_URL`,
  `NATS_CREDENTIALS` or `NATS_CREDS` set, `sp` takes the variables and never a context;
  otherwise the account's `context`; then the account's `url` and `credentials`, as before.
  `NATS_CREDENTIALS` is read and wins over `NATS_CREDS`, as the channel reads them. Stated
  honestly: with `NATS_CONTEXT=""`, no variables and an account that names only a context, the
  gateway connects by that context and ScratchPad is off with its warning (the README says
  why).

## [0.2.1] — 2026-10-12

### Fixed

- The bundled OpenClaw channel plugin is 0.5.7 (`synadia-agents` #234). With the agent's name in
  `SYNADIA_OPENCLAW_NAME`, the gateway start no longer prints "could not persist channel config
  skeleton …". The install, where no name is known yet, prints one line saying where the name
  comes from.

## [0.2.0] — 2026-10-11

### Changed

- `@synadia-ai/agent-fabric-openclaw` is the whole plugin now: the OpenClaw channel plugin from
  `synadia-agents`, this add-on and ScratchPad's skill, bundled by `bundles/build.sh` into one
  package that OpenClaw installs its own way. Its entry loads the add-on unless an extension
  variable names other extensions; its main export is the add-on, as before. This folder is the
  add-on's source and is not published alone.

## [0.1.0] — 2026-10-06

### Added

- The extension module for the OpenClaw channel plugin, named in `SYNADIA_OPENCLAW_EXTENSIONS`: `fabricTracing()` on the plugin's service and agent-tools client.
- A fresh trace id per served prompt, seeded into OpenClaw's trace scope so its model calls carry it in their `traceparent`.
- The signed `served` pair binding each served prompt to that trace id.
- The `409` loop guard in front of the gateway's handler.
- The edge subject setting: `options.edgeSubject`, `SYNADIA_FABRIC_EDGE_SUBJECT`, or `TRACE.edges`.
- ScratchPad: the shared skill with the sp command line for darwin and linux, its variables for `scripts/sp`, references in and out, and grant requests.

[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/plugins/openclaw
