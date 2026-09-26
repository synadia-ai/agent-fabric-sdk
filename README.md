# agent-fabric-sdk

The SDK for agents on the **Synadia Agent Fabric**, in TypeScript
(`@synadia-ai/agent-fabric`) and Python (`synadia-ai-agent-fabric`, import
`synadia_ai.agent_fabric`).

It carries **tracing**: the signed `edge` record before every prompt, the
`thread_id` / `root_id` pair in the envelope, the `X-Synadia-Thread-ID` /
`X-Synadia-Root-ID` headers for model calls, and the record counts on the
heartbeat; and, for the harness add-ons, the signed `served` record that
binds a served thread to the harness's own thread id, with its publisher.
And the agent tools' **ScratchPad extension**: the fabric's rules
for handing content over by reference, on the protocol SDK's `AgentTools`;
and **ScratchPad by configuration**: a ready implementation of the
extension's port, with the agent's commit and read, over ScratchPad's `sp`
command line, built from four `SCRATCHPAD_*` variables.
Later it takes the proxy helpers.

Under [`plugins/`](plugins/) sit the fabric **add-ons** for the harness
plugins, one small package per harness, `plugins/pi` first. Each is an
extension module the public plugin in `synadia-agents` loads by name and
hands the SDK's hooks and the harness's events; the add-on wires this
package's tracing in and adds the harness piece, for PI the fabric's headers
on its own model calls and the `409` loop guard. The plugins themselves stay
in the public repo and are never copied here ([`docs/plugins.md`](docs/plugins.md)).

## Reference agents

[`reference-agents/`](reference-agents/) holds the worked example of this
package: two agents, TypeScript and Python, that take prompts under a signed
identity, call their model through the fabric's model proxy with the trace
headers, discover and prompt other agents through the SDK's agent tools with
the ScratchPad extension, and hand work over by ScratchPad reference, built
from the environment. Copy one and adapt it. Their README says where each of
the four behaviours is in the code, how to install them (`make setup`), and
how to run them; `reference-agents/docs/getting-started/` grows one in six
steps.

## Built on the protocol SDK

This package is an extension of the Synadia Agent Protocol SDK
([`synadia-agents`](https://github.com/synadia-ai/synadia-agents)):
`@synadia-ai/agents` and `@synadia-ai/agent-service` in TypeScript,
`synadia-ai-agents` and `synadia-ai-agent-service` in Python. It plugs into
the SDK's public hooks — prompt interceptors on the client, request
interceptors, heartbeat extras and extra endpoints on the host, the
envelope's §5.6 extras, signed publishing with a caller-chosen nonce,
`AgentTools`' extension hooks, `SenderGate` — and nothing else. The SDK
knows nothing of the fabric; the dependency goes one way.

Until the SDK with the hooks is published, both packages resolve it from a
local checkout of the `sdk-release-rollout` branch (see [CLAUDE.md](CLAUDE.md)).

## Usage — TypeScript

```ts
import { Agents } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";
import { fabricTracing, traceHeaders } from "@synadia-ai/agent-fabric";

const tracing = fabricTracing(); // edges to TRACE.edges; { edgeSubject: null } only propagates
const agents = new Agents({ nc, identity: { signer }, interceptors: [tracing.promptInterceptor] });
const svc = new AgentService({ nc, agent: "triage", owner: "acme", name: "main",
  interceptors: [tracing.requestInterceptor], heartbeatExtras: tracing.heartbeatExtras });
svc.onPrompt(async (envelope, response) => {
  const answer = await callModel(envelope.prompt, { headers: traceHeaders() });
  const [lookup] = await agents.discover({ filter: { agent: "lookup" } }); // a child thread:
  for await (const m of await lookup!.prompt(answer, { context: { toolCallId: "toolu_01" } }))
    if (m.type === "response") await response.send(m.text);
});
```

## Usage — Python

```python
from synadia_ai.agents import Agents, DiscoverFilter, Identity, ResponseChunk
from synadia_ai.agent_service import AgentService
from synadia_ai.agent_fabric import fabric_tracing, trace_headers

tracing = fabric_tracing()  # edges to TRACE.edges; TraceOptions(edge_subject=None) only propagates
agents = Agents(nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor])
svc = AgentService(nc=nc, agent="triage", owner="acme", session_name="main",
    interceptors=[tracing.request_interceptor], heartbeat_extras=tracing.heartbeat_extras)
async def handle(envelope, stream):
    answer = await call_model(envelope.prompt, headers=trace_headers())
    [lookup] = await agents.discover(filter=DiscoverFilter(agent="lookup"))  # a child thread:
    async for m in lookup.prompt(answer, context={"tool_call_id": "toolu_01"}):
        if isinstance(m, ResponseChunk): await stream.send(m.text)
svc.on_prompt(handle)
```

A client traces only when it is given the prompt interceptor — give it to
every `Agents` a handler prompts other agents with. The tool-call ID
travels in the prompt's `context`: `toolCallId` in TypeScript,
`tool_call_id` in Python.

## The ScratchPad extension

The agent tools (`AgentTools`, the protocol SDK's `docs/agent-tools.md`)
let a model prompt other agents. On the fabric a prompt may hand content
over by reference: an `sp-ref:` token that points into the sender's
ScratchPad volume and opens nothing until the volume's owner grants the
reader. The extension keeps the fabric's rules for that
(`agent-fabric` `docs/agent-tools.md` §2.2), on `AgentTools`' three hooks:

| Hook | What it does | Field it adds |
| --- | --- | --- |
| discovery fields | reads `scratchpad_refs_ok: "true"` from the agent's registration | `reads_scratchpad_references` |
| prompt rewrite | checks each `sp-ref:` token and gets the target read on it before sending | `references_removed` and `note` |
| reply look | remembers the references that arrive in a reply or a question | none |

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
`on-request`. There is no ScratchPad client for TypeScript or Python yet, so
the package's own implementation, `spCliScratchPad` / `SpCliScratchPad`,
drives ScratchPad's command line `sp`, which must be on the machine; built
from the environment with `scratchPadFromEnv()` / `scratchpad_from_env()`,
it needs no ScratchPad code in the agent (the packages' READMEs, "ScratchPad
without writing ScratchPad code"). The extension itself never talks to
ScratchPad.

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

### TypeScript

```ts
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, AgentSubject, AgentTools } from "@synadia-ai/agents";
import { activeTrace, fabricTracing, grantRequestEndpoint, READS_REFERENCES_KEY, scratchPadExtension,
  scratchPadFromEnv } from "@synadia-ai/agent-fabric";

const address = AgentSubject.new("triage", "acme", "main").prompt;
const tracing = fabricTracing();
const agents = new Agents({ nc, identity: { signer }, interceptors: [tracing.promptInterceptor] });
const scratchPad = scratchPadFromEnv(process.env, { creator: address })!; // or your own port
const references = scratchPadExtension({ scratchPad, agents });
const tools = new AgentTools({ agents, selfAddress: address, extensions: [references] });
const svc = new AgentService({ nc, agent: "triage", owner: "acme", name: "main", identity: { signer },
  interceptors: [tracing.requestInterceptor, tools.requestInterceptor, references.requestInterceptor],
  extraMetadata: { [READS_REFERENCES_KEY]: "true" },
  extraEndpoints: [grantRequestEndpoint({ promptAddress: address, scratchPad })] });
svc.onPrompt(async (envelope, response) => {
  const answer = await runModel(envelope.prompt, tools); // tools.execute(name, args, { toolCallId })
  const ref = await scratchPad.commit(answer, "/replies/r.md", activeTrace());
  const handed = await references.grantCaller(ref, response.sender);
  await response.send(handed ? `${answer}\n\n${ref}` : answer);
});
```

### Python

```python
from synadia_ai.agents import Agents, AgentSubject, AgentTools, Identity
from synadia_ai.agent_service import AgentService, ServiceIdentity
from synadia_ai.agent_fabric import (READS_REFERENCES_KEY, fabric_tracing,
    grant_request_endpoint, scratch_pad_extension, scratchpad_from_env)

address = AgentSubject.new("triage", "acme", "main").prompt
tracing = fabric_tracing()
agents = Agents(nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor])
scratch_pad = scratchpad_from_env(creator=address)  # or your own port
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

| | |
| --- | --- |
| `fabricTracing(options?)` → `{ promptInterceptor, requestInterceptor, heartbeatExtras }` | The three hooks the SDK takes. `options.edgeSubject`: default `"TRACE.edges"`, `null` for propagate-only; a subject that can never be published to throws at construction |
| `traceHeaders()` | `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` of the running execution, `{}` outside one; counts the turn |
| `activeTrace()`, `bindActiveTrace(scope, fn)` | The ambient `TraceScope` (`threadId`, `rootId`, `turnCountHint`). TypeScript keeps it in one `AsyncLocalStorage` on `globalThis` under `Symbol.for("@synadia-ai/agent-fabric:trace-scope")`, so every installed copy shares it; Python in a `ContextVar` (`bind_active_trace(scope)` is a context manager) |
| `buildEdgeRecord(agent, threadId, parentId, rootId, toolCallId, turnCountHint)` | One record's bytes and its `record_id` |
| `traceRecordCounts()` | Process-wide `{ published, dropped }` — what the heartbeat reports as `records_published` / `records_dropped` |
| `TraceOptions`, `TraceScope`, `TraceRecordCounts`, `FabricTracing`, `isThreadId`, `randomThreadId`, `validToolCallId`, the constants | The rest of the vocabulary |
| `scratchPadExtension({ scratchPad, agents, discoverTimeoutMs?, grantRequestTimeoutMs? })` → `ScratchPadExtension` | The extension for `AgentTools`' `extensions`: the three hooks, plus `remember(text)`, `requestInterceptor` (remembers the references in served prompts) and `grantCaller(reference, sender)` (the reply side: grants a verified sender read first-hand; `false` for any other) |
| `ScratchPad`, `Grantee`, `GrantKind`, `TraceIds` | The port the extension runs on, and its types |
| `spCliScratchPad({ volume, nats, bin?, dir?, grantTtlS?, creator? })` → `ScratchPadClient` | The port's ready implementation over ScratchPad's `sp` CLI, with the agent's `commit(text, path, trace)` and `read(reference, trace)`. Python: `SpCliScratchPad(...)` |
| `scratchPadFromEnv(env?, { creator?, nats? })` → `ScratchPadClient \| undefined` | The same from `SCRATCHPAD_VOLUME` (unset: off), `SCRATCHPAD_BIN`, `SCRATCHPAD_DIR`, `SCRATCHPAD_GRANT_TTL_S` and the agent's `NATS_CONTEXT` or `NATS_CREDS`/`NATS_URL`. Python: `scratchpad_from_env(env=None, *, creator=None, nats=None)` |
| `findReferences`, `removeReferences`, `referenceCreator`, `readsReferences`, `granteeFromIdentity`, `READS_REFERENCES_KEY`, `REFERENCE_PREFIX` | The references' vocabulary |
| `requestGrant(agents, creatorAddress, request, { timeoutMs? })` | The requester's side; never throws, a refusal carries its reason |
| `grantRequestEndpoint({ promptAddress, scratchPad, logger? })` | The creator's side: an extra endpoint for the agent's `AgentService` (`extraEndpoints` / `extra_endpoints`) |
| `answerGrantRequest(requester, payload, scratchPad)`, `encodeGrantRequest`, `encodeGrantReply`, `grantSubject`, `GrantRequest`, `GrantReply` | The creator's rule for an already verified requester, and the wire shapes |

## On the wire

Byte for byte what the protocol SDK wrote before tracing moved out of it
(`synadia-agents` `c9d7bcb`), and the contract of `afo-design.md` §3, §4,
§6.2 and §8:

- **The edge record**, `version: 1`, kind `edge`, published on `TRACE.edges`
  immediately before the prompt it describes — after the prompt is signed
  and its size checked, so a prompt that never goes out has no record.
  Signed with `Agent-Sender` over the subject it is published to;
  `record_id` = the header's nonce = `Nats-Msg-Id`. It validates against
  `edge.json` (vendored in `test-fixtures/schemas/`).
- **The envelope** carries `thread_id` and `root_id` after the protocol's
  fields: `{"prompt":"…","thread_id":"…","root_id":"…"}`. The parent stays in
  the edge record.
- **The host** adopts the pair, mints a root when there is none, and answers
  a half pair or a malformed ID with `400` before the handler runs. The half
  pair's description is the pre-split text in each language; a malformed
  ID's is new in Python, where it used to be pydantic's validation message.
- **The heartbeat** carries `records_published` and `records_dropped`,
  except in propagate-only mode. A caller without a signer publishes no
  record, warns once per connection, and counts a drop.

### The grant request

One signed NATS request, one JSON reply, the shapes of
`test-fixtures/schemas/sp-grant-{request,reply}.json` (vendored from
`synadia-agent-fabric`), the same bytes from both packages:
`{"reference":"sp-ref:…","grantee":"<account>.<user>","trace":{"thread_id":"…","root_id":"…","tool_call_id":"…"}}`,
`trace` only inside a served prompt and `tool_call_id` only when valid;
`{"granted":true}` or `{"granted":false,"reason":"…"}`, one reason per line
of the creator's rule. The `Agent-Sender` signature is over the grant
subject, verified by the SDK's `SenderGate`, which also refuses a replay.
The creator answers on its service's `sp-grant` endpoint, in the `agents`
queue group and listed in `$SRV.INFO` next to `prompt` and `status`; the
reply carries no headers.

## What the hooks do not carry

Measured against the tracing the protocol SDK had at `c9d7bcb`:

- **Inherited tracing.** A client with no tracing of its own, used inside
  a traced handler, used to trace with the service's options. A client now
  runs fabric code only when it is given the prompt interceptor.
- **Python: lineage on an explicit `Envelope`.** `agent.prompt(Envelope(…,
  thread_id=…, root_id=…))` could choose the lineage it was sent with, and
  `Envelope(thread_id="bad")` raised at construction. The SDK now sends an
  envelope's extra fields with it, since a relay must preserve them (§5.6),
  and a prompt interceptor's field of the same name replaces one. The
  fabric's interceptor never reads the pair from the envelope: it mints
  its own, so a traced relay forwarding the envelope it received spawns a
  child thread.
- **Python: an untraced relay passes the lineage on.** A client without the
  fabric's prompt interceptor that forwards the envelope it received sends
  its pair as it is,
  `{"prompt":"hi","thread_id":"<parent>","root_id":"<root>"}`, and a traced
  receiver adopts it: the child runs as its parent's own thread, with no
  edge between them. So every client in a traced agent gets the fabric's
  prompt interceptor. The TypeScript client's `prompt()` takes text only,
  so it has no such path.
- **Where a too-large prompt fails.** The two fields are added at publish
  time, so a prompt that only they push over `max_payload` fails on the
  stream's first iteration instead of in `prompt()`. No record either way.
- **The host's order of checks.** A malformed pair is refused after sender
  classification now, not before: a request that is also refused for its
  sender gets `401`/`403` rather than `400`. And only a host running the
  fabric reads the pair at all — a host on the protocol SDK alone neither
  adopts it nor refuses a half pair.

And for the ScratchPad extension, measured against the reference agents'
own tools (the examples repository at `1e783a3`):

- **The ScratchPad extension's own client.** A hook sees the target's
  handle but not the helper's client or the handles its discovery found,
  so the extension takes `agents` in its options and keeps its own map
  from the discovery hook; a creator it has not seen costs one discovery.

## Development

See [CLAUDE.md](CLAUDE.md): the layout, how to run the suites, the rules.

## License

Apache-2.0, like the protocol SDK. See [LICENSE](LICENSE).
