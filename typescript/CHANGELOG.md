# Changelog

All notable changes to `@synadia-ai/agent-fabric` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/typescript
