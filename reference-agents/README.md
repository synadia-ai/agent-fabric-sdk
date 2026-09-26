# agent-fabric-examples

Two agents for the Synadia Agent Fabric, one in TypeScript and one in Python. Each does the four things a participant of the fabric does: it takes prompts under a signed identity, calls its model through the fabric's model proxy, finds and prompts other agents, and hands work over by ScratchPad reference. With them comes a caller that prompts an agent from outside. Copy one agent and adapt it to your fabric.

| Path | What |
| --- | --- |
| `agents/ts/` | the TypeScript agent, its caller (`src/prompt.ts`), the echo agent of the first step (`src/echo.ts`), the tests |
| `agents/py/` | the Python agent, its caller (`fabric_agent/prompt.py`), the echo agent, the tests, among them the one where the two agents prompt each other |
| `tools/README.md` | the agent tools: where their definitions and rules live, how an agent wires them into its model loop, the rules for references |
| `docs/getting-started/` | the walkthrough, one page per language: the same agent grown in six steps, from an echo to a handoff |
| `Makefile`, `scripts/setup.sh` | `make setup` installs the packages; `make agent-ts`, `make agent-py`, `make test` |

The two agents behave the same, give their models the same tools in the same words, and write the same reference token, so either one prompts, and hands work to, the other.

## Where the four behaviours are

Read `agents/ts/src/agent.ts` or `agents/py/fabric_agent/agent.py`. The file is the list of the four, and each is marked `(1)` to `(4)` in the code where it happens. Both files have the same shape: `startAgent` (`start_agent`) wires everything once, and `serve` answers one prompt.

1. **Receive prompts under a signed identity.** Marker `(1)`: `resolveNatsConnectionBundle` reads the credentials file once and gives both the connection and a signer. `new AgentService({ …, identity: { signer } })` puts the agent at `agents.prompt.<kind>.<owner>.<name>` and signs its registration and every heartbeat, so callers can verify who answers. `service.onPrompt` hands each prompt to `serve`.
2. **The model through the proxy, with the trace headers.** Marker `(2)` and `src/model.ts` (`fabric_agent/model.py`): `createModelClient` sends the virtual key as the bearer token, and `converse` calls the fabric package's `traceHeaders()` on every model call. The two headers put the call on the thread of the prompt being served. `fabricTracing()` gives the service the interceptor that starts that thread.
3. **Discover and prompt through the SDK's agent tools.** Marker `(3)`: the `Agents` client with the fabric package's prompt interceptor, and `new AgentTools(…)` over it. `src/tools.ts` (`fabric_agent/tools.py`) shows the model the tools' definitions as chat-completions functions, word for word, and runs each call with the model's tool-call id. A prompt the model sends becomes a child thread under the tool call that sent it.
4. **ScratchPad by reference.** Marker `(4)`, optional: the agent reads the references it is handed, commits its reply, grants the verified caller read on it and appends the reference. Two lines wire it: `scratchPadFromEnv(process.env, { creator: address, nats })` (`scratchpad_from_env(env, creator=address, nats=...)`) builds the agent's ScratchPad from the environment, and `scratchPadExtension({ scratchPad, agents })` applies the fabric's rules to it when the model hands a reference on. Both are the fabric package's; the agent writes no ScratchPad code. Without `SCRATCHPAD_VOLUME` the first gives nothing, and the agent skips all of it and hands work over as text.

## Copy and adapt

Copy `agents/ts/` or `agents/py/`, and `env.example` to `.env`. Until the packages are published, an agent finds them by relative path (`package.json`'s `file:` links, `pyproject.toml`'s uv path sources), so keep your copy next to the original, as `agents/<yours>/`, or change those paths. What you change:

**In `.env`.** Every variable is listed in `env.example`, with what it is and where your fabric gives it.

| Variable | What it sets |
| --- | --- |
| `AGENT_KIND`, `AGENT_OWNER`, `AGENT_NAME` | the address, `agents.prompt.<kind>.<owner>.<name>`, which other agents find and prompt |
| `AGENT_DESCRIPTION` | what discovery shows; another agent's model reads it to decide whom to ask, so say what the agent is for |
| `AGENT_SYSTEM_PROMPT`, or `AGENT_SYSTEM_PROMPT_FILE` for a longer one | the persona |
| `AGENT_TOOLS` | which agent tools the model sees: `blocking` (the default: `discover_agents`, `prompt_agent`, `answer_agent`), `all` (the six), or `none` for a role that must answer itself |
| `MODEL_PROXY_URL`, `MODEL_VIRTUAL_KEY`, `MODEL_NAME` | the proxy, this agent's virtual key, and a model the key's provider serves |
| `NATS_URL`, `NATS_CREDS` | where the fabric is, and this agent's own user; one user per agent |

**In the code.**

- **The persona's default** is in `src/config.ts` (`fabric_agent/config.py`), with every variable the agent reads.
- **The model loop** is `converse` in `src/model.ts` (`fabric_agent/model.py`): one chat-completions request per model call, each tool call run, until the model answers in words. Another model API changes here; keep the trace headers on every call.
- **What a prompt does** is `serve` in `agent.ts` (`agent.py`): what goes in front of the model, and what happens to the reply. The history is one list per process, shared by every caller; a history per caller is the first thing a real agent changes.
- **A tool of your own** goes in `src/tools.ts` (`fabric_agent/tools.py`), next to the agent tools: its definition in the list `toolRunner` (`tool_runner`) gives the model, and a branch in its `call`.

Keep the four behaviours. An agent without the signer is not verified, and callers cannot tell who answered. A model call without the trace headers lands on no thread. A client without the prompt interceptor starts no child thread.

## Install

On your machine: Node 20 or later with npm, Python 3.11 or later with `uv`, and `nats-server` on PATH for the tests. Until the packages are published, also `bun`, which builds the SDK's TypeScript packages. Then:

```sh
make setup
```

It installs three packages in each language. `@synadia-ai/agents` and `synadia-ai-agents` are the agent protocol's caller side and the agent tools. `@synadia-ai/agent-service` and `synadia-ai-agent-service` are its host side. `@synadia-ai/agent-fabric` and `synadia-ai-agent-fabric` are the fabric's tracing and its rules for ScratchPad references.

Until the packages are published, `make setup` builds them from the sibling checkouts; when one is missing, it says what to clone and where. It is safe to run again. `make test` runs both agents' tests.

## Run it

Your fabric gives each agent a NATS user and a virtual key: the console's onboarding issues the user, and its key manager issues the key for the agent's identity. The key manager asks for that identity, `<account>.<user>`; the echo agent prints it before the agent has a key.

**The TypeScript agent.** In `agents/ts`, copy `env.example` to `.env` and fill in `NATS_URL` and `NATS_CREDS`. Print the identity, then stop the echo agent with Ctrl+C:

```sh
npm run echo
```

```
echo agent listening on agents.prompt.echo.me.main
identity: ABTGF33Z…A5HRIPUG.UD345LCY…M3X3MYLO6
```

Issue its key and put it in `.env` as `MODEL_VIRTUAL_KEY`, with `MODEL_PROXY_URL` and `MODEL_NAME`. Then start it:

```sh
npm start
```

```
assistant agent listening on agents.prompt.assistant.me.main
identity: ABTGF33Z…A5HRIPUG.UD345LCY…M3X3MYLO6
model: anthropic/claude-sonnet-5 through http://localhost:18281/api
scratchpad: off
press Ctrl+C to stop (the conversation lives in memory and is gone on restart)
```

**The Python agent.** The same in `agents/py`: its own `.env` from `env.example`, with a user and a key of its own, and other names, so the two have different addresses:

```sh
AGENT_KIND=helper
AGENT_DESCRIPTION=Does arithmetic and counting, exactly, and shows its working
AGENT_TOOLS=none
```

```sh
uv run python -m fabric_agent.echo   # once, for the identity to issue its key for
uv run python -m fabric_agent
```

`AGENT_TOOLS=none` keeps the helper answering itself rather than delegating.

**One prompts the other.** The caller signs with a user of its own. In `agents/ts`, a file `.env.caller` with the caller's `NATS_URL` and `NATS_CREDS` alone:

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant \
  "Find the agent that does arithmetic and ask it what 23 times 4 is. Tell me what it said."
```

```
→ agents.prompt.assistant.me.main (ABTGF33Z…, verified)
The arithmetic agent (helper.me.main) said: **23 times 4 is 92.**
15.1 s
```

The assistant's model called `discover_agents`, read the helper's description, and called `prompt_agent` with the helper's address. The assistant's terminal shows each model call and tool call as it happens. From `agents/py` the Python caller does the same: `uv run python -m fabric_agent.prompt .env.caller assistant "…"`.

**In the console,** the threads page has one tree of two threads. The root is the assistant's: its model calls with their tokens, and each tool call as a row, `discover_agents` with the list it got back and `prompt_agent` with the address and the prompt it sent. The helper's thread hangs under the `prompt_agent` call, with its own model call. It hangs there because the assistant's client carries the fabric package's prompt interceptor, which writes an edge naming the served thread as the parent and the model's tool-call id as the call.

## ScratchPad, if your fabric has it

Agents can hand work over by reference instead of pasting it. Put `sp`, ScratchPad's command line, on PATH, set `SCRATCHPAD_VOLUME` in each agent's `.env` (`assistant-replies`, `helper-replies`) and restart them; each now says `scratchpad: <its volume>`. That is all: the agents write no ScratchPad code, the fabric package drives `sp` for them, and `env.example` lists its other three variables with their defaults. An agent commits its reply to its own volume, grants the verified caller read on it, and ends the reply with a reference:

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant "Write four lines about the sea."
```

```
… four lines …

sp-ref:eyJyZWYiOnsidHlwZSI6…
reference: sp-ref:eyJyZWYiOnsidHlwZSI6…
```

The reference is data, not a key: holding it opens nothing, a grant does. Hand it on:

```sh
REF='sp-ref:…'
node --env-file=.env.caller --import tsx src/prompt.ts assistant \
  "Ask the helper how many words the text at this reference has, and tell me its answer: $REF"
```

The assistant grants the helper read right before `prompt_agent` sends: one agent, the one path the reference names, read only, ten minutes (`SCRATCHPAD_GRANT_TTL_S`). Nothing is granted when content is committed, and never to every agent discovered. The helper reads the text by the reference. In the console the tree shows, in order: the assistant's `read`, its `grant` under the tool call, the helper's `read`, `commit` and `grant` on the child thread, and the assistant's `commit` and `grant` for its reply to you. An agent that hands on content another agent created asks the creator, in code, to grant the recipient; `tools/README.md` has the rule.

**Today the fabric package drives ScratchPad through its command line, `sp`.** Build it from ScratchPad's repository and put it on PATH, or name it in `SCRATCHPAD_BIN`; it connects with the agent's own credentials file. The intended shape is the SDK talking to ScratchPad over NATS directly, which needs ScratchPad's TypeScript and Python clients. Until they exist, `sp`.

## Where to read next

- `docs/getting-started/typescript.md` or `python.md`: the walkthrough, the same agent grown in six steps, with what the console shows after each and why.
- `tools/README.md`: the agent tools as an agent wires them, and the rules for references.
- `agents/ts/README.md`, `agents/py/README.md`: every file, the tests, and how the code reads.
- The SDK's `docs/agent-tools.md`: the tools' contract. The fabric package's README: tracing, the ScratchPad extension, and ScratchPad from the environment.
- Claude Code, OpenClaw and PI join the fabric through their plugins in the SDK repository's `agents/` and the fabric add-ons in the fabric package's `plugins/`; nothing about them lives here.

For colleagues until the release: a fabric on your machine is `make up` in `agent-fabric-live`; its README says how to point these agents at it.
