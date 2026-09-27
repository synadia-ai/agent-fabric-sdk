# Getting started: a Python agent on the fabric

**Date:** 2026-09-26 · **Status:** every command on this page was run in this order, on a Mac, with `anthropic/claude-sonnet-5` through the model proxy, and the outputs shown are from those runs; the steps take about ten minutes once the prerequisites are in place. Since 2026-09-26 the page starts from a fabric you already have, and the same two agents ran step 5's two-agent case and step 6's handoff on such a fabric that day. The TypeScript page, `typescript.md`, is this page with TypeScript's commands.

You will put one agent on the fabric and grow it in six steps. Each step adds one thing, and after each you look at what the console shows and why.

| Step | The agent | What you see for the first time |
| --- | --- | --- |
| 1 | answers every prompt with the prompt | the agent on the fabric, under a signed identity |
| 2 | asks a model, through the proxy | a thread with a model call and its tokens |
| 3 | has a persona | the same, in character |
| 4 | remembers the conversation | an answer that needs the earlier prompt |
| 5 | can discover and prompt other agents | a child thread under a tool call |
| 6 | hands work over through ScratchPad | a commit, a grant and a read on the timeline |

The agent is `reference-agents/python/` in this repository. It is the reference agent: what you copy and change. Steps 2 to 6 are one program, `fabric_agent/agent.py`, with more of its configuration switched on each time. Read it next to this page. Its four behaviours are marked `(1)` to `(4)` where they happen.

## Before you start

**The tools.** Python 3.12 or later and `uv`, Node 22.13 or later with npm for `make setup`; `nats-server` on PATH for the tests; until the packages are published, `bun`, with which `make setup` builds the SDK's TypeScript packages. Step 6 uses the native Python client and needs ScratchPad's service import in your account.

**The packages.** The SDK speaks the agent protocol and nothing more: `@synadia-ai/agents` and `@synadia-ai/agent-service`, `synadia-ai-agents` and `synadia-ai-agent-service` in Python. What makes a prompt a thread in the console, tracing, is the fabric's own package, `@synadia-ai/agent-fabric` (`synadia-ai-agent-fabric` in Python). So are the fabric's rules for handing content over by ScratchPad reference, an extension of the SDK's agent tools (step 6). Until they are published, the SDK comes from its checkout next to this repository, and the fabric package is this repository's own (`../typescript`, `../python`). `make setup` in `reference-agents/` checks that the SDK's checkout is there and on the right branch, builds the TypeScript packages, and installs both agents. For Python nothing is built: `uv` installs the three packages editable from their directories (`pyproject.toml`, `[tool.uv.sources]`).

**Install and test the agent:**

```sh
make setup            # in reference-agents/: the packages, then both agents
cd python
uv run pytest -q      # 8 tests; they need nats-server on PATH
```

One of the tests starts the TypeScript agent and has the two prompt each other; it needs `reference-agents/typescript` installed (`make setup` does it) and `node` on PATH, and skips itself otherwise.

## What your fabric gives you

An agent needs five things from the fabric it joins. None of them is in this repository, and none belongs in one.

| What | Where you get it | Why |
| --- | --- | --- |
| the NATS URL | your fabric | where agents meet |
| a user credentials file per identity | the console's onboarding, one user per agent | on the fabric an agent's identity is its NATS user |
| the model proxy's URL | your fabric | what every model call goes through |
| a virtual key per agent | the console's key manager, for the agent's identity and your model provider | the proxy's bearer token: it names the agent and the provider |
| the console | your fabric | where you look |

This page uses three identities: `assistant`, the agent you grow; `helper`, a second agent for step 5; and `caller`, you at the command line. Each is a credentials file of its own. The console shows an agent under the names its `.env` gives; the user is only the identity it signs with. The examples below use the proxy at `http://localhost:18281` and NATS at `nats://localhost:14422`; put your fabric's in their place.

## Step 1: an agent that echoes

Two small files in `reference-agents/python/`. Both are gitignored, as every `.env` file here is.

`.env`, the agent:

```sh
NATS_URL=nats://localhost:14422
NATS_CREDS=/path/to/assistant.creds
AGENT_KIND=assistant
AGENT_OWNER=me
AGENT_NAME=main
```

`.env.caller`, you at the command line:

```sh
NATS_URL=nats://localhost:14422
NATS_CREDS=/path/to/caller.creds
```

Start the echo agent, and prompt it from a second terminal:

```sh
uv run python -m fabric_agent.echo
```

```
echo agent listening on agents.prompt.echo.me.main
identity: ABQIEOAE…H4VFW.UCW6PNH4…672PP
```

```sh
uv run python -m fabric_agent.prompt .env.caller echo "hello, fabric"
```

```
→ agents.prompt.echo.me.main (ABQIEOAE…H4VFW.UCW6PNH4…672PP, verified)
echo: hello, fabric
```

**What happened.** `fabric_agent/echo.py` is short, and three things in it matter:

- `resolve_nats_connection_bundle` reads the credentials file once and gives back both the connection options and a signer. So the identity the agent registers is the identity its connection logged in with.
- `AgentService(…, identity=ServiceIdentity(signer=…))` puts the agent on the fabric at `agents.prompt.<kind>.<owner>.<name>`. With the signer, its registration is signed: the caller's `verified` is that signature checked. The signer also signs every heartbeat the agent sends, which is what the fabric reads as *online*: an agent proves it is up with its own key, and the fabric only listens.
- `fabric_tracing()` from `synadia_ai.agent_fabric` turns tracing on, one line in the service's arguments: `interceptors=[tracing.request_interceptor], heartbeat_extras=tracing.heartbeat_extras`. The request interceptor takes the thread a tracing caller sent, or starts one, and runs the handler inside it: a prompt is a thread. The heartbeat extras report how many trace records the process published. The SDK knows nothing of the fabric; the package plugs into its hooks.
- `service.on_prompt(…)` is the whole agent.

`fabric_agent/prompt.py` is the other side: it discovers the agents on the fabric, finds `echo`, and prompts it, signed as `caller`.

**In the console.** The threads page has one tree, its status `empty`. The agents page lists both: the echo agent as online, from the heartbeat it signs and sends every thirty seconds, with nothing else against it; and the caller, with one prompt sent. The difference is how the fabric sees an agent: through what it does. The model proxy records its model calls, the agent itself records the prompts it sends, ScratchPad records what it stores and reads. A receiver that does none of these leaves no record but its presence, and the tree stays `empty`. Step 2 changes that.

Stop the echo agent with Ctrl+C.

## Step 2: a model, through the proxy

The agent never talks to a model provider. It holds the proxy's address, a virtual key and a model name. The proxy looks the key up, learns which agent is calling and which provider the key is for, swaps in the provider's real key, forwards the call, and records it.

Issue a virtual key for the agent's identity in the console's key manager. It asks for the identity step 1's echo agent printed, `<account>.<user>`, your model provider, and that provider's API key, which the console seals and the agent never sees. The key is shown once: paste it into `.env` and nowhere else.

```sh
MODEL_VIRTUAL_KEY=sk_syn_…
```

Add three more lines:

```sh
AGENT_TOOLS=none
MODEL_PROXY_URL=http://localhost:18281/api
MODEL_NAME=anthropic/claude-sonnet-5
```

`/api` is OpenRouter's path, not the proxy's, for a key that names OpenRouter: the proxy appends what the client sends to the provider's origin, and OpenRouter serves chat completions at `/api/v1/…`. For a key that names a local Ollama the URL carries no path: the proxy's origin for Ollama is `http://localhost:11434`, without `/v1`. `AGENT_TOOLS=none` keeps the agent tools away from the model until step 5.

Start the reference agent, and prompt it:

```sh
uv run python -m fabric_agent
```

```
assistant agent listening on agents.prompt.assistant.me.main
model: anthropic/claude-sonnet-5 through http://localhost:18281/api
scratchpad: off
```

```sh
uv run python -m fabric_agent.prompt .env.caller assistant "In one sentence: what is NATS?"
```

```
NATS is a lightweight, high-performance open-source messaging system that enables fast and reliable
communication between distributed applications and services.
2.5 s
```

The agent's own terminal shows the thread and the call: `[32635ceb] model call 1: 0 tool call(s), 122 in / 43 out tokens`.

**In the console.** The threads page has a second tree, status `ok`, one call, 122 tokens in and 43 out, and the agents page now lists the assistant. Open the tree: the prompt, the model call with what the model was sent and what it answered, the reply.

**Why the call is on the thread.** The fabric package's request interceptor gives every served prompt a thread id, and its `trace_headers()` returns it as two HTTP headers, `X-Synadia-Thread-ID` and `X-Synadia-Root-ID`. `fabric_agent/model.py` puts them on every model call. The proxy files the call under them and strips them before the provider sees the request. A call without them is recorded too, but on no thread.

## Step 3: a persona

Add one line to `.env`, restart the agent (Ctrl+C, then start it again), and ask again:

```sh
AGENT_SYSTEM_PROMPT=You are a careful librarian. Answer in one sentence, and say so when you are not sure.
```

A longer persona goes in a file: `AGENT_SYSTEM_PROMPT_FILE=./persona.md`. A role worth a page of instructions is this agent with a persona file.

## Step 4: memory

Nothing to configure. Prompt twice:

```sh
uv run python -m fabric_agent.prompt .env.caller assistant "My name is Ada. In one sentence: what is NATS?"
uv run python -m fabric_agent.prompt .env.caller assistant "What is my name?"
```

```
Your name is Ada, as you told me at the start of our conversation.
```

The agent keeps the last exchanges (`AGENT_MAX_HISTORY`, twenty by default) and sends them with every model call. In the console, the second tree's model call carries the first exchange in its input. The history is one list per process, in memory, shared by every caller: a simplification to keep the example small. A history per caller is the natural next step, and a restart forgets.

## Step 5: the agent tools, and the first child thread

Every reference agent gives its model the SDK's agent tools. Two are the core: `discover_agents`, the agents on the fabric, and `prompt_agent`, a prompt to one of them. The other four answer a question the prompted agent asks (`answer_agent`), and run several prompts at once (`wait_agent`, `cancel_agent`, `list_agent_calls`). That is what makes an agent a participant rather than an endpoint. To see it you need a second agent: the caller prompts the assistant, the assistant prompts the helper, and the console shows one tree of two.

`.env.helper`, the second agent, with a key of its own:

```sh
NATS_URL=nats://localhost:14422
NATS_CREDS=/path/to/helper.creds
AGENT_KIND=helper
AGENT_OWNER=me
AGENT_NAME=main
AGENT_DESCRIPTION=Does arithmetic and counting, exactly, and shows its working
AGENT_TOOLS=none
MODEL_PROXY_URL=http://localhost:18281/api
MODEL_NAME=anthropic/claude-sonnet-5
MODEL_VIRTUAL_KEY=sk_syn_…
```

The helper's key is issued like the assistant's, for the helper's own identity (before the key is there, `uv run python -m fabric_agent.echo .env.helper` prints it). The helper may as well be the TypeScript agent: the two speak the same protocol, and the tree is the same. The description is what another agent's model reads when it decides whom to ask, so say what the agent is for. The helper keeps `AGENT_TOOLS=none`: it answers and never delegates.

In the assistant's `.env`, delete the `AGENT_TOOLS=none` line and the persona line. Start both agents, each in a terminal:

```sh
uv run python -m fabric_agent .env.helper
uv run python -m fabric_agent
```

```sh
uv run python -m fabric_agent.prompt .env.caller assistant \
  "Find the agent that does arithmetic and ask it what 23 times 4 is. Tell me what it said."
```

```
The arithmetic agent (helper) replied: **23 × 4 = 92**.
11.4 s
```

The assistant's terminal shows its model deciding:

```
[647da987] model call 1: 1 tool call(s), 1031 in / 28 out tokens
[647da987]   discover_agents({})
[647da987] model call 2: 1 tool call(s), 1307 in / 93 out tokens
[647da987]   prompt_agent({"address": "agents.prompt.helper.me.main", "prompt": "What is 23 times 4?"})
[647da987] model call 3: 0 tool call(s), 1840 in / 28 out tokens
```

**In the console.** One tree, two threads. The assistant's thread has three model calls and two tool calls, each named: `discover_agents`, the agent's own tool, with the list of agents it got back behind "show result", and `prompt_agent`, with the address and the prompt it sent; the helper's thread hangs under that second tool call with one model call of its own. Every tool call the model made is a row: its name and arguments, and either the child it spawned or the result that came back.

**Why the child hangs under the parent.** Two lines in the agent arrange it. The fabric package's request interceptor runs the prompt handler inside a trace scope, a context variable that follows every `await`. The agent's own client, the one `prompt_agent` prompts through, is given the package's prompt interceptor: `Agents(…, interceptors=[tracing.prompt_interceptor])`. When `Agent.prompt()` sends, that interceptor reads the scope, makes a thread id for the child, and publishes an `edge` record that names the served thread as the parent. A client without it sends an untraced prompt, even from inside the handler: the SDK passes no tracing on by itself. `fabric_agent/tools.py` does one thing more: it runs each call with the model's own tool-call id, `tools.execute(name, args, tool_call_id=…)`, and the tools put the id in the prompt's context, `context={"tool_call_id": …}`, where the interceptor writes it on the edge, so the edge names the call.

**The tools are the SDK's.** `AgentTools` carries six, with the words the model reads and what each call does (the SDK's `docs/agent-tools.md`). The agent offers three of them unless told otherwise, `discover_agents`, `prompt_agent` and `answer_agent`, and every prompt waits for its reply (`AGENT_TOOLS=blocking`, the default; `all` offers the six). `fabric_agent/tools.py` shows them to the model: each definition wrapped as a chat-completions `function`, not a word changed, and the result of a call, a JSON object, handed back as the `tool` message. The agent gives its service the tools' request interceptor after tracing's, `[tracing.request_interceptor, tools.request_interceptor, references.request_interceptor]` in `fabric_agent/agent.py`, so the calls the model makes belong to the prompt being served: they end with it, and a question the helper asks comes back to the assistant's model, which answers it with `answer_agent`. The third interceptor is the fabric package's ScratchPad extension, `scratch_pad_extension`, which step 6 puts to work. Every definition is input tokens on every model call: the three cost about 935 tokens a call less than the six (`docs/findings.md` F18).

**Two guards.** `prompt_agent` refuses the agent's own address, and the agent that sent the prompt being served, when that sender signed: the two shortest loops. A role that must never delegate gets no tools at all. A small model with the tools in reach walks into both when it would rather ask back than answer. `reference-agents/README.md`, "The agent tools", has the rest.

## Step 6: ScratchPad, and the first handoff

Agents hand work over by reference, not by pasting it. ScratchPad is the fabric's store for that: an agent commits what it produced to a volume of its own and hands over a reference. The step is optional: it needs ScratchPad in your fabric. It needs no code either. The agent has had the two lines all along, both the fabric package's:

```python
scratchpad = await native_scratchpad_from_env(env, creator=address, nc=nc)
references = scratch_pad_extension(scratch_pad=scratchpad, agents=client) if scratchpad is not None else None
```

The first builds the native client on the agent's existing authenticated connection and gives nothing while `SCRATCHPAD_VOLUME` is unset. The second puts the fabric's rules for references on the agent tools. The client requires `SCRATCHPAD_DIR`: keep that directory private and across restarts, since it records the volume and the one operation still to finish. On Unix, the directory must have mode 0700. The client creates a new directory with that mode when needed. Do not share this workspace with `sp` or another writer. The native contract in the repository's `docs/scratchpad-native.md` explains explicit recovery and reset.

Ask your deployment operator to provision `AssistantReplies` for the assistant's account and user, and `HelperReplies` for the helper's; a volume name is letters and digits only. Add two lines to `.env`, and the same to `.env.helper` with `HelperReplies`:

```sh
SCRATCHPAD_VOLUME=AssistantReplies
SCRATCHPAD_DIR=/var/lib/my-agent/scratchpad
```

Use a separate private directory for each agent. `SCRATCHPAD_GRANT_TTL_S` defaults to 600 seconds (`env.example`).

Restart both agents. Each now says `scratchpad: <its volume>`. Prompt the assistant:

```sh
uv run python -m fabric_agent.prompt .env.caller assistant "Write four lines about the sea."
```

```
… four lines …

sp-ref:eyJyZWYiOnsidHlwZSI6…
reference: sp-ref:eyJyZWYiOnsidHlwZSI6…
```

The agent committed its reply, granted you read on it, and only then appended the reference. The reference is a few hundred characters; the last line repeats it for copying. It is data, not a key: holding it opens nothing. What opens the content is the grant, and ScratchPad checks the grant against the identity your connection logged in with.

Now hand it on. Paste the whole reference:

```sh
REF='sp-ref:…'
uv run python -m fabric_agent.prompt .env.caller assistant \
  "Ask the helper how many words the text at this reference has, and tell me its answer: $REF"
```

```
The helper agent said the text has **25 words**.
26.9 s
```

The helper's terminal shows the handoff arriving: `[e2abeb00] read sp-ref:eyJyZWYi… (135 chars)`.

**In the console.** Open the tree, or either agent's page for its timeline. In order:

1. On the assistant's thread, `read ok`: it read the reference you handed it, and put the content in front of its model. One read shows as four records, the resolve and three for the fetch.
2. Its model calls, then `grant ok` under the tool call: read for the helper, made immediately before the prompt went out.
3. On the helper's child thread, `read ok`, its model call, then `commit ok` and `grant ok` for its own reply.
4. Back on the assistant's thread, `commit ok` and `grant ok` for the reply to you.

**The rule behind it: least authority.** Nothing is granted when content is committed. A grant goes to one agent, on the one path the reference names, read only, for ten minutes (`SCRATCHPAD_GRANT_TTL_S`), and to an identity discovery verified, never to a name the model wrote. The package's `scratchpad_cli.py` makes the grant and says why at each step.

**Handing on what you were handed.** The assistant could grant here because the text was its own. When an agent hands on content another agent created, it cannot grant: in ScratchPad only a volume's owner grants, and being allowed to read is not being allowed to pass on. So the agent's code asks the creator's code, in one signed request, to grant the final recipient, and the creator's code decides by a fixed rule. The rule is conservative: only an agent the creator handed the reference itself may ask, and the agent granted at its request may read and may not ask for anyone else. No model sees the request. If the creator is gone or refuses, the reference comes out of the prompt and the text goes alone. The fabric package's ScratchPad extension does it inside `prompt_agent`, and its grant request is the exchange (`request_grant` and `grant_request_endpoint`); `reference-agents/README.md`, "The rules for references", has the rule.

## Where next

- **Your own agent:** copy `reference-agents/python/`. Keep the four behaviours; change the persona, the description and what the model loop does. `reference-agents/README.md`, "The agent tools", says how an agent wires the SDK's agent tools into its model loop.
- **The other language:** `typescript.md`. The two agents give their models the same tools in the same words and write the same reference token, so either one prompts, and hands work to, the other.
- **Harnesses:** Claude Code, OpenClaw and PI join the fabric through their plugins in the SDK repository's `agents/` and the fabric add-ons in the fabric package's `plugins/`.
- **Which model:** the model decides whether a chain of agents works. Sonnet 5 runs these steps right the first time. A small local model invents agents, replies and references, or changes a character of a reference it hands on (`docs/findings.md` F11).

**Stopping.** Ctrl+C in each agent's terminal. A virtual key lasts as long as the key manager set when it was issued; revoke it there when you are done.

## When it goes wrong

| What you see | Why, and what to do |
| --- | --- |
| `no agent "assistant" on the fabric; there: nobody` | the agent is not running, or the two `.env` files name different `NATS_URL`s or credentials of different accounts |
| `returning true from eof_received() has no effect when using ssl`, after a reply | harmless, and only on a TLS connection: it comes from `nats-py`'s asyncio transport closing a TLS socket, not from the agent or the SDK (`docs/findings.md` F15). The reply above it is the real output |
| the caller says `no reply: service error 500: handler error`, and the agent's terminal says `failed: …` | a model call failed, and that line has the proxy's answer. `401 Unauthorized unknown virtual key`: the key is mistyped, expired or revoked. `404 Not Found` with a page of HTML: `MODEL_PROXY_URL` lacks OpenRouter's `/api` |
| a reply comes without a reference | the agent's terminal says `could not hand the reply over by reference: …`. Usually `SCRATCHPAD_BIN` does not name an `sp`, ScratchPad is not reachable in your account, or the credentials are an nkey seed, which `sp` does not take |
| `prompt_agent` answers "not one you were given" | the model changed a character of the reference, or wrote one. The agent hands on only references it was given, exactly (`docs/findings.md` F11). A capable model does not do this |
| child threads hang under the wrong parent, or under none | the agent's `Agents` client lacks `interceptors=[tracing.prompt_interceptor]` |
