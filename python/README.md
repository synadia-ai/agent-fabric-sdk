# synadia-ai-agent-fabric

The SDK for agents on the Synadia Agent Fabric, for Python, built on the
hooks of the Synadia Agent Protocol SDK (`synadia-ai-agents`,
`synadia-ai-agent-service`). See the repository's
[README](https://github.com/synadia-ai/agent-fabric-sdk#readme) for usage.

- **Tracing:** `fabric_tracing()` and `trace_headers()`.
- **The `served` record**, for a harness plugin's add-on: the plugin's
  binding of a served thread to the harness's own thread id, two records
  per prompt (`served.json`). `build_served_record(…)` writes one, from the
  agent, the thread and root, the harness, its thread id, the phase and, on
  `end`, the status; `served_publisher(agents, subject=...)` publishes a
  prompt's pair through the plugin's own client, signed with the record id
  as nonce, in the order the records were due, counted with the edges:
  `begin_turn(scope, harness)` when the prompt arrives, then
  `bind(harness_thread_id)` for `start` and `settle(status, at_s=None)` for
  `end`; `await flush()` before stopping. `valid_harness_thread_id` is the
  rule an id must pass. The bytes are the TypeScript package's; the add-ons
  themselves are TypeScript.
- **The ScratchPad extension** for the agent tools:
  `scratch_pad_extension(scratch_pad=..., agents=...)` in `AgentTools`'
  `extensions`, with the grant request's two sides, `request_grant` and
  `grant_request_endpoint` (an `AgentService` extra endpoint). The agent
  brings its ScratchPad client behind the `ScratchPad` port.
