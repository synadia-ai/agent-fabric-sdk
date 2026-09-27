# The Python reference agent

**Date:** 2026-09-27 · **Status:** the same agent as `../typescript`, in Python, with the same tests, including the one where the TypeScript agent and the Python one prompt each other. On the SDK's agent tools with the fabric package's ScratchPad extension, and the fabric package's ScratchPad, built from the environment, so the agent holds no ScratchPad code; three tools offered by default (`AGENT_TOOLS`, below); it serves four prompts at once. Run against a fabric through the model proxy with Sonnet 5.

## What is here

`fabric_agent/reply.py` applies the UTF-8 delivery boundary.
`tests/test_reply.py` and `tests/test_reply_agent.py` check exact replies, grants, refusals, and subsequent model history.
The handler gate requires `nats-server` and fails when the executable is absent.

| Path | What |
| --- | --- |
| `fabric_agent/agent.py` | the agent: the four behaviours, each marked where it happens |
| `fabric_agent/__main__.py` | starts one agent from `.env`; `uv run python -m fabric_agent` |
| `fabric_agent/echo.py` | the smallest agent, behaviour (1) alone: a signed identity, tracing on through the fabric package, every prompt answered with the prompt; `uv run python -m fabric_agent.echo`. Step 1 of `../docs/getting-started/python.md` |
| `fabric_agent/prompt.py` | a caller for the command line: `uv run python -m fabric_agent.prompt <env file> <address or kind> "<text>"`, signed with that file's credentials; the twin of `../typescript/src/prompt.ts` |
| `fabric_agent/config.py` | every variable the agent reads, with its default; reads the `.env` file |
| `fabric_agent/model.py` | one chat-completions client pointed at the proxy, and the loop that runs the model's tool calls |
| `fabric_agent/tools.py` | the model loop's side of the SDK's agent tools: their definitions as chat-completions `function`s, not a word changed, and a call run by name with the model's tool-call id |
| `tests/test_tools.py` | the tools as the agent wires them, on a real server: the definitions word for word what the SDK's files derive for the tools offered, the three by default and the six with `AGENT_TOOLS=all`; the edge `prompt_agent` writes has the served thread as its parent; the grant before a reference of its own is handed over, the creator asked for another's, the references taken out for an agent that reads none, only a given reference handed on; the two loop guards; errors in words |
| `tests/test_agent.py` | the whole agent against a fake model: the key and the two trace headers on every call, the three blocking tools offered by default, a tool call carried out as a child thread, a question from the prompted agent answered by the model with `answer_agent`, the reply, the history; the reply committed and granted to the verified caller; a reference of its own handed on with a grant under the model's call; a grant request answered in code |
| `tests/test_grant_request.py` | the fabric package's grant request between signed agents, on a real server, over a ScratchPad in memory: the creator grants a third agent at the request of one it granted; no signature, a replay, a requester never granted, a requester granted only on request, a request for oneself and another volume's reference are refused |
| `tests/test_interop.py` | the TypeScript agent (a subprocess) and this one prompt each other; each child thread under the delegating agent's served thread. And a reference crosses the languages: over the package's stand-in `sp`, one store, the TypeScript agent commits and grants the Python agent read on the one path, and only then does the Python agent read it |
| `env.example` | the one file per agent; copy to `.env` |

ScratchPad comes from the fabric package: `await native_scratchpad_from_env(env, nc=nc, creator=address)` in `fabric_agent/agent.py` borrows the agent's authenticated connection and gives `None` when `SCRATCHPAD_VOLUME` is unset. A configured volume requires a persistent private `SCRATCHPAD_DIR`; it needs no shell or `sp`. `__main__.py` passes the environment it read, `.env` included. Reference-policy tests explicitly inject the CLI adapter with a stand-in `sp`. The SDK's separate native tests use the real ScratchPad service.

Results above 65,536 UTF-8 bytes travel by a granted ScratchPad reference, with a bounded refusal when the handoff fails.
The next model turn keeps that delivery message. See [bounded replies](../docs/bounded-replies.md) for the contract and tests.

New here? `../docs/getting-started/python.md` walks through this agent in six steps, from an echo to a handoff through ScratchPad.

## Prerequisites

- Python 3.12 or later and `uv`.
- `nats-server` on PATH for the tests (`brew install nats-server`); without it the fabric tests skip themselves.
- Until the packages are published, run `make setup` in `reference-agents/`. It checks the sibling `synadia-agents` checkout and installs both agents. Python resolves the two protocol packages and this repository's fabric package through the path sources in `pyproject.toml`; `uv sync` installs them editable. The protocol SDK supplies `AgentTools`. The fabric package supplies tracing, reference policy, and `native_scratchpad_from_env`. `fabric_agent/agent.py` wires the prompt interceptor on `Agents`, then tracing, tools, and reference request interceptors on `AgentService`, plus heartbeat extras, the grant endpoint, and four concurrent prompts.
- For the interop test: `../typescript` installed (`make setup` does it) and `node` on PATH.
- For ScratchPad, which is optional: a service import in the agent's NATS account, an allocated volume, and a private persistent workspace.

## Install and test

```sh
make setup            # in reference-agents/
uv run pytest
```

## Run

```sh
cp env.example .env      # fill in the credentials path, the proxy URL, the virtual key, the model
uv run python -m fabric_agent
```

The agent needs a fabric that already stands, exactly as the TypeScript agent does (`../typescript/README.md`).

## The tools the model is offered

`AGENT_TOOLS` in `.env` says which of the SDK's agent tools the model is shown (`fabric_agent/config.py`; `fabric_agent/tools.py` turns it into `AgentTools`' `tools` option):

| `AGENT_TOOLS` | The model is offered |
| --- | --- |
| `blocking`, the default | `discover_agents`, `prompt_agent` and `answer_agent`. Every prompt waits for its reply, and a question the prompted agent asks comes back to the model to answer. |
| `all` | the six: also `prompt_agent`'s `wait: false`, `wait_agent`, `cancel_agent` and `list_agent_calls`, for a model that runs prompts side by side |
| `none` | nothing, for a role that must answer itself: a model with the tools in reach may delegate what it was asked, even back to its caller |

Every definition is input tokens on every model call. On an agent that delegates, the three cost about 935 tokens a call less than the six (`../docs/findings.md` F18).

## How it reads

`fabric_agent/agent.py` is the file to read: the list of the four behaviours with the code under each. It mirrors `../typescript/src/agent.ts` line for line where the packages allow; the differences are the packages' own (`session_name` for the instance name, `PromptStream` for the handler's response handle, `execute(name, args, tool_call_id=…)` for `execute(name, args, { toolCallId })`, and in the fabric package a context variable instead of an `AsyncLocalStorage` for the ambient trace scope), and one of the host's: the Python `AgentService` serves one prompt at a time unless told otherwise, so the agent sets `max_concurrent_prompts` (four; `MAX_CONCURRENT_PROMPTS` in `agent.py` says why).
