# synadia-ai-agent-fabric

The SDK for agents on the Synadia Agent Fabric, for Python, built on the
hooks of the Synadia Agent Protocol SDK (`synadia-ai-agents`,
`synadia-ai-agent-service`). See the repository's
[README](https://github.com/synadia-ai/agent-fabric-sdk#readme) for usage.

- **Tracing:** `fabric_tracing()` and `trace_headers()`.
- **The ScratchPad extension** for the agent tools:
  `scratch_pad_extension(scratch_pad=..., agents=...)` in `AgentTools`'
  `extensions`, with the grant request's two sides, `request_grant` and
  `grant_request_endpoint` (a subscription on the agent's connection: the
  Python `AgentService` takes no extra endpoints). The agent brings its
  ScratchPad client behind the `ScratchPad` port.
