# plugins/

The fabric add-on for each of the three fully traced harnesses will live
here, one small TypeScript package per harness: `pi/`, `openclaw/`,
`claude-code/`, published as `@synadia-ai/agent-fabric-pi`,
`@synadia-ai/agent-fabric-openclaw` and `@synadia-ai/agent-fabric-claude-code`,
each built on `@synadia-ai/agent-fabric`. Nothing is here yet; the
add-ons are built in that order, PI first.

The shape is one plugin per harness plus an add-on, never a copy. The plugin
stays in the public protocol repo, `synadia-agents` (`agents/pi`,
`agents/openclaw`, `agents/claude-code`), speaks plain protocol, offers the
SDK's `AgentTools`, and exposes one neutral extension point: a module named
by `SYNADIA_AGENT_EXTENSIONS` or the plugin's `extensions` setting, handed
the SDK's interceptors, the tools' extension hooks and the harness's
events. The add-on is that module. It wires `fabricTracing()` into the
plugin's client and service and adds the harness piece: the trace headers
on PI's model calls, the `served` pair with a `traceparent` seed for
OpenClaw, the `served` pair on the session for Claude Code. Without the
variable the plugin is the plain plugin.

The spec, and the guide for a plugin author: [`../docs/plugins.md`](../docs/plugins.md).
