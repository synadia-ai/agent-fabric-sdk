# Changelog

All notable changes to `@synadia-ai/agent-fabric` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Local turns, a turn a harness runs that no served prompt started (typed at its terminal), for
  the add-ons that trace them: `rootTraceScope()` mints a root scope (a thread that is its own
  root, no call counted), the one a receiver also mints for an envelope without the pair; the
  loop guard's `open(scope)` guards a local turn's scope like a served request until the function
  it returns is called; `servedPublisher`'s `beginTurn` takes an optional third argument, `atMs`,
  the arrival the `start` record is stamped with, floored to unix seconds as `settle` floors its
  own. The plugin contract gains `LocalTurn`, `localTurnStarted` and `localTurnEnded`;
  `aroundToolCall` and `providerHeaders` take a served request or a local turn.
  `ServedPromptEnv`'s `enter` and `leave` take any `{ id, caller? }` (`PromptEnvHolder`), so a
  local turn, which has no caller, holds the variables too.

### Changed

- `resolveScratchPad`, the add-ons' ScratchPad settings, takes the connection the plugin's
  channel takes, so `sp` connects to the agent's server as the agent. After
  `options.scratchpad`'s `url` and `creds`, field by field: a non-empty `NATS_CONTEXT`'s
  context, over `NATS_URL` and `NATS_CREDS` (before, `sp` took the variables while the channel
  connected by the context: two servers, possibly two identities); with `NATS_CONTEXT` set but
  empty, or `NATS_URL`, `NATS_CREDS` or `NATS_CREDENTIALS` set, the variables and never a
  context (before, an empty `NATS_CONTEXT` fell through to the config's context, and the
  config's context filled a missing URL or credentials file); otherwise the config's context;
  then the plugin's own `url` and `credentials`, as before. `NATS_CREDENTIALS` is read as
  `NATS_CREDS`'s alias, in the order the channel reads them: a third argument,
  `{ credsVariables }` (`ResolveScratchPadOptions`), gives it, `NATS_CREDS` first by default.

## [0.2.0] — Unreleased

### Added

- A caller: `fabricCaller()` and `fabricCallerFromEnv()` prompt your agents with the creds file the console gave you and nothing else. Every prompt is signed and starts a task of its own; `prompt()` returns the SDK's stream with the task's root id, `ask()` the whole reply with it. `list()`, `find()`, `close()`, `pickAgent()` and `FabricCallerError`.
- The `agent-fabric` command: `agent-fabric agents` and `agent-fabric prompt <address or kind> "<text>"`, with `--creds`, `--url`, `--timeout` and `--json`. Run it with `npx @synadia-ai/agent-fabric`.
- Five examples in the package's `examples/`: one prompt, a reply in a script, questions answered, the agents listed, topics prompted on an interval.

### Changed

- `@nats-io/transport-node` is a dependency: the caller opens its own connection.

## [0.1.0] — 2026-10-06

### Added

- Tracing: `fabricTracing()`, the protocol SDK's three hooks, and `traceHeaders()` for model calls.
- Durable runs joined to the task that started them: `durableRunId`, `durableTrace`, `durableHeaders` and `withDurableTrace`.
- The `served` record for a harness plugin's add-on: `buildServedRecord`, `servedPublisher` and `validHarnessThreadId`.
- The ScratchPad extension for the agent tools, `scratchPadExtension`, with the grant request's two sides, `requestGrant` and `grantRequestEndpoint`.
- The native ScratchPad client: `nativeScratchPad`, `nativeScratchPadFromEnv` and `scratchPadReader`.
- The ScratchPad CLI adapter over `sp`: `spCliScratchPad` and `scratchPadFromEnv`.
- Short artifact references: `sp-r1:` tokens accepted alongside `sp-ref:`.
- The harness plugins' shared pieces: the extension contract's types, `loopGuard()`, `resolveEdgeSubject()` and ScratchPad's plugin settings.

[0.2.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/typescript
[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/typescript
