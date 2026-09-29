# Getting started: a TypeScript agent on the fabric

The model and console examples come from the 2026-09-26 walkthrough. Step 6 describes the native TypeScript ScratchPad client and its persistent workspace. The [native client contract](../../../docs/scratchpad-native.md) defines that interface; [SDK issue #19](https://github.com/synadia-ai/agent-fabric-sdk/issues/19) holds delivery and validation status. The Python walkthrough uses the CLI adapter.

You will put one agent on the fabric and grow it in six steps. Each step adds one thing, and after each you look at what the console shows and why.

| Step | The agent | What you see for the first time |
| --- | --- | --- |
| 1 | answers every prompt with the prompt | the agent on the fabric, under a signed identity |
| 2 | asks a model, through the proxy | a thread with a model call and its tokens |
| 3 | has a persona | the same, in character |
| 4 | remembers the conversation | an answer that needs the earlier prompt |
| 5 | can discover and prompt other agents | a child thread under a tool call |
| 6 | hands work over through ScratchPad | a commit, a grant and a read on the timeline |

The agent is `reference-agents/typescript/` in this repository. It is the reference agent: what you copy and change. Steps 2 to 6 are one program, `src/agent.ts`, with more of its configuration switched on each time. Read it next to this page. Its four behaviours are marked `(1)` to `(4)` where they happen.

## Before you start

**The tools.** Node 22.13 or later and npm; `nats-server` on PATH for the tests; until the packages are published, `bun`, with which `make setup` builds the SDK's TypeScript packages. Step 6 uses the native NATS client and needs no `sp` binary.

**The packages.** The SDK speaks the agent protocol and nothing more: `@synadia-ai/agents` and `@synadia-ai/agent-service`, `synadia-ai-agents` and `synadia-ai-agent-service` in Python. What makes a prompt a thread in the console, tracing, is the fabric's own package, `@synadia-ai/agent-fabric` (`synadia-ai-agent-fabric` in Python). So are the fabric's rules for handing content over by ScratchPad reference, an extension of the SDK's agent tools (step 6). Until they are published, the SDK comes from its checkout next to this repository, and the fabric package is this repository's own (`../typescript`, `../python`). `make setup` in `reference-agents/` checks that the SDK's checkout is there and on the right branch, builds the TypeScript packages, and installs both agents. The fabric package is a package of its own because the SDK carries no tracing.

**Install and test the agent:**

```sh
make setup        # in reference-agents/: the packages, then both agents
cd typescript
npm test          # agent tests; nats-server must be on PATH
```

Use npm, not bun, in `reference-agents/typescript`: bun 1.4.0 cannot install this manifest (`docs/findings.md` F2). npm installs the three packages as links into their directories, so a rebuild there is what the agent runs next.

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

Two small files in `reference-agents/typescript/`. Both are gitignored, as every `.env` file here is.

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
npm run echo
```

```
echo agent listening on agents.prompt.echo.me.main
identity: ABQIEOAE…H4VFW.UCW6PNH4…672PP
```

```sh
node --env-file=.env.caller --import tsx src/prompt.ts echo "hello, fabric"
```

```
→ agents.prompt.echo.me.main (ABQIEOAE…H4VFW.UCW6PNH4…672PP, verified)
echo: hello, fabric
```

**What happened.** `src/echo.ts` is short, and three things in it matter:

- `resolveNatsConnectionBundle` reads the credentials file once and gives back both the connection options and a signer. So the identity the agent registers is the identity its connection logged in with.
- `new AgentService({ …, identity: { signer } })` puts the agent on the fabric at `agents.prompt.<kind>.<owner>.<name>`. With the signer, its registration is signed: the caller's `verified` is that signature checked. The signer also signs every heartbeat the agent sends, which is what the fabric reads as *online*: an agent proves it is up with its own key, and the fabric only listens.
- `fabricTracing()` from `@synadia-ai/agent-fabric` turns tracing on, one line in the service's options: `interceptors: [tracing.requestInterceptor], heartbeatExtras: tracing.heartbeatExtras`. The request interceptor takes the thread a tracing caller sent, or starts one, and runs the handler inside it: a prompt is a thread. The heartbeat extras report how many trace records the process published. The SDK knows nothing of the fabric; the package plugs into its hooks.
- `service.onPrompt(…)` is the whole agent.

`src/prompt.ts` is the other side: it discovers the agents on the fabric, finds `echo`, and prompts it, signed as `caller`.

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
npm start
```

```
assistant agent listening on agents.prompt.assistant.me.main
model: anthropic/claude-sonnet-5 through http://localhost:18281/api
scratchpad: off
```

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant "In one sentence: what is NATS?"
```

```
NATS is a lightweight, high-performance open-source messaging system that enables fast, secure
communication between distributed applications and services.
2.8 s
```

The agent's own terminal shows the thread and the call: `[9332f804] model call 1: 0 tool call(s), 122 in / 42 out tokens`.

**In the console.** The threads page has a second tree, status `ok`, one call, 122 tokens in and 42 out, and the agents page now lists the assistant. Open the tree: the prompt, the model call with what the model was sent and what it answered, the reply.

**Why the call is on the thread.** The fabric package's request interceptor gives every served prompt a thread id, and its `traceHeaders()` returns it as two HTTP headers, `X-Synadia-Thread-ID` and `X-Synadia-Root-ID`. `src/model.ts` puts them on every model call. The proxy files the call under them and strips them before the provider sees the request. A call without them is recorded too, but on no thread.

## Step 3: a persona

Add one line to `.env`, restart the agent (Ctrl+C, `npm start`), and ask again:

```sh
AGENT_SYSTEM_PROMPT=You are a careful librarian. Answer in one sentence, and say so when you are not sure.
```

A longer persona goes in a file: `AGENT_SYSTEM_PROMPT_FILE=./persona.md`. A role worth a page of instructions is this agent with a persona file.

## Step 4: memory

Nothing to configure. Prompt twice:

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant "My name is Ada. In one sentence: what is NATS?"
node --env-file=.env.caller --import tsx src/prompt.ts assistant "What is my name?"
```

```
Your name is Ada, as you told me at the start of our conversation.
```

The agent keeps the last exchanges (`AGENT_MAX_HISTORY`, twenty by default) and sends them with every model call. In the console, the second tree's model call carries the first exchange in its input. The history is kept per caller, keyed by the caller's verified agent ID, so `prompt` signs its prompts; an unsigned caller gets no history. It is in memory, so a restart forgets. `AGENT_MAX_HISTORY=0` turns it off.

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

The helper's key is issued like the assistant's, for the helper's own identity (before the key is there, `node --env-file=.env.helper --import tsx src/echo.ts` prints it). The helper may as well be the Python agent: the two speak the same protocol, and the tree is the same. The description is what another agent's model reads when it decides whom to ask, so say what the agent is for. The helper keeps `AGENT_TOOLS=none`: it answers and never delegates.

In the assistant's `.env`, delete the `AGENT_TOOLS=none` line and the persona line. Start both agents, each in a terminal:

```sh
node --env-file=.env.helper --import tsx src/main.ts
npm start
```

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant \
  "Find the agent that does arithmetic and ask it what 23 times 4 is. Tell me what it said."
```

```
The arithmetic agent (helper) said: 23 times 4 is 92.
8.6 s
```

The assistant's terminal shows its model deciding:

```
[ea9778ec] model call 1: 1 tool call(s), 1031 in / 28 out tokens
[ea9778ec]   discover_agents({})
[ea9778ec] model call 2: 1 tool call(s), 1297 in / 93 out tokens
[ea9778ec]   prompt_agent({"address": "agents.prompt.helper.me.main", "prompt": "What is 23 times 4?"})
[ea9778ec] model call 3: 0 tool call(s), 1412 in / 27 out tokens
```

**In the console.** One tree, two threads. The assistant's thread has three model calls and two tool calls, each named: `discover_agents`, the agent's own tool, with the list of agents it got back behind "show result", and `prompt_agent`, with the address and the prompt it sent; the helper's thread hangs under that second tool call with one model call of its own. Every tool call the model made is a row: its name and arguments, and either the child it spawned or the result that came back.

**Why the child hangs under the parent.** Two lines in the agent arrange it. The fabric package's request interceptor runs the prompt handler inside a trace scope that follows every `await`. The agent's own client, the one `prompt_agent` prompts through, is given the package's prompt interceptor: `new Agents({ …, interceptors: [tracing.promptInterceptor] })`. When `Agent.prompt()` sends, that interceptor reads the scope, makes a thread id for the child, and publishes an `edge` record that names the served thread as the parent. A client without it sends an untraced prompt, even from inside the handler: the SDK passes no tracing on by itself. `src/tools.ts` does one thing more: it runs each call with the model's own tool-call id, `tools.execute(name, args, { toolCallId })`, and the tools put the id in the prompt's context, `context: { toolCallId }`, where the interceptor writes it on the edge, so the edge names the call.

**The tools are the SDK's.** `AgentTools` carries six, with the words the model reads and what each call does (the SDK's `docs/agent-tools.md`). The agent offers three of them unless told otherwise, `discover_agents`, `prompt_agent` and `answer_agent`, and every prompt waits for its reply (`AGENT_TOOLS=blocking`, the default; `all` offers the six). `src/tools.ts` shows them to the model: each definition wrapped as a chat-completions `function`, not a word changed, and the result of a call, a JSON object, handed back as the `tool` message. The agent gives its service the tools' request interceptor after tracing's, `[tracing.requestInterceptor, tools.requestInterceptor, references.requestInterceptor]` in `src/agent.ts`, so the calls the model makes belong to the prompt being served: they end with it, and a question the helper asks comes back to the assistant's model, which answers it with `answer_agent`. The third interceptor is the fabric package's ScratchPad extension, `scratchPadExtension`, which step 6 puts to work. Every definition is input tokens on every model call: the three cost about 935 tokens a call less than the six (`docs/findings.md` F18).

**Two guards.** `prompt_agent` refuses the agent's own address, and the agent that sent the prompt being served, when that sender signed: the two shortest loops. A role that must never delegate gets no tools at all. A small model with the tools in reach walks into both when it would rather ask back than answer. `reference-agents/README.md`, "The agent tools", has the rest.

## Step 6: ScratchPad, and the first handoff

Agents hand work over by reference, not by pasting it. ScratchPad is the fabric's store for that: an agent commits what it produced to a volume of its own and hands over a reference. The step is optional: it needs ScratchPad in your fabric. It needs no code either. The agent has had the two lines all along, both the fabric package's:

```ts
const scratchpad = await nativeScratchPadFromEnv(process.env, { nc, creator: address });
const references = scratchpad !== undefined ? scratchPadExtension({ scratchPad: scratchpad, agents: client }) : undefined;
```

The first creates a native client from the environment and returns no client while `SCRATCHPAD_VOLUME` is unset. It borrows `nc`, the agent's existing authenticated NATS connection, without changing its identity or closing it. The second applies the fabric's reference rules to the agent tools. The native writer requires Node 22.13 or later and a private, persistent `SCRATCHPAD_DIR`; it stores its journal, pending artifact, and grant ledger there.

Ask your deployment operator to provision `AssistantReplies` for the assistant's account and user, and `HelperReplies` for the helper's; a volume name is letters and digits only. Add two lines to `.env`. For a TypeScript helper, set `HelperReplies` and a separate persistent directory in `.env.helper`:

```sh
SCRATCHPAD_VOLUME=AssistantReplies
SCRATCHPAD_DIR=/var/lib/assistant/scratchpad
```

The directory must be writable by this agent and survive restarts. There is no temporary-directory default. `SCRATCHPAD_GRANT_TTL_S` defaults to 600 seconds. A Python helper still uses the CLI adapter; follow its `env.example` for `sp` and workspace settings.

A native client cannot automatically adopt a CLI workspace or an existing writer whose journal is missing. Recover pending work with its original client and journal. If you deliberately abandon that recovery promise, stop the old writer and call `resetWriter({ target, expectedGeneration })` with the exact volume incarnation and observed writer generation. See [persistence and recovery](../../../docs/scratchpad-native.md#persistence-and-recovery) for inspection and reset behavior.

Restart both agents. Each now says `scratchpad: <its volume>`. Prompt the assistant:

```sh
node --env-file=.env.caller --import tsx src/prompt.ts assistant "Write four lines about the sea."
```

```
… four lines …

sp-ref:eyJ2ZXJzaW9uIjoy…
reference: sp-ref:eyJ2ZXJzaW9uIjoy…
```

The agent committed its reply, granted you read on it, and only then appended the reference. The reference is a few hundred characters; the last line repeats it for copying. It is data, not a key: holding it opens nothing. What opens the content is the grant, and ScratchPad checks the grant against the identity your connection logged in with.

Now hand it on. Paste the whole reference:

```sh
REF='sp-ref:…'
node --env-file=.env.caller --import tsx src/prompt.ts assistant \
  "Ask the helper how many words the text at this reference has, and tell me its answer: $REF"
```

```
The helper counted the text and reports it contains **30 words**.
26.6 s
```

The helper's terminal shows the reference read and the number of characters received.

**In the console.** Open the tree, or either agent's page for its timeline. In order:

1. On the assistant's thread, read records: it read the reference you handed it and put the content in front of its model. A native read requests file metadata and bounded content ranges.
2. Its model calls, then `grant ok` under the tool call: read for the helper, made immediately before the prompt went out.
3. On the helper's child thread, `read ok`, its model call, then `commit ok` and `grant ok` for its own reply.
4. Back on the assistant's thread, `commit ok` and `grant ok` for the reply to you.

**The rule behind it: least authority.** Nothing is granted when content is committed. A grant goes to one agent, on the one path the reference names, read only, for ten minutes (`SCRATCHPAD_GRANT_TTL_S`), and to an identity discovery verified, never to a name the model wrote. The fabric extension selects the recipient; the native client sends the grant over NATS.

**Handing on what you were handed.** The assistant could grant here because the text was its own. When an agent hands on content another agent created, it cannot grant: in ScratchPad only a volume's owner grants, and being allowed to read is not being allowed to pass on. So the agent's code asks the creator's code, in one signed request, to grant the final recipient, and the creator's code decides by a fixed rule. The rule is conservative: only an agent the creator handed the reference itself may ask, and the agent granted at its request may read and may not ask for anyone else. No model sees the request. If the creator is gone or refuses, the reference comes out of the prompt and the text goes alone. The fabric package's ScratchPad extension does it inside `prompt_agent`, and its grant request is the exchange (`requestGrant` and `grantRequestEndpoint`); `reference-agents/README.md`, "The rules for references", has the rule.

The native grant ledger survives restart in the workspace. The fabric extension's remembered references remain process-local: it must receive a reference again before its tools can hand it on after a restart.

## Where next

- **Your own agent:** copy `reference-agents/typescript/`. Keep the four behaviours; change the persona, the description and what the model loop does. `reference-agents/README.md`, "The agent tools", says how an agent wires the SDK's agent tools into its model loop.
- **The other language:** `python.md`. The two agents give their models the same tools in the same words and write the same reference token, so either one prompts, and hands work to, the other.
- **Harnesses:** Claude Code, OpenClaw and PI join the fabric through their plugins in the SDK repository's `agents/` and the fabric add-ons in the fabric package's `plugins/`.
- **Which model:** the model decides whether a chain of agents works. Sonnet 5 runs these steps right the first time. A small local model invents agents, replies and references, or changes a character of a reference it hands on (`docs/findings.md` F11).

**Stopping.** Ctrl+C in each agent's terminal. A virtual key lasts as long as the key manager set when it was issued; revoke it there when you are done.

## When it goes wrong

| What you see | Why, and what to do |
| --- | --- |
| `no agent "assistant" on the fabric; there: nobody` | the agent is not running, or the two `.env` files name different `NATS_URL`s or credentials of different accounts |
| the caller says `no reply: service error 500: handler error`, and the agent's terminal says `failed: …` | a model call failed, and that line has the proxy's answer. `401 Unauthorized unknown virtual key`: the key is mistyped, expired or revoked. `404 Not Found` with a page of HTML: `MODEL_PROXY_URL` lacks OpenRouter's `/api` |
| startup reports that `SCRATCHPAD_DIR` is required | set a private persistent directory when `SCRATCHPAD_VOLUME` is enabled |
| a reply comes without a reference | read the agent's `could not hand the reply over by reference: …` message. Check the account's ScratchPad import, provisioned scope, retention capacity, and the caller's verified identity. An unknown mutation requires journal recovery before another mutation |
| the native writer reports `exists` or a missing journal for an established writer | it will not adopt a CLI workspace or reset another writer automatically. Use the original journal for recovery, or inspect the exact target and generation before an explicit reset; see the native client contract |
| `prompt_agent` answers "not one you were given" | the model changed a character of the reference, or wrote one. The agent hands on only references it was given, exactly (`docs/findings.md` F11). A capable model does not do this |
| child threads hang under the wrong parent, or under none | the agent's `Agents` client lacks `interceptors: [tracing.promptInterceptor]`, or the fabric package is not built. The trace scope is on `globalThis`, so two copies of a package do not cause this (`docs/findings.md` F1) |
