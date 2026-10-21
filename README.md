# agent-fabric-sdk

**The SDK, the reference agents and the harness plugins for the Synadia Agent Fabric.**

The Synadia Agent Fabric is the layer between AI agents, on NATS, as part of Synadia Cloud. Every agent gets an identity it signs with, a place where other agents find and prompt it, a model key the fabric issues (the provider's real key stays in the fabric's model proxy), and a record of every prompt, model call, shared file and durable step on one timeline, which the fabric's console shows. The fabric never runs an agent: you bring your own frameworks, models and machines.

> **Building an agent with Claude Code?** Start Claude Code in this checkout
> and ask it for the agent you want, for example _"make me a research agent
> for the fabric, connect it and run it"_. The
> [`fabric-agent` skill](.claude/skills/fabric-agent/SKILL.md) guides it. It
> hands you every step that takes a secret, to run in your own terminal:
> never paste a key into the chat.

## Get started: pick your path

| You want to… | Go to | Install |
| --- | --- | --- |
| **Prompt an agent** from a terminal, a script, an app or CI | [Prompt an agent](#prompt-an-agent) below; a caller's creds file from the console's **Callers** | `npx @synadia-ai/agent-fabric` · `uvx --from synadia-ai-agent-fabric agent-fabric` |
| **Put Claude Code, pi or OpenClaw on the fabric**, no code | the console's **Connect an agent**: the `fabric` CLI, or environment variables for servers and containers | `fabric connect`, or `@synadia-ai/agent-fabric-{claude-code,pi,openclaw}` |
| **Build your own agent** in TypeScript or Python | [`reference-agents/`](reference-agents/README.md): copy one and adapt it; [getting started](reference-agents/docs/getting-started/README.md) in six steps | `npm install` in `reference-agents/typescript` |
| **Add the fabric to an agent you already have** on the protocol SDK | [tracing](docs/tracing.md), [ScratchPad](docs/scratchpad.md), [durable runs](docs/durable.md) | `npm i @synadia-ai/agent-fabric` · `pip install synadia-ai-agent-fabric` |
| **Work on this repository** | [CLAUDE.md](CLAUDE.md): the layout, the suites, the rules | `npm` · `uv` · `nats-server` |

The console of your fabric serves [`/llms.txt`](https://llmstxt.org), the same map for an agent helping you.

## Packages

| | TypeScript | Python |
| --- | --- | --- |
| **The SDK**: the caller, tracing, ScratchPad, durable runs | [`@synadia-ai/agent-fabric`](typescript/README.md) | [`synadia-ai-agent-fabric`](python/README.md) (import `synadia_ai.agent_fabric`) |
| **The harness plugins**, each the whole plugin with the fabric's add-on | `@synadia-ai/agent-fabric-claude-code` · `-pi` · `-openclaw` ([`plugins/`](plugins/), [`docs/plugins.md`](docs/plugins.md)) | |

The SDK is built on the [Synadia Agent Protocol SDK](https://github.com/synadia-ai/synadia-agents) (`@synadia-ai/agents`, `@synadia-ai/agent-service`; `synadia-ai-agents`, `synadia-ai-agent-service`) and installs it with it. It plugs into the protocol SDK's public hooks and nothing else; the protocol SDK knows nothing of the fabric.

## Prompt an agent

A **caller** is a user of your account that may find and prompt agents and nothing else. Add one on the console's **Callers** page and download its creds file, shown once. Each agent's page on the console has **Prompt from code**, with its address and these commands filled in.

```sh
export NATS_CREDS=./laptop.creds NATS_URL=<the URL the console shows>
npx @synadia-ai/agent-fabric agents                                   # the agents online
npx @synadia-ai/agent-fabric prompt agents.prompt.pi.team.editor 'Say hello'
```

Python: `uvx --from synadia-ai-agent-fabric agent-fabric prompt …`, the same arguments. Every prompt is signed with the caller's key and traced as a task of its own, so the console shows it with everything the agent did for it. In code:

```ts
import { fabricCaller } from "@synadia-ai/agent-fabric";

const caller = await fabricCaller({ creds: "laptop.creds", url: process.env.NATS_URL });
const { text, rootId } = await caller.ask("agents.prompt.pi.team.editor", "Say hello");
await caller.close();
```

The options, the errors and the examples each package ships: [TypeScript](typescript/README.md#prompt-your-agents), [Python](python/README.md#prompt-your-agents).

## Build an agent

The [reference agents](reference-agents/README.md), one in TypeScript and one in Python, do the four things a participant of the fabric does, each marked in the code:

1. **Take prompts under a signed identity**, at `agents.prompt.<kind>.<owner>.<name>`.
2. **Call the model through the fabric's model proxy**, with the trace headers that put each call on its task.
3. **Find and prompt other agents** with the agent tools, each prompt a child thread under the tool call that sent it.
4. **Hand work over by ScratchPad reference**, optionally. A fifth, durable work, is optional too.

```sh
git clone https://github.com/synadia-ai/agent-fabric-sdk.git
cd agent-fabric-sdk/reference-agents/typescript && npm install    # Node 22.13 or later
fabric login --console <your console>                              # once, in your own terminal
fabric connect my-agent --harness sdk --kind researcher            # its NATS user and model key
eval "$(fabric env my-agent)" && npm start
```

Without the `fabric` CLI, the console's **Connect an agent** with environment variables creates the agent and hands out its creds file and its env file; the agent reads everything from its environment. The [getting-started pages](reference-agents/docs/getting-started/README.md) grow the same agent in six steps, from an echo to a handoff.

## What the SDK gives

- **A caller**: `fabricCaller()` and the `agent-fabric` command, above.
- **Tracing**: `fabricTracing()`, the three hooks the protocol SDK takes, and `traceHeaders()` for model calls. The signed `edge` record before every prompt, the thread and root in the envelope, the counts on the heartbeat. [`docs/tracing.md`](docs/tracing.md).
- **ScratchPad**: the extension that keeps the fabric's rules for handing content over by reference, on the agent tools, with the grant request; and native clients that implement its port. [`docs/scratchpad.md`](docs/scratchpad.md), [`docs/scratchpad-native.md`](docs/scratchpad-native.md).
- **Durable runs** joined to the task that started them, with no dependency on a durable-execution library. [`docs/durable.md`](docs/durable.md).
- **For the harness plugins' add-ons**: the `served` record and its publisher, the plugins' extension contract, the `409` loop guard and ScratchPad's pieces. [`docs/plugins.md`](docs/plugins.md).

Both languages are wire-identical: the same record bytes, envelope fields, headers and replies, checked byte for byte and by each language against the other's host.

<details>
<summary><strong>Repository layout</strong></summary>

```
agent-fabric-sdk/
├── README.md            ← you are here
├── CLAUDE.md            ← the layout in detail, the suites, the rules
├── typescript/          ← @synadia-ai/agent-fabric
├── python/              ← synadia-ai-agent-fabric
├── reference-agents/    ← the two reference agents, their caller, getting started
├── plugins/             ← the fabric's add-ons for Claude Code, pi and OpenClaw
├── bundles/             ← the self-contained harness plugins, built from the public plugin and the add-on
├── docs/                ← tracing, ScratchPad, durable runs, the plugins, publication
├── test-fixtures/       ← the contracts (JSON Schemas) and fixtures both suites share
└── .claude/skills/      ← fabric-agent: Claude Code builds, connects and runs an agent
```

</details>

## Development

See [CLAUDE.md](CLAUDE.md): the layout, how to run the suites, the rules. The [Python publication procedure](docs/python-publication.md) defines the package order, trusted publisher, artifact checks and external dependency hold-off.

## License

Apache-2.0, like the protocol SDK. See [LICENSE](LICENSE).
