# The reference agents

The worked example of this repository's package, `@synadia-ai/agent-fabric` and `synadia-ai-agent-fabric`: two agents for the Synadia Agent Fabric, one in TypeScript and one in Python, built on the protocol SDK and this package and nothing else. Each does the four things a participant of the fabric does: it takes prompts under a signed identity, calls its model through the fabric's model proxy, finds and prompts other agents, and hands work over by ScratchPad reference. With them comes a caller that prompts an agent from outside. Copy one agent and adapt it to your fabric.

| Path | What |
| --- | --- |
| `typescript/` | the TypeScript agent, its caller (`src/prompt.ts`), the echo agent of the first step (`src/echo.ts`), the tests |
| `python/` | the Python agent, its caller (`fabric_agent/prompt.py`), the echo agent, the tests, among them the one where the two agents prompt each other |
| `docs/getting-started/` | the walkthrough, one page per language: the same agent grown in six steps, from an echo to a handoff |
| `docs/findings.md` | what was measured while the agents were built |
| `Makefile`, `scripts/setup.sh` | `make setup` installs the packages; `make agent-ts`, `make agent-py`, `make test` |

The two agents behave the same, give their models the same tools in the same words, and write the same reference token, so either one prompts, and hands work to, the other.

## Where the four behaviours are

Read `typescript/src/agent.ts` or `python/fabric_agent/agent.py`. The file is the list of the four, and each is marked `(1)` to `(4)` in the code where it happens. Both files have the same shape: `startAgent` (`start_agent`) wires everything once, and `serve` answers one prompt.

1. **Receive prompts under a signed identity.** Marker `(1)`: `resolveNatsConnectionBundle` reads the credentials file once and gives both the connection and a signer. `new AgentService({ …, identity: { signer } })` puts the agent at `agents.prompt.<kind>.<owner>.<name>` and signs its registration and every heartbeat, so callers can verify who answers. `service.onPrompt` hands each prompt to `serve`.
2. **The model through the proxy, with the trace headers.** Marker `(2)` and `src/model.ts` (`fabric_agent/model.py`): `createModelClient` sends the virtual key as the bearer token, and `converse` calls the fabric package's `traceHeaders()` on every model call. The two headers put the call on the thread of the prompt being served. `fabricTracing()` gives the service the interceptor that starts that thread.
3. **Discover and prompt through the SDK's agent tools.** Marker `(3)`: the `Agents` client with the fabric package's prompt interceptor, and `new AgentTools(…)` over it. `src/tools.ts` (`fabric_agent/tools.py`) shows the model the tools' definitions as chat-completions functions, word for word, and runs each call with the model's tool-call id. A prompt the model sends becomes a child thread under the tool call that sent it.
4. **ScratchPad by reference.** Marker `(4)`, optional: the agent reads the references it is handed, commits its reply, grants the verified caller read on it and appends the reference. TypeScript awaits `nativeScratchPadFromEnv(process.env, { nc, creator: address })` on its existing authenticated connection. Python uses `scratchpad_from_env(env, creator=address, nats=...)` through `sp`. `scratchPadExtension({ scratchPad, agents })` applies the fabric's reference rules to either client. Without `SCRATCHPAD_VOLUME` the factory returns no client, and the agent hands work over as text.

## Copy and adapt

Copy `typescript/` or `python/`, and `env.example` to `.env`. Until the packages are published, an agent finds them by relative path (`package.json`'s `file:` links, `pyproject.toml`'s uv path sources), so keep your copy next to the original, as `reference-agents/<yours>/`, or change those paths. What you change:

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
- **The model loop** is `converse` in `src/model.ts` (`fabric_agent/model.py`): one chat-completions request per model call, each tool call run, until the model answers in words. An empty answer is never the reply: while a call it started still waits or runs, the model is told what waits and asked again, up to twice; with nothing open, it is asked once more. Then the prompt fails with the reason, never `ok` with nothing (`docs/findings.md` F29). Another model API changes here; keep the trace headers on every call.
- **What a prompt does** is `serve` in `agent.ts` (`agent.py`): what goes in front of the model, and what happens to the reply. The history is one list per process, shared by every caller; a history per caller is the first thing a real agent changes.
- **A tool of your own** goes in `src/tools.ts` (`fabric_agent/tools.py`), next to the agent tools: its definition in the list `toolRunner` (`tool_runner`) gives the model, and a branch in its `call`.

Keep the four behaviours. An agent without the signer is not verified, and callers cannot tell who answered. A model call without the trace headers lands on no thread. A client without the prompt interceptor starts no child thread.

## Install

On your machine: Node 22.13 or later with npm for the TypeScript native ScratchPad writer, Python 3.11 or later with `uv`, and `nats-server` on PATH for the tests. Until the packages are published, also `bun`, which builds the SDK's TypeScript packages. Then:

```sh
make setup
```

It installs three packages in each language. `@synadia-ai/agents` and `synadia-ai-agents` are the agent protocol's caller side and the agent tools. `@synadia-ai/agent-service` and `synadia-ai-agent-service` are its host side. `@synadia-ai/agent-fabric` and `synadia-ai-agent-fabric` are the fabric's tracing and its rules for ScratchPad references.

Until the packages are published, the agents link them by relative path. The protocol SDK comes from its checkout next to this repository, `../synadia-agents` on branch `sdk-release-rollout`; `make setup` checks it is there and on that branch (`ANY_BRANCH=1` builds another), and when it is missing says what to clone and where. The fabric package is this repository's own, `../typescript` and `../python`. `make setup` builds the TypeScript packages in place when their sources are newer than their builds; Python needs no build, `uv` installs all three editable. It is safe to run again.

```sh
make test         # both agents' tests; nats-server on PATH
make agent-ts     # the TypeScript agent, from typescript/.env
make agent-py     # the Python agent, from python/.env
```

## Run it

A fabric provides what an agent needs: a NATS URL and a credentials file per agent, the model proxy's URL, a virtual key per agent, and ScratchPad if it has it. Each agent's `env.example` names the variable for each.

Your fabric gives each agent a NATS user and a virtual key: the console's onboarding issues the user, and its key manager issues the key for the agent's identity. The key manager asks for that identity, `<account>.<user>`; the echo agent prints it before the agent has a key.

**The TypeScript agent.** In `typescript/`, copy `env.example` to `.env` and fill in `NATS_URL` and `NATS_CREDS`. Print the identity, then stop the echo agent with Ctrl+C:

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

**The Python agent.** The same in `python/`: its own `.env` from `env.example`, with a user and a key of its own, and other names, so the two have different addresses:

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

**One prompts the other.** The caller signs with a user of its own. In `typescript/`, a file `.env.caller` with the caller's `NATS_URL` and `NATS_CREDS` alone:

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant \
  "Find the agent that does arithmetic and ask it what 23 times 4 is. Tell me what it said."
```

```
→ agents.prompt.assistant.me.main (ABTGF33Z…, verified)
The arithmetic agent (helper.me.main) said: **23 times 4 is 92.**
15.1 s
```

The assistant's model called `discover_agents`, read the helper's description, and called `prompt_agent` with the helper's address. The assistant's terminal shows each model call and tool call as it happens. From `python/` the Python caller does the same: `uv run python -m fabric_agent.prompt .env.caller assistant "…"`.

**In the console,** the threads page has one tree of two threads. The root is the assistant's: its model calls with their tokens, and each tool call as a row, `discover_agents` with the list it got back and `prompt_agent` with the address and the prompt it sent. The helper's thread hangs under the `prompt_agent` call, with its own model call. It hangs there because the assistant's client carries the fabric package's prompt interceptor, which writes an edge naming the served thread as the parent and the model's tool-call id as the call.

## ScratchPad, if your fabric has it

Ask your deployment to provision a volume for each agent's account and user (`AssistantReplies`, `HelperReplies`: letters and digits only). Set `SCRATCHPAD_VOLUME` in each agent's `.env` to that volume.

- **TypeScript:** the native client uses the agent's NATS connection and needs no `sp` binary. Set `SCRATCHPAD_DIR` to a private directory on persistent local storage, such as `/var/lib/my-agent/scratchpad`. This setting is required; there is no temporary-directory default.
- **Python:** the CLI adapter still needs `sp` on PATH or at `SCRATCHPAD_BIN`. Its `env.example` describes its workspace and connection settings.

Keep one workspace per writer. A native client cannot automatically adopt a CLI workspace or an established writer with a missing journal. Recover pending work with its original client and journal. To abandon that recovery promise deliberately, use `resetWriter({ target, expectedGeneration })` with the exact volume incarnation and observed writer generation. Stop the previous writer first. The [native client contract](../docs/scratchpad-native.md) defines recovery and reset behavior.

Restart the agents; each now says `scratchpad: <its volume>`. An agent commits its reply to its own volume, retained for ten minutes, grants the verified caller read on it, and ends the reply with a reference. ScratchPad grants only within the reference's account, so the caller gets a reference when its user is in the agents' account, and the reply in words alone otherwise:

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant "Write four lines about the sea."
```

```
… four lines …

sp-ref:eyJ2ZXJzaW9uIjoy…
reference: sp-ref:eyJ2ZXJzaW9uIjoy…
```

The reference is data, not a key: holding it opens nothing, a grant does. Hand it on:

```sh
REF='sp-ref:…'
node --env-file=.env.caller --import tsx src/prompt.ts assistant \
  "Ask the helper how many words the text at this reference has, and tell me its answer: $REF"
```

The assistant grants the helper read right before `prompt_agent` sends: one agent, the one path the reference names, read only, ten minutes (`SCRATCHPAD_GRANT_TTL_S`). Nothing is granted when content is committed, and never to every agent discovered. The helper reads the text by the reference. In the console the tree shows, in order: the assistant's `read`, its `grant` under the tool call, the helper's `read`, `commit` and `grant` on the child thread, and the assistant's `commit` and `grant` for its reply to you. An agent that hands on content another agent created asks the creator, in code, to grant the recipient; "The rules for references" below has the rule.

The native TypeScript client and the Python CLI adapter use the same v2 reference format and service API. Delivery and review findings belong in [SDK issue #19](https://github.com/synadia-ai/agent-fabric-sdk/issues/19).

## The agent tools

Every reference agent gives its model the agent tools. They make an agent on the fabric a participant rather than a leaf: it can see who else is there, and it can prompt them.

| Tool | Does |
| --- | --- |
| `discover_agents` | lists the agents that can be prompted, one entry per address: kind, owner, name, description, identity and whether it verified, whether it needs signed prompts or takes attachments, how many instances answer there, and, from the fabric's extension, whether it reads ScratchPad references |
| `prompt_agent` | prompts one agent by address. By default it waits for the reply, or for a question the other agent asks; with `wait: false` it returns at once with a `call_id` |
| `answer_agent` | answers the question a prompted agent asked, then waits again or returns at once |
| `wait_agent` | waits for the first of several calls started with `wait: false` that finished or asked |
| `cancel_agent` | stops calls; the stream is dropped, the prompted agent works on |
| `list_agent_calls` | lists the calls started in the prompt being served |

The agents offer the first three unless told otherwise (`AGENT_TOOLS`, under "How an agent wires them").

### Where things are

| What | Where |
| --- | --- |
| The words the model reads, and the parameters | the SDK's `test-fixtures/agent-tools/<tool>.json`, embedded in both SDKs; an agent reads them as `tools.definitions` |
| What each tool hands back | the SDK's `test-fixtures/agent-tools/*.result.json` |
| The rules: states, the served prompt's scope, questions, guards, limits | the SDK's `docs/agent-tools.md` |
| What the fabric adds: the trace, the rules for references | the fabric package's README, [`../README.md`](../README.md) |
| The rules for references, in code; the grant request, both sides | the fabric package: `scratchPadExtension`, `requestGrant`, `grantRequestEndpoint` (`scratch_pad_extension`, `request_grant`, `grant_request_endpoint`) |
| The grant request's two shapes | [`../test-fixtures/schemas/`](../test-fixtures/schemas/): `sp-grant-request.json` and `sp-grant-reply.json` |
| The ScratchPad the rules run on | TypeScript: `await nativeScratchPadFromEnv(env, { nc, creator })`, over NATS. Python: `scratchpad_from_env`, over `sp`. Both implement the fabric package's ScratchPad port |
| The model loop's side | the agents: `typescript/src/tools.ts`, `python/fabric_agent/tools.py` |

The tests of both agents check the definitions word for word against what the SDK's files derive for the tools offered (the three without their `wait` parameter and with `blocking.json`'s words; the six as they are), the results against the SDK's result schemas, and the grant request against the fabric package's two schemas.

### How an agent wires them

`typescript/src/agent.ts` and `python/fabric_agent/agent.py` do this, each step commented where it happens.

1. **One client**, on the agent's own connection and signed as the agent, with the fabric package's prompt interceptor. Every prompt the tools send and every grant request goes over it.
2. **The extension**, `scratchPadExtension({ scratchPad, agents: client })`, over the client from the language's factory above. The agent configures ScratchPad; the package holds the reference rules.
3. **The tools**, `new AgentTools({ agents: client, tools: ["discover_agents", "prompt_agent", "answer_agent"], selfAddress, maxWaitMs, extensions: [ext] })`. `tools` is what the model is offered (`AGENT_TOOLS`, below; left out for `all`, which is the SDK's six). `selfAddress` keeps the agent out of its own discovery and refuses a prompt to itself. `maxWaitMs` is how long one prompt to another agent may run (`AGENT_REPLY_TIMEOUT_MS`). No attachment roots are named: the SDK's default is its staging directory alone, which holds only the files other agents sent back, so a file of the agent's own, such as its `.env` with the virtual key, cannot be attached. These agents hand content over through ScratchPad.
4. **The service**, with its request interceptors in this order: `[tracing.requestInterceptor, tools.requestInterceptor, ext.requestInterceptor]`. Tracing binds the served prompt's thread, so all that runs inside it is on that thread. The tools open the prompt's scope, so the calls the model makes belong to this prompt and end with it, and they learn the verified sender for the loop guard. The extension notes the references the prompt hands over, so the model may hand them on. The service registers `scratchpad_refs_ok: "true"` (`extraMetadata`) and takes grant requests at `agents.sp-grant.<agent>.<owner>.<name>` (`extraEndpoints: [grantRequestEndpoint(…)]`), in both languages.
5. **The model loop.** The definitions go into the request's `tools` array, each wrapped as `{"type": "function", "function": {name, description, parameters}}`, not a word changed. Each tool call the model makes runs as `tools.execute(name, args, { toolCallId })` (`tool_call_id=` in Python) with the model's own tool-call ID; the result, as JSON text, is the `tool` message's content. `prompt_agent` puts the ID in the prompt's context, where the fabric's tracing writes it on the `edge`, so the child thread hangs under the tool call that spawned it.
6. **The reply.** The agent commits its reply to ScratchPad and asks `ext.grantCaller(reference, sender)`. That grants the served prompt's sender read, only a sender whose signature verified, and notes the reference as given. The reference goes into the reply only when it returns true.

A Python agent also sets `max_concurrent_prompts`: the Python host serves one prompt at a time unless told otherwise, and an agent waiting on its own call would then take no prompt back. The agents here serve four at once.

**Which tools** (`AGENT_TOOLS`, the same in both languages). `blocking`, the default, offers `discover_agents`, `prompt_agent` and `answer_agent`: every prompt waits for its reply, and a question the prompted agent asks comes back to the model. Without `wait_agent` nothing can be detached, so the SDK shows `prompt_agent` and `answer_agent` without their `wait` parameter, in words that name no tool it does not offer. That is all a model that delegates one step at a time needs, and every definition is input tokens on every model call: the three cost an agent that delegates about 935 tokens a call less than the six (`docs/findings.md` F18). `all` offers the six, for a model that runs prompts side by side. `none` offers nothing, for a role that must never delegate, such as a researcher or a writer another agent calls; the agent keeps the capability, its model is not shown it.

### What the model sees

Every result is a JSON object. A call's result carries `call_id` and `state` (`running`, `input_required`, `completed`, `failed`, `cancelled`, `expired`) and what the state carries: `reply`, `question`, `error`. A refusal is `{"error": "…"}` alone: nothing was sent. While calls the model started are open, every result says how many (`open_calls`, `open_calls_note`). A question the prompted agent asks reaches the model, which answers it with `answer_agent`; nothing answers on its behalf. The extension adds `reads_scratchpad_references` to each discovery entry, and `references_removed` and `note` to a call whose prompt lost references on the way.

### The rules for references

The rules are the fabric package's code; they are stated here once.

**Least authority.** A reference opens nothing until its creator grants the reader. A grant goes to one agent, on the one path the reference names, read only, with an expiry (ten minutes by default, `SCRATCHPAD_GRANT_TTL_S`), immediately before the reference is sent, and only to an identity discovery verified. Nothing is granted when content is committed, and never to every agent discovered.

**Who reads references says so** (`docs/findings.md` F11). An agent that reads the references it is handed registers `scratchpad_refs_ok: "true"`; discovery shows it as `reads_scratchpad_references`. A reference goes only to such an agent. For any other, the harnesses among them, the references are taken out of the prompt, the rest is sent, nothing is asked or granted, and the result says how many were removed. A prompt that was nothing but references is not sent.

**Only a reference the agent was given.** It committed it, or it arrived in a prompt it served or in a reply or question it received. Any other token, one a model wrote itself or copied with a character wrong (F11), is refused before anything is read, asked or granted, with words that say to copy the reference exactly.

**Its own content: the agent grants.** A grant that fails means the prompt is not sent, and the model is told.

**Content another agent created: the creator grants, asked in code** (`docs/findings.md` F13). In ScratchPad only a volume's owner grants, and being allowed to read is not being allowed to pass on; ScratchPad's first version leaves delegation out on purpose. So the agent sends the creator, whose prompt address the token names (`creator`), one signed request on `agents.sp-grant.<agent>.<owner>.<name>`: this reference, for this grantee. The subject is derived by the requester, never taken from the token or from metadata, and the request goes only to an address discovery shows with a verified identity. No model sees the request or decides the answer. The creator's rule: the signature verifies, a replay is refused; the reference points into its own volume; it granted the requester read on that reference **first-hand** and that grant is live; the requester asks for another agent, not for itself. Then it grants read on the one path, recorded as made on request. A refusal or no answer takes that reference out of the prompt, and the rest is sent.

**First-hand, and on request** (F13 item 9). A grant is first-hand when the creator handed the reference itself: to the verified caller of its reply, or to the agent it prompted with a reference of its own. A grant made because another agent asked is on request. Only a first-hand grant entitles its holder to ask; a grant made on request lets its holder read and confers no right to ask for anyone. So content travels at most one hop beyond the agents its creator chose. The creator's ledger, in the package's ScratchPad, keeps the two kinds apart, because ScratchPad knows the grants and not how they came about.

**Persistence.** The native TypeScript client keeps its grant ledger in the persistent workspace. The Python CLI adapter's ledger remains in memory. The fabric extension's set of given references is process-local in both languages: after a restart it must receive a reference again before the tools can hand it on. An unknown reference is refused. Separate agent instances do not share this state or a writer workspace.

### The guards

`prompt_agent` refuses the agent's own address, and the agent that sent the prompt being served: the two shortest loops, which a small model with the tools in reach walks into when it would rather ask back than answer. The SDK compares the served prompt's verified sender with the identity the target registered, so the second guard holds for a signed caller only; sign every caller. Both refusals come back in words. A loop through three or more agents is not caught: a depth or hop limit per tree is the next guard.

Nothing the model gets wrong throws: an unknown tool, bad arguments, an unknown address, a refused prompt, a stalled stream all come back as results in words, so the model reads what happened and decides.

### Why the tools are the SDK's

Every agent runs its model loop differently, so the tools began as reference code an agent copies and adapts. They proved general, and became the SDK's contract: async calls and three more tools, one helper in both SDKs, with hooks for extensions, the fabric's ScratchPad rules among them. What stays an agent's own is the model loop's side: how the definitions reach its model, and how a call runs. That is `tools.ts` and `tools.py`, a page each.

## Where to read next

- [`docs/getting-started/typescript.md`](docs/getting-started/typescript.md) or [`python.md`](docs/getting-started/python.md): the walkthrough, the same agent grown in six steps, with what the console shows after each and why.
- [`typescript/README.md`](typescript/README.md), [`python/README.md`](python/README.md): every file, the tests, and how the code reads.
- This package's READMEs, [`../typescript/README.md`](../typescript/README.md) and [`../python/README.md`](../python/README.md), and the repository's [`../README.md`](../README.md): tracing, the ScratchPad extension, and ScratchPad from the environment.
- The [native ScratchPad client contract](../docs/scratchpad-native.md): TypeScript runtime, persistent workspaces, recovery, and bounded artifact methods.
- The SDK's `docs/agent-tools.md`: the tools' contract.
- Claude Code, OpenClaw and PI join the fabric through their plugins in the SDK repository's `agents/` and this repository's fabric add-ons in [`../plugins/`](../plugins/); nothing about them lives here.
