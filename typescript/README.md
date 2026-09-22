# @synadia-ai/agent-fabric

The SDK for agents on the Synadia Agent Fabric, for TypeScript, built on the
hooks of the Synadia Agent Protocol SDK (`@synadia-ai/agents`,
`@synadia-ai/agent-service`). See the repository's
[README](https://github.com/synadia-ai/agent-fabric-sdk#readme) for usage.

- **Tracing:** `fabricTracing()` and `traceHeaders()`.
- **The ScratchPad extension** for the agent tools:
  `scratchPadExtension({ scratchPad, agents })` in `AgentTools`'
  `extensions`, with the grant request's two sides, `requestGrant` and
  `grantRequestEndpoint` (an `AgentService` extra endpoint). The agent
  brings its ScratchPad client behind the `ScratchPad` port.
