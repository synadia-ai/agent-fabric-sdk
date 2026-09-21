# agent-fabric-sdk

The SDK for agents on the **Synadia Agent Fabric**, in TypeScript
(`@synadia-ai/agent-fabric`) and Python (`synadia-ai-agent-fabric`, import
`synadia_ai.agent_fabric`).

Today it carries **tracing**: the signed `edge` record before every
prompt, the `thread_id` / `root_id` pair in the envelope, the
`X-Synadia-Thread-ID` / `X-Synadia-Root-ID` headers for model calls, and the
record counts on the heartbeat. Later it takes the agent tools' ScratchPad
extension and the proxy helpers, and `plugins/` the fabric versions of the
Claude Code, OpenClaw and PI plugins.

## Built on the protocol SDK

This package is an extension of the Synadia Agent Protocol SDK
([`synadia-agents`](https://github.com/synadia-ai/synadia-agents)):
`@synadia-ai/agents` and `@synadia-ai/agent-service` in TypeScript,
`synadia-ai-agents` and `synadia-ai-agent-service` in Python. It plugs into
the SDK's public hooks — prompt interceptors on the client, request
interceptors and heartbeat extras on the host, the envelope's §5.6 extras,
signed publishing with a caller-chosen nonce — and nothing else. The SDK
knows nothing of the fabric; the dependency goes one way.

Until the SDK with the hooks is published, both packages resolve it from a
local checkout of the `mario/sdk-split` branch (see [CLAUDE.md](CLAUDE.md)).

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

## What the hooks do not carry

Measured against the tracing the protocol SDK had at `c9d7bcb`:

- **Inherited tracing.** A client with no tracing of its own, used inside
  a traced handler, used to trace with the service's options. A client now
  runs fabric code only when it is given the prompt interceptor.
- **Python: lineage on an explicit `Envelope`.** `agent.prompt(Envelope(…,
  thread_id=…, root_id=…))` could choose the lineage it was sent with, and
  `Envelope(thread_id="bad")` raised at construction. The interceptor sees
  the prompt text and `context`, never that envelope, and the SDK drops its
  extra fields; the prompt gets freshly minted lineage.
- **Where a too-large prompt fails.** The two fields are added at publish
  time, so a prompt that only they push over `max_payload` fails on the
  stream's first iteration instead of in `prompt()`. No record either way.
- **The host's order of checks.** A malformed pair is refused after sender
  classification now, not before: a request that is also refused for its
  sender gets `401`/`403` rather than `400`. And only a host running the
  fabric reads the pair at all — a host on the protocol SDK alone neither
  adopts it nor refuses a half pair.

## Development

See [CLAUDE.md](CLAUDE.md): the layout, how to run the suites, the rules.

## License

Apache-2.0, like the protocol SDK. See [LICENSE](LICENSE).
