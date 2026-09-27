# The TypeScript reference agent

**Date:** 2026-09-27 · **Status:** the agent with its four behaviours, on the SDK's agent tools with the fabric package's ScratchPad extension; its ScratchPad is the fabric package's too, built from the environment, so the agent holds no ScratchPad code. It offers its model three of the tools by default (`AGENT_TOOLS`, below). Tested on a throwaway `nats-server` with a fake model and a ScratchPad in memory; run against a fabric through the model proxy with Sonnet 5.

## What is here

| Path | What |
| --- | --- |
| `src/agent.ts` | the agent: the four behaviours, each marked where it happens |
| `src/main.ts` | starts one agent from the environment; `npm start` |
| `src/echo.ts` | the smallest agent, behaviour (1) alone: a signed identity, tracing on through the fabric package, every prompt answered with the prompt; `npm run echo`. Step 1 of `../docs/getting-started/typescript.md` |
| `src/config.ts` | every variable the agent reads, with its default |
| `src/model.ts` | one chat-completions client pointed at the proxy, and the loop that runs the model's tool calls |
| `src/reply.ts`, `test/reply*.test.ts` | UTF-8 reply boundaries, verified grants, bounded refusal and subsequent model history |
| `src/tools.ts` | the model loop's side of the SDK's agent tools: their definitions as chat-completions `function`s, not a word changed, and a call run by name with the model's tool-call id |
| `src/prompt.ts` | a caller for the command line: `npm run prompt -- <address or kind> "<text>"`, signed with the environment's credentials; a refused or failed prompt is one line, not a stack |
| `test/tools.test.ts` | the tools as the agent wires them, on a real server: the definitions word for word what the SDK's files derive for the tools offered, the three by default and the six with `AGENT_TOOLS=all`; the edge `prompt_agent` writes has the served thread as its parent; the grant before a reference of its own is handed over, the creator asked for another's, the references taken out for an agent that reads none, only a given reference handed on; the two loop guards; errors in words |
| `test/agent.test.ts` | the whole agent against a fake model: the key and the two trace headers on every call, the three blocking tools offered by default, a tool call carried out as a child thread, a question from the prompted agent answered by the model with `answer_agent`, the reply, the history; the reply committed and granted to the verified caller; a reference of its own handed on with a grant under the model's call; a grant request answered in code |
| `test/grant-request.test.ts` | the fabric package's grant request between signed agents, on a real server, over a ScratchPad in memory: the creator grants a third agent at the request of one it granted; no signature, a replay, a requester never granted, a requester granted only on request, a request for oneself and another volume's reference are refused |
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

## How it reads

`agent.ts` is the file to read; it is the list of the four behaviours with the code under each. The model loop in `model.ts` is one request per model call, no streaming, so a tool round is one request and one JSON reply. `tools.ts` is what a customer copies to show their own model loop the SDK's agent tools; `../README.md`, "The agent tools", says how an agent wires them, and states the rules for references once.
