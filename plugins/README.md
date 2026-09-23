# plugins/

The fabric add-on for each of the three fully traced harnesses lives
here, one small TypeScript package per harness: `pi/`, `openclaw/`,
`claude-code/`, published as `@synadia-ai/agent-fabric-pi`,
`@synadia-ai/agent-fabric-openclaw` and `@synadia-ai/agent-fabric-claude-code`,
each built on `@synadia-ai/agent-fabric`. The add-ons are built in that
order; PI's and OpenClaw's are here, Claude Code's is not yet. What every
add-on shares — the plugins' extension contract as types, the `409` loop
guard, the edge subject setting — is in the fabric package
(`typescript/src/plugin-contract.ts`, `loop-guard.ts`, `plugin-settings.ts`),
TypeScript only.

| Add-on | What it does | How to name it | The one setting |
| --- | --- | --- | --- |
| [`pi/`](pi/) — `@synadia-ai/agent-fabric-pi` | the fabric package's tracing on the plugin's service and on the client its agent tools prompt through (the pair adopted or minted per served prompt, the signed `edge` before every prompt PI's model sends, the counts on the heartbeat); the fabric's two headers on PI's own model calls, so the proxy files them on the served thread; the `409` loop guard, refusing a prompt of a tree PI's model is waiting in; one warning at start when the plugin's identity is off | `SYNADIA_PI_EXTENSIONS=<absolute path of the package, or its name>` for PI's plugin (`SYNADIA_AGENT_EXTENSIONS` below it, the `extensions` array of `nats-channel.json` below that); the plugin's connect line and `/nats-status` list `agent-fabric` when it is loaded | the edge subject: the entry's `options.edgeSubject` (`null` for propagate-only), else `SYNADIA_FABRIC_EDGE_SUBJECT`, else `TRACE.edges`; an unpublishable subject stops the factory and the plugin starts plain, saying so |
| [`openclaw/`](openclaw/) — `@synadia-ai/agent-fabric-openclaw` | the same tracing on the plugin's service and client; per served prompt a fresh trace id seeded into OpenClaw's trace scope around the dispatch, so every model call of the turn carries it in its `traceparent`, and the signed `served` pair on the edge subject binding it to the served thread (`start` at arrival, `end` with the outcome); the served scope bound around every agent-tool call; the same `409` loop guard; one warning at start when the plugin's identity is off | `SYNADIA_OPENCLAW_EXTENSIONS=<absolute path of the package, or its name>` (`SYNADIA_AGENT_EXTENSIONS` below it, the `extensions` array of the account's block under `channels.nats.accounts` below that); the `gateway starting` and `registered at` lines name `agent-fabric` when it is loaded | the same, the pair on the edge subject too |
| `claude-code/` | not yet (B4) | | |

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
