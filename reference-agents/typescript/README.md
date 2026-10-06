# The TypeScript reference agent

**Date:** 2026-09-27 · **Status:** the agent with its four behaviours and an optional fifth, durable work (`AGENT_DURABLE`), on the SDK's agent tools with the fabric package's ScratchPad extension; its ScratchPad is the fabric package's too, built from the environment, so the agent holds no ScratchPad code. It offers its model three of the tools by default (`AGENT_TOOLS`, below). Tested on a throwaway `nats-server` with a fake model and a ScratchPad in memory; run against a fabric through the model proxy with Sonnet 5.

## What is here

| Path | What |
| --- | --- |
| `src/agent.ts` | the agent: the five behaviours, each marked where it happens |
| `src/main.ts` | starts one agent from the environment; `npm start` |
| `src/echo.ts` | the smallest agent, behaviour (1) alone: a signed identity, tracing on through the fabric package, every prompt answered with the prompt; `npm run echo`. Step 1 of `../docs/getting-started/typescript.md` |
| `src/durable.ts` | behaviour (5), with `AGENT_DURABLE=1`: durable work delegated. The workflows this process hosts, in a small registry (the demo `durable-task`: a model call with the trace headers from the run's input, then the answer written into the result), their worker and client on the agent's connection, the engine behind them, and the tool `start_workflow(name, input)`, which starts one under `durableRunId` of the model's tool-call id |
| `src/durable-agent.ts`, `src/durable-main.ts` | the durable agent, `npm run start:durable`: the front door relays each prompt to a run of the workflow `agent-loop`, whose model turns and tool calls are journaled steps (`../README.md`, "The durable agent") |
| `src/config.ts` | every variable the agent reads, with its default |
| `src/history.ts` | the history the model is shown: one per verified caller, the 32 served last, none with `AGENT_MAX_HISTORY=0`, and one line in front of a reply naming the tools the exchange used |
| `src/model.ts` | one chat-completions client pointed at the proxy, and the loop that runs the model's tool calls |
| `src/reply.ts`, `test/reply*.test.ts` | UTF-8 reply boundaries, verified grants, bounded refusal and subsequent model history |
| `src/tools.ts` | the model loop's side of the SDK's agent tools: their definitions as chat-completions `function`s, not a word changed, and a call run by name with the model's tool-call id |
| `src/prompt.ts` | a caller for the command line: `npm run prompt -- <address or kind> "<text>"`, signed with the environment's credentials; a refused or failed prompt is one line, not a stack |
| `test/tools.test.ts` | the tools as the agent wires them, on a real server: the definitions word for word what the SDK's files derive for the tools offered, the three by default and the six with `AGENT_TOOLS=all`; the edge `prompt_agent` writes has the served thread as its parent; the grant before a reference of its own is handed over, the creator asked for another's, the references taken out for an agent that reads none, only a given reference handed on; the two loop guards; errors in words |
| `test/history.test.ts` | the tools line (names and addresses, never arguments or results), the histories kept apart per verified caller, none for an unverified one, both bounds, and `AGENT_MAX_HISTORY=0` |
| `test/agent.test.ts` | the whole agent against a fake model: the key and the two trace headers on every call, the three blocking tools offered by default, a tool call carried out as a child thread, a question from the prompted agent answered by the model with `answer_agent`, the reply, the history; the reply committed and granted to the verified caller; a reference of its own handed on with a grant under the model's call; a grant request answered in code |
| `test/grant-request.test.ts` | the fabric package's grant request between signed agents, on a real server, over a ScratchPad in memory: the creator grants a third agent at the request of one it granted; no signature, a replay, a requester never granted, a requester granted only on request, a request for oneself and another volume's reference are refused |
| `test/start-workflow.test.ts` | behaviour (5) on a server with JetStream and one account, the durable engine spawned on it (`test/harness/engine.ts`): the run id is the served thread and the sanitised tool-call id, the journal's start entry carries the trace, the step's model call carried the two headers, the agent's connection sent no JetStream API request at all; `AGENT_DURABLE` off by default |
| `test/durable-agent.test.ts` | the durable agent as a child process, killed after the run's first step and started again: the run completes, the first model turn made once, every model call of both processes on the served thread, the killed prompt's stream ended without the reply |
| `test/durable-agent-question.test.ts` | the durable agent in process: a prompted agent's question parked on `ask-0-0` and relayed to the caller, the answer carried back, the edge `prompt_agent` wrote from the worker under the served thread and the model's call |
| `env.example` | the one file per agent; copy to `.env` |

ScratchPad comes from the fabric package: `nativeScratchPadFromEnv` in `src/agent.ts` borrows the agent's authenticated NATS connection.
An unset `SCRATCHPAD_VOLUME` disables ScratchPad. A configured volume requires a persistent private `SCRATCHPAD_DIR`.
The native client needs no shell or `sp`. Policy tests explicitly inject the CLI adapter with a stand-in `sp`.
The SDK's separate native tests use the real ScratchPad service.

Results above 65,536 UTF-8 bytes travel by a granted ScratchPad reference, with a bounded refusal when the handoff fails.
The next model turn keeps that delivery message. See [bounded replies](../docs/bounded-replies.md) for the contract and tests.

New here? `../docs/getting-started/typescript.md` walks through this agent in six steps, from an echo to a handoff through ScratchPad.

## Prerequisites

- Node 22.13 or later for native ScratchPad, npm.
- `nats-server` on PATH for the tests (`brew install nats-server`). The bounded-reply gate fails when it is absent; older fabric tests skip.
- Until the packages are published: `make setup` in `reference-agents/`. It checks the SDK checkout `../../../synadia-agents` is there and on its branch (the `Makefile` names it), builds the SDK's two TypeScript packages and then this repository's fabric package, `../../typescript`, and installs this agent. It builds only what changed, so it is safe to run again.
- For ScratchPad, which is optional: a service import in the agent's NATS account, an allocated volume, and a private persistent workspace.
- For durable work, which is optional: on the fabric, the tenant's import of the durable engine's API (`de.api.>`), which the console's onboarding makes, and an agent user with no durable rights of its own; the agent creates nothing. `AGENT_DURABLE=1` turns on the tool `start_workflow` in `npm start`, and `npm run start:durable` runs the durable agent with the same `.env`.

## Install and test

```sh
make setup            # in reference-agents/
npm run typecheck
npm test
```

The three packages are `file:` links into those directories, which npm installs as symlinks: what you build there is what the agent runs next, with nothing to reinstall here. `@synadia-ai/agents` and `@synadia-ai/agent-service` are the protocol SDK, the agent tools (`AgentTools`) among it; `@synadia-ai/agent-fabric` is the fabric's tracing, which the SDK does not carry, the rules for ScratchPad references on the tools (`scratchPadExtension`, the grant request), and the ScratchPad they run on (`scratchPadFromEnv`). The agent wires them in `src/agent.ts`: `fabricTracing()`'s prompt interceptor on the `Agents` client; the ScratchPad from the environment; the extension and `AgentTools` over that client; on the `AgentService` the request interceptors of tracing, the tools and the extension, in that order, the heartbeat extras, and the grant endpoint. Use npm, not bun: bun 1.4.0 cannot install this manifest (`../docs/findings.md` F2). The SDK keeps the served prompt's trace scope on `globalThis`, so a process that holds two copies of a package still hangs child threads under the right parent (F1). When the packages are published, the links become versions.

## Run

```sh
cp env.example .env      # fill in the credentials path, the proxy URL, the virtual key, the model
npm start
```

The agent needs a fabric that already stands: a NATS server it has credentials for, the model proxy with a provider behind it, a virtual key issued for this agent that names that provider, and, for references, ScratchPad in the account. `../README.md`, "Run it", says where each comes from; `env.example` names every variable. The proxy prefixes the provider origin's path to the request's, so `MODEL_PROXY_URL` ends in `/api` for OpenRouter and in nothing for a local Ollama, whose origin is `http://localhost:11434` without `/v1`.

## The tools the model is offered

`AGENT_TOOLS` in `.env` says which of the SDK's agent tools the model is shown (`src/config.ts`; `src/tools.ts` turns it into `AgentTools`' `tools` option):

| `AGENT_TOOLS` | The model is offered |
| --- | --- |
| `blocking`, the default | `discover_agents`, `prompt_agent` and `answer_agent`. Every prompt waits for its reply, and a question the prompted agent asks comes back to the model to answer. |
| `all` | the six: also `prompt_agent`'s `wait: false`, `wait_agent`, `cancel_agent` and `list_agent_calls`, for a model that runs prompts side by side |
| `none` | nothing, for a role that must answer itself: a model with the tools in reach may delegate what it was asked, even back to its caller |

Every definition is input tokens on every model call. On an agent that delegates, the three cost about 935 tokens a call less than the six (`../docs/findings.md` F18).

## Your own tools

An agent can offer its model tools of its own, next to the agent tools. Pass them to `startAgent` as `ownTools`:

```ts
import { startAgent } from "./agent.js";
import type { OwnTool } from "./tools.js";

const readLines: OwnTool = {
  name: "read_lines",
  description: "The state of each line on this floor.",
  parameters: { type: "object", properties: {} },
  run: async () => ({ lines: [{ id: 1, state: "running" }] }),
};
await startAgent(cfg, console.log, { ownTools: [readLines] });
```

The model sees the agent tools first, then yours. With `AGENT_TOOLS=none` it sees only yours. `run` gets the parsed arguments, and what it returns goes back to the model as JSON. A throw comes back as `{"error": "..."}`. A name that an agent tool already has, or two tools with one name, stop the agent at start.

`run` also gets a context, `run(args, ctx)`. `ctx.ask(question)` asks the caller of the prompt being served, and resolves with the answer's text. So a tool can ask before it acts:

```ts
run: async (args, ctx) => {
  const answer = await ctx.ask(`Stop ${String(args["line"])}? yes/no`);
  if (answer.trim().toLowerCase() !== "yes") return { stopped: false, answer };
  return { stopped: true };
},
```

The question goes to the caller of the prompt whose model made the call, also when the agent serves several prompts at once. The caller has `AGENT_REPLY_TIMEOUT_MS` to answer. A timeout, or a call with no prompt being served, is a throw, which the model reads as `{"error": "..."}`. A tool that needs no context may take the arguments alone.

TypeScript only for now; the Python agent has no such option.

## How it reads

`agent.ts` is the file to read; it is the list of the five behaviours with the code under each. The model loop in `model.ts` is one request per model call, no streaming, so a tool round is one request and one JSON reply. `tools.ts` is what a customer copies to show their own model loop the SDK's agent tools; `../README.md`, "The agent tools", says how an agent wires them, and states the rules for references once.
