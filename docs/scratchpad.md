# ScratchPad: the extension and its port

**Version:** 0.1.0-alpha · **Date:** 2026-10-21 · **Status:** moved from the repository's README, unchanged in substance

The agent tools (`AgentTools`, the protocol SDK's `docs/agent-tools.md`)
let a model prompt other agents. On the fabric a prompt may hand content
over by reference: an `sp-r1:` token (or `sp-ref:` on an older service) that points into the sender's
ScratchPad volume and opens nothing until the volume's owner grants the
reader. The extension keeps the fabric's rules for that
(`agent-fabric` `docs/agent-tools.md` §2.2), on `AgentTools`' three hooks:

| Hook             | What it does                                                              | Field it adds                   |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------- |
| discovery fields | reads `scratchpad_refs_ok: "true"` from the agent's registration          | `reads_scratchpad_references`   |
| prompt rewrite   | checks each reference token and gets the target read on it before sending | `references_removed` and `note` |
| reply look       | remembers the references that arrive in a reply or a question             | none                            |

The prompt rewrite, for each reference in the prompt:

- **a token the agent was not given** refuses the prompt, in words. Given
  means: it committed it (`remember`, `grantCaller`), or it arrived in a
  prompt it served (`requestInterceptor`) or in a reply or question it
  received (the reply look);
- **a target that does not read references** gets the text without them;
- **its own content** is granted read, first-hand, to the target's
  verified identity, and a grant that fails refuses the prompt;
- **another agent's content** is asked of its creator with the grant
  request below; a refusal or no answer takes that reference out;
- a prompt that was nothing but removed references is refused. Every grant
  carries the served prompt's thread and root and the model's tool-call
  ID, so it shows under the tool call that caused it.

**The package holds the policy; the agent brings its ScratchPad, or takes
the package's.** The extension runs on the `ScratchPad` port:
`owns(reference)`, `grantRead(reference, grantee, trace, toolCallId?, kind?)`
and `granted(reference, grantee)`, each sync or async. The implementation
keeps the ledger of whom it granted what, and how: `first-hand` or
`on-request`. TypeScript agents can use `nativeScratchPad` on their existing
authenticated NATS connection, without a shell or `sp`. Its durable writer
requires Node 22.13+ and a persistent private directory. See the
[native client contract](scratchpad-native.md) for setup, recovery, and bounds.
The CLI adapters, `spCliScratchPad` / `SpCliScratchPad`, remain available;
both reference agents use their native client. Python native operations require Python 3.12+.
The extension itself runs on either implementation through the same port.

**The grant request.** An agent may read another agent's reference but not
pass it on: only the creator grants. So the requester sends the creator,
which the token names, a signed request on
`agents.sp-grant.<agent>.<owner>.<name>` (`requestGrant`), and the creator
answers it in code (`grantRequestEndpoint`): the signature verifies, the
reference is in its own volume, it granted the requester read on it
first-hand and that grant is live, and the requester asks for another
agent. Then it grants read on the one path, recorded as `on-request`, which
confers no right to ask again. Content travels at most one hop beyond the
agents its creator chose.

**Where it differs from the reference agents' own tools** (as they were at
`1e783a3`, in the examples repository, before this replaced them): a token repeated in one prompt is
granted or asked for once, and `references_removed` counts every occurrence
taken out; a reference whose creator is the target itself goes without a
grant request, since the creator reads its own volume; the references in a
question are remembered as well as those in a reply; the tool-call ID goes
into a grant or a request only when it is one the edge record would carry.

## Usage — TypeScript

```ts
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, AgentSubject, AgentTools } from "@synadia-ai/agents";
import {
  activeTrace,
  fabricTracing,
  grantRequestEndpoint,
  READS_REFERENCES_KEY,
  scratchPadExtension,
  nativeScratchPadFromEnv,
} from "@synadia-ai/agent-fabric";

const address = AgentSubject.new("triage", "acme", "main").prompt;
const tracing = fabricTracing();
const agents = new Agents({
  nc,
  identity: { signer },
  interceptors: [tracing.promptInterceptor],
});
const scratchPad = (await nativeScratchPadFromEnv(process.env, {
  creator: address,
  nc,
}))!;
const references = scratchPadExtension({ scratchPad, agents });
const tools = new AgentTools({
  agents,
  selfAddress: address,
  extensions: [references],
});
const svc = new AgentService({
  nc,
  agent: "triage",
  owner: "acme",
  name: "main",
  identity: { signer },
  interceptors: [
    tracing.requestInterceptor,
    tools.requestInterceptor,
    references.requestInterceptor,
  ],
  extraMetadata: { [READS_REFERENCES_KEY]: "true" },
  extraEndpoints: [
    grantRequestEndpoint({ promptAddress: address, scratchPad }),
  ],
});
svc.onPrompt(async (envelope, response) => {
  const answer = await runModel(envelope.prompt, tools); // tools.execute(name, args, { toolCallId })
  const ref = await scratchPad.commit(answer, "/replies/r.md", activeTrace());
  const handed = await references.grantCaller(ref, response.sender);
  await response.send(handed ? `${answer}\n\n${ref}` : answer);
});
```

## Usage — Python

```python
from synadia_ai.agents import Agents, AgentSubject, AgentTools, Identity
from synadia_ai.agent_service import AgentService, ServiceIdentity
from synadia_ai.agent_fabric import (READS_REFERENCES_KEY, fabric_tracing,
    grant_request_endpoint, scratch_pad_extension, native_scratchpad_from_env)

address = AgentSubject.new("triage", "acme", "main").prompt
tracing = fabric_tracing()
agents = Agents(nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor])
scratch_pad = await native_scratchpad_from_env(nc=nc, creator=address)  # or your own port
references = scratch_pad_extension(scratch_pad=scratch_pad, agents=agents)
tools = AgentTools(agents, self_address=address, extensions=[references])
svc = AgentService(nc=nc, agent="triage", owner="acme", session_name="main",
    identity=ServiceIdentity(signer=signer), max_concurrent_prompts=4,
    interceptors=[tracing.request_interceptor, tools.request_interceptor,
                  references.request_interceptor],
    extra_metadata={READS_REFERENCES_KEY: "true"},
    extra_endpoints=[grant_request_endpoint(prompt_address=address, scratch_pad=scratch_pad)])
async def handle(envelope, stream):
    answer = await run_model(envelope.prompt, tools)  # await tools.execute(name, args, tool_call_id=...)
    ref = await scratch_pad.commit(answer, "/replies/r.md", None)
    handed = await references.grant_caller(ref, stream.sender)
    await stream.send(f"{answer}\n\n{ref}" if handed else answer)
svc.on_prompt(handle)
await svc.start()
```

## Public API

The same surface in both languages (TypeScript names; Python in snake_case):

|                                                                                                                                                                          |                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scratchPadExtension({ scratchPad, agents, discoverTimeoutMs?, grantRequestTimeoutMs? })` → `ScratchPadExtension`                                                        | The extension for `AgentTools`' `extensions`: the three hooks, plus `remember(text)`, `requestInterceptor` (remembers the references in served prompts) and `grantCaller(reference, sender)` (the reply side: grants a verified sender read first-hand; `false` for any other)                             |
| `ScratchPad`, `Grantee`, `GrantKind`, `TraceIds`                                                                                                                         | The port the extension runs on, and its types                                                                                                                                                                                                                                                              |
| `nativeScratchPad({ nc, volume?, bootstrapFile?, dir, creator, ttlSeconds?, timeoutMs? })`                                                                               | Native TypeScript writer and Fabric port. Supply a volume or exact public bootstrap file. Node 22.13+.                                                                                                                                                                                                     |
| `scratchPadReader({ nc, timeoutMs? })`                                                                                                                                   | Native authenticated byte, text, and stream reads; no writer workspace.                                                                                                                                                                                                                                    |
| `nativeScratchPadFromEnv(env, { nc, creator })`                                                                                                                          | A volume or `SCRATCHPAD_BOOTSTRAP_FILE` enables the native writer; requires persistent `SCRATCHPAD_DIR`.                                                                                                                                                                                                   |
| `spCliScratchPad({ volume?, bootstrapFile?, nats, bin?, dir?, grantTtlS?, creator? })` → `ScratchPadClient`                                                              | The optional command-line adapter; a bootstrap import requires persistent `dir` and a compatible `sp`. Python: `SpCliScratchPad(...)`, with `bootstrap_file`.                                                                                                                                              |
| `scratchPadFromEnv(env?, { creator?, nats? })` → `ScratchPadClient \| undefined`                                                                                         | The same from `SCRATCHPAD_VOLUME` or `SCRATCHPAD_BOOTSTRAP_FILE`, plus `SCRATCHPAD_BIN`, `SCRATCHPAD_DIR`, `SCRATCHPAD_GRANT_TTL_S` and the agent's connection. Both selectors unset means off. Python: `scratchpad_from_env(...)`.                                                                        |
| `findReferences`, `removeReferences`, `referenceCreator`, `readsReferences`, `granteeFromIdentity`, `READS_REFERENCES_KEY`, `REFERENCE_PREFIX`, `SHORT_REFERENCE_PREFIX` | The references' vocabulary                                                                                                                                                                                                                                                                                 |
| `requestGrant(agents, creatorAddress, request, { timeoutMs? })`                                                                                                          | The requester's side; never throws, a refusal carries its reason                                                                                                                                                                                                                                           |
| `grantRequestEndpoint({ promptAddress, scratchPad, logger? })`                                                                                                           | The creator's side: an extra endpoint for the agent's `AgentService` (`extraEndpoints` / `extra_endpoints`)                                                                                                                                                                                                |
| `answerGrantRequest(requester, payload, scratchPad)`, `encodeGrantRequest`, `encodeGrantReply`, `grantSubject`, `GrantRequest`, `GrantReply`                             | The creator's rule for an already verified requester, and the wire shapes                                                                                                                                                                                                                                  |

## On the wire: the grant request

One signed NATS request, one JSON reply, the shapes of
`test-fixtures/schemas/sp-grant-{request,reply}.json` (vendored from
the fabric's design documents), the same bytes from both packages:
`{"reference":"sp-r1:…","grantee":"<account>.<user>","trace":{"thread_id":"…","root_id":"…","tool_call_id":"…"}}`,
`trace` only inside a served prompt and `tool_call_id` only when valid;
`{"granted":true}` or `{"granted":false,"reason":"…"}`, one reason per line
of the creator's rule. The `Agent-Sender` signature is over the grant
subject, verified by the SDK's `SenderGate`, which also refuses a replay.
The creator answers on its service's `sp-grant` endpoint, in the `agents`
queue group and listed in `$SRV.INFO` next to `prompt` and `status`; the
reply carries no headers.

## What the hooks do not carry

Measured against the reference agents' own tools (the examples repository at `1e783a3`):

- **The ScratchPad extension's own client.** A hook sees the target's
  handle but not the helper's client or the handles its discovery found,
  so the extension takes `agents` in its options and keeps its own map
  from the discovery hook; a creator it has not seen costs one discovery.
