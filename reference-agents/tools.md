# The agent tools

**Date:** 2026-09-27 · **Status:** the tools are the SDK's, and both agents use them as they are: `AgentTools` from `@synadia-ai/agents` and `synadia-ai-agents`, the six tools of the SDK's contract, with the fabric package's ScratchPad extension on them. The agents offer three by default: `discover_agents`, `prompt_agent` and `answer_agent` (`AGENT_TOOLS`, below). This page says where each thing lives and how an agent wires them.

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

## Where things are

| What | Where |
| --- | --- |
| The words the model reads, and the parameters | the SDK's `test-fixtures/agent-tools/<tool>.json`, embedded in both SDKs; an agent reads them as `tools.definitions` |
| What each tool hands back | the SDK's `test-fixtures/agent-tools/*.result.json` |
| The rules: states, the served prompt's scope, questions, guards, limits | the SDK's `docs/agent-tools.md` |
| What the fabric adds: the trace, the rules for references | the fabric package's README |
| The rules for references, in code; the grant request, both sides | the fabric package: `scratchPadExtension`, `requestGrant`, `grantRequestEndpoint` (`scratch_pad_extension`, `request_grant`, `grant_request_endpoint`) |
| The grant request's two shapes | the fabric package's `test-fixtures/schemas/sp-grant-request.json` and `sp-grant-reply.json` |
| The ScratchPad the rules run on | the fabric package: `scratchPadFromEnv` (`scratchpad_from_env`) builds it from `SCRATCHPAD_VOLUME` and the rest, over the `sp` command line; `spCliScratchPad` (`SpCliScratchPad`) the same from code. The agents write none of it |
| The model loop's side | this repo: `agents/ts/src/tools.ts`, `agents/py/fabric_agent/tools.py` |

The tests of both agents check the definitions word for word against what the SDK's files derive for the tools offered (the three without their `wait` parameter and with `blocking.json`'s words; the six as they are), the results against the SDK's result schemas, and the grant request against the fabric package's two schemas.

## How an agent wires them

`agents/ts/src/agent.ts` and `agents/py/fabric_agent/agent.py` do this, each step commented where it happens.

1. **One client**, on the agent's own connection and signed as the agent, with the fabric package's prompt interceptor. Every prompt the tools send and every grant request goes over it.
2. **The extension**, `scratchPadExtension({ scratchPad, agents: client })`, over the ScratchPad `scratchPadFromEnv(process.env, { creator: address, nats })` built. Both are the package's: the agent configures the ScratchPad, the package drives it and holds the rules.
3. **The tools**, `new AgentTools({ agents: client, tools: ["discover_agents", "prompt_agent", "answer_agent"], selfAddress, maxWaitMs, extensions: [ext] })`. `tools` is what the model is offered (`AGENT_TOOLS`, below; left out for `all`, which is the SDK's six). `selfAddress` keeps the agent out of its own discovery and refuses a prompt to itself. `maxWaitMs` is how long one prompt to another agent may run (`AGENT_REPLY_TIMEOUT_MS`). No attachment roots are named: the SDK's default is its staging directory alone, which holds only the files other agents sent back, so a file of the agent's own, such as its `.env` with the virtual key, cannot be attached. These agents hand content over through ScratchPad.
4. **The service**, with its request interceptors in this order: `[tracing.requestInterceptor, tools.requestInterceptor, ext.requestInterceptor]`. Tracing binds the served prompt's thread, so all that runs inside it is on that thread. The tools open the prompt's scope, so the calls the model makes belong to this prompt and end with it, and they learn the verified sender for the loop guard. The extension notes the references the prompt hands over, so the model may hand them on. The service registers `scratchpad_refs_ok: "true"` (`extraMetadata`) and takes grant requests at `agents.sp-grant.<agent>.<owner>.<name>` (`extraEndpoints: [grantRequestEndpoint(…)]`), in both languages.
5. **The model loop.** The definitions go into the request's `tools` array, each wrapped as `{"type": "function", "function": {name, description, parameters}}`, not a word changed. Each tool call the model makes runs as `tools.execute(name, args, { toolCallId })` (`tool_call_id=` in Python) with the model's own tool-call ID; the result, as JSON text, is the `tool` message's content. `prompt_agent` puts the ID in the prompt's context, where the fabric's tracing writes it on the `edge`, so the child thread hangs under the tool call that spawned it.
6. **The reply.** The agent commits its reply to ScratchPad and asks `ext.grantCaller(reference, sender)`. That grants the served prompt's sender read, only a sender whose signature verified, and notes the reference as given. The reference goes into the reply only when it returns true.

A Python agent also sets `max_concurrent_prompts`: the Python host serves one prompt at a time unless told otherwise, and an agent waiting on its own call would then take no prompt back. The agents here serve four at once.

**Which tools** (`AGENT_TOOLS`, the same in both languages). `blocking`, the default, offers `discover_agents`, `prompt_agent` and `answer_agent`: every prompt waits for its reply, and a question the prompted agent asks comes back to the model. Without `wait_agent` nothing can be detached, so the SDK shows `prompt_agent` and `answer_agent` without their `wait` parameter, in words that name no tool it does not offer. That is all a model that delegates one step at a time needs, and every definition is input tokens on every model call: the three cost an agent that delegates about 935 tokens a call less than the six (`docs/findings.md` F18). `all` offers the six, for a model that runs prompts side by side. `none` offers nothing, for a role that must never delegate, such as a researcher or a writer another agent calls; the agent keeps the capability, its model is not shown it.

## What the model sees

Every result is a JSON object. A call's result carries `call_id` and `state` (`running`, `input_required`, `completed`, `failed`, `cancelled`, `expired`) and what the state carries: `reply`, `question`, `error`. A refusal is `{"error": "…"}` alone: nothing was sent. While calls the model started are open, every result says how many (`open_calls`, `open_calls_note`). A question the prompted agent asks reaches the model, which answers it with `answer_agent`; nothing answers on its behalf. The extension adds `reads_scratchpad_references` to each discovery entry, and `references_removed` and `note` to a call whose prompt lost references on the way.

## The rules for references

The rules are the fabric package's code; they are stated here once.

**Least authority.** A reference opens nothing until its creator grants the reader. A grant goes to one agent, on the one path the reference names, read only, with an expiry (ten minutes by default, `SCRATCHPAD_GRANT_TTL_S`), immediately before the reference is sent, and only to an identity discovery verified. Nothing is granted when content is committed, and never to every agent discovered.

**Who reads references says so** (`docs/findings.md` F11). An agent that reads the references it is handed registers `scratchpad_refs_ok: "true"`; discovery shows it as `reads_scratchpad_references`. A reference goes only to such an agent. For any other, the harnesses among them, the references are taken out of the prompt, the rest is sent, nothing is asked or granted, and the result says how many were removed. A prompt that was nothing but references is not sent.

**Only a reference the agent was given.** It committed it, or it arrived in a prompt it served or in a reply or question it received. Any other token, one a model wrote itself or copied with a character wrong (F11), is refused before anything is read, asked or granted, with words that say to copy the reference exactly.

**Its own content: the agent grants.** A grant that fails means the prompt is not sent, and the model is told.

**Content another agent created: the creator grants, asked in code** (`docs/findings.md` F13). In ScratchPad only a volume's owner grants, and being allowed to read is not being allowed to pass on; ScratchPad's first version leaves delegation out on purpose. So the agent sends the creator, whose prompt address the token names (`creator`), one signed request on `agents.sp-grant.<agent>.<owner>.<name>`: this reference, for this grantee. The subject is derived by the requester, never taken from the token or from metadata, and the request goes only to an address discovery shows with a verified identity. No model sees the request or decides the answer. The creator's rule: the signature verifies, a replay is refused; the reference points into its own volume; it granted the requester read on that reference **first-hand** and that grant is live; the requester asks for another agent, not for itself. Then it grants read on the one path, recorded as made on request. A refusal or no answer takes that reference out of the prompt, and the rest is sent.

**First-hand, and on request** (F13 item 9). A grant is first-hand when the creator handed the reference itself: to the verified caller of its reply, or to the agent it prompted with a reference of its own. A grant made because another agent asked is on request. Only a first-hand grant entitles its holder to ask; a grant made on request lets its holder read and confers no right to ask for anyone. So content travels at most one hop beyond the agents its creator chose. The creator's ledger, in the agent's ScratchPad wrapper, keeps the two kinds apart, because ScratchPad knows the grants and not how they came about.

**Limits.** The ledger and the set of given references are per process and in memory. After a restart, or in another instance behind the same address, the answer is a refusal and the text goes without the reference, which is the safe failure. A stopgap until ScratchPad has delegation of its own; then the grant request goes.

## The guards

`prompt_agent` refuses the agent's own address, and the agent that sent the prompt being served: the two shortest loops, which a small model with the tools in reach walks into when it would rather ask back than answer. The SDK compares the served prompt's verified sender with the identity the target registered, so the second guard holds for a signed caller only; sign every caller. Both refusals come back in words. A loop through three or more agents is not caught: a depth or hop limit per tree is the next guard.

Nothing the model gets wrong throws: an unknown tool, bad arguments, an unknown address, a refused prompt, a stalled stream all come back as results in words, so the model reads what happened and decides.

## Why the tools are the SDK's

Every agent runs its model loop differently, so the tools began as reference code an agent copies and adapts. They proved general, and became the SDK's contract: async calls and three more tools, one helper in both SDKs, with hooks for extensions, the fabric's ScratchPad rules among them. What stays an agent's own is the model loop's side: how the definitions reach its model, and how a call runs. That is `tools.ts` and `tools.py`, a page each.
