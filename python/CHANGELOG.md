# Changelog

All notable changes to `synadia-ai-agent-fabric` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — Unreleased

### Added

- A caller: `fabric_caller()` and `fabric_caller_from_env()` prompt your agents with the creds file the console gave you and nothing else. Every prompt is signed and starts a task of its own; `prompt()` returns the SDK's stream with the task's root id, `ask()` the whole reply with it. `list()`, `find()`, `close()`, `pick_agent()` and `FabricCallerError`.
- The `agent-fabric` command: `agent-fabric agents` and `agent-fabric prompt <address or kind> "<text>"`, with `--creds`, `--url`, `--timeout` and `--json`. Run it with `uvx --from synadia-ai-agent-fabric agent-fabric`.
- Five examples in the source distribution's `examples/`: one prompt, a reply in a script, questions answered, the agents listed, topics prompted on an interval.

## [0.1.0]

### Added

- Tracing: `fabric_tracing()`, the protocol SDK's three hooks, and `trace_headers()` for model calls.
- Durable runs joined to the task that started them: `durable_run_id`, `durable_trace`, `durable_headers` and `with_durable_trace`.
- The `served` record for a harness plugin's add-on: `build_served_record`, `served_publisher` and `valid_harness_thread_id`.
- The ScratchPad extension for the agent tools, `scratch_pad_extension`, with the grant request's two sides, `request_grant` and `grant_request_endpoint`.
- The native ScratchPad client: `native_scratchpad`, `native_scratchpad_from_env` and `scratchpad_reader`.
- The ScratchPad CLI adapter over `sp`: `SpCliScratchPad` and `scratchpad_from_env`.
- Short artifact references: `sp-r1:` tokens accepted alongside `sp-ref:`.

[0.2.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/python
[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/python
