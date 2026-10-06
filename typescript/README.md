# @synadia-ai/agent-fabric

The SDK for agents on the Synadia Agent Fabric, for TypeScript, built on the
hooks of the Synadia Agent Protocol SDK (`@synadia-ai/agents`,
`@synadia-ai/agent-service`). The
[repository](https://github.com/synadia-ai/agent-fabric-sdk#readme) has the
Python twin, the reference agents and the design notes.

## Install

```sh
npm install @synadia-ai/agent-fabric
```

The package needs the protocol SDK's two packages, `@synadia-ai/agents` (the
client) and `@synadia-ai/agent-service` (the host). They are its dependencies
and install with it; your agent imports `Agents` and `AgentService` from them.
Node 20 or later; the native ScratchPad writer needs Node 22.13+.

## What it gives

- **Tracing:** `fabricTracing()` and `traceHeaders()`.
- **Durable runs** joined to the task that started them:
  `durableRunId(toolCallId)`, `durableTrace()`, `durableHeaders(trace)` and
  `withDurableTrace(trace, turnCount, fn)`,
  with no dependency on a durable-execution library
  ([`docs/durable.md`](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/durable.md)).
- **The `served` record**, for a harness plugin's add-on: the plugin's
  binding of a served thread to the harness's own thread id, two records
  per prompt (`served.json`). `buildServedRecord(…)` writes one, from the
  agent, the thread and root, the harness, its thread id, the phase and, on
  `end`, the status; `servedPublisher({ agents, subject? })` publishes a
  prompt's pair through the plugin's own client, signed with the record id
  as nonce, in the order the records were due, counted with the edges:
  `beginTurn(scope, harness)` when the prompt arrives, then
  `bind(harnessThreadId)` for `start` and `settle(status, atMs?)` for
  `end`; `flush()` before stopping. `validHarnessThreadId` is the rule an
  id must pass. PI writes none: the fabric's headers go on its own calls.
- **The ScratchPad extension** for the agent tools:
  `scratchPadExtension({ scratchPad, agents })` in `AgentTools`'
  `extensions`, with the grant request's two sides, `requestGrant` and
  `grantRequestEndpoint` (an `AgentService` extra endpoint). The agent
  brings its ScratchPad client behind the `ScratchPad` port, or takes the
  ready one below.

## Tracing

`fabricTracing()` returns the three hooks the protocol SDK takes: the prompt
interceptor for the client, the request interceptor and the heartbeat extras
for the host. Every served prompt then runs inside a trace scope, every prompt
the agent sends to another agent becomes a child thread with a signed `edge`
record on `TRACE.edges`, and `traceHeaders()` gives the two headers the model
proxy files a model call by.

```ts
import { Agents } from "@synadia-ai/agents";
import { AgentService } from "@synadia-ai/agent-service";
import { fabricTracing, traceHeaders } from "@synadia-ai/agent-fabric";

const tracing = fabricTracing(); // edges to TRACE.edges; { edgeSubject: null } only propagates
const agents = new Agents({ nc, identity: { signer }, interceptors: [tracing.promptInterceptor] });
const svc = new AgentService({
  nc,
  agent: "triage",
  owner: "acme",
  name: "main",
  interceptors: [tracing.requestInterceptor],
  heartbeatExtras: tracing.heartbeatExtras,
});
svc.onPrompt(async (envelope, response) => {
  const answer = await callModel(envelope.prompt, { headers: traceHeaders() });
  const [lookup] = await agents.discover({ filter: { agent: "lookup" } }); // a child thread:
  for await (const m of await lookup!.prompt(answer, { context: { toolCallId: "toolu_01" } }))
    if (m.type === "response") await response.send(m.text);
});
```

Records are signed, so the agent needs a signed identity; the tool-call ID in
the prompt's `context` hangs the child thread under the model's tool call.

## Durable runs

A workflow started from a prompt, usually by a tool call of the agent's
model, belongs to that prompt's task. The helpers make the join one line; none
of them depends on a durable-execution SDK.

```ts
import {
  durableHeaders,
  durableRunId,
  durableTrace,
  withDurableTrace,
} from "@synadia-ai/agent-fabric";

// In the prompt's handler: the run id names the served thread and the tool call.
const runId = durableRunId(toolCallId); // "<thread_id>-<tool call id>", undefined outside a traced handler
const handle = await client.start(workflow, { task, trace: durableTrace() }, { runId });

// Inside a step, on the worker: the trace comes back from the run's input.
const reply = await model.complete(messages, [], durableHeaders(input.trace));
const result = await withDurableTrace(input.trace, turnsSoFar, () =>
  tools.execute(name, args, { toolCallId }),
);
```

- `durableRunId(toolCallId)`: `<thread_id>-<tool call id>`, the tool-call id
  held to `[A-Za-z0-9_-]`; use it as the start's idempotency key too.
- `durableTrace()`: `{ thread_id, root_id }` of the active trace, for the
  run's input.
- `durableHeaders(trace)`: the proxy's two headers from that trace, for a
  model call inside a step; `{}` for a missing or malformed trace.
- `withDurableTrace(trace, turnCount, fn)`: binds the trace around code inside
  a step, so a prompt it sends to another agent is filed under the task.

See [`docs/durable.md`](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/durable.md)
for the run id's rules, durable agents, and what is exactly-once.

## ScratchPad without writing ScratchPad code

Use the native client for SDK agents without a shell or installed binary:

```ts
import { nativeScratchPadFromEnv, scratchPadExtension } from "@synadia-ai/agent-fabric";

const scratchPad = await nativeScratchPadFromEnv(process.env, { nc, creator: address });
const references = scratchPad && scratchPadExtension({ scratchPad, agents });
```

The writer needs Node 22.13+, a configured `SCRATCHPAD_VOLUME`, and a private,
persistent `SCRATCHPAD_DIR`. It borrows the agent's authenticated connection.
Use `nativeScratchPad` for explicit options and `scratchPadReader` for a consumer
that needs no writer workspace. Native clients need no private ScratchPad source.
See [the native contract](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/scratchpad-native.md)
for binary artifacts, streamed transfers, error handling, recovery, and qualification scope.

### CLI adapter

An agent gets ScratchPad by configuration. Two lines: build it from the
environment, then hand the object to the extension (and the grant request's
endpoint) and commit and read with it yourself.

```ts
import { scratchPadFromEnv, scratchPadExtension } from "@synadia-ai/agent-fabric";

const scratchPad = scratchPadFromEnv(process.env, { creator: address }); // undefined: ScratchPad off
const references = scratchPad && scratchPadExtension({ scratchPad, agents });
// in the handler: const ref = await scratchPad.commit(answer, `/replies/${threadId}.md`, trace);
//                 const text = await scratchPad.read(ref, trace);
```

| Variable                 | Default                                        |                                                                                                                                          |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `SCRATCHPAD_VOLUME`      | unset: ScratchPad off                          | the volume the agent commits to, by name: letters and digits only, provisioned for the agent's account and user; created on first commit |
| `SCRATCHPAD_BIN`         | `sp` on PATH                                   | the `sp` binary                                                                                                                          |
| `SCRATCHPAD_DIR`         | `scratchpad-<volume>` under the temp directory | a private directory for the CLI's workspace, used by its real path; keep it across restarts                                              |
| `SCRATCHPAD_GRANT_TTL_S` | `600`                                          | how long a read grant lasts, in seconds; at most ten minutes, and never past the reference                                               |

`sp` connects as the agent does, with `NATS_CREDS` and `NATS_URL` (or pass
`{ nats }`, the SDK's `NatsConnectionSource`); it reads no NATS context, so a
`NATS_CONTEXT` without `NATS_CREDS` is refused. The same
from code: `spCliScratchPad({ volume, nats, bin?, dir?, grantTtlS?, creator? })`,
both returning a `ScratchPadClient` — the `ScratchPad` port plus
`commit(text, path, trace)` and `read(reference, trace)`.

The CLI adapter drives the sp v2 command line, `sp`, which must be on the
machine (the [binary guide](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/scratchpad-binaries.md)
installs a pinned release) and connects with the agent's own credentials. Each
commit publishes the reply
retained for ten minutes, and its reference is valid as long; a grant goes
only to an agent in the reference's own account, as `sp` refuses any other; ScratchPad must be reachable in the tenant's
account. Both native and CLI clients implement the existing `ScratchPadClient`
interface; the Fabric reference policy uses that interface.

## Short artifact references

The client accepts `sp-r1:` short tokens and existing `sp-ref:` tokens.
Publication uses the short form when the service and the selected client support it.
Copy the returned token unchanged into prompts and replies.
The token survives client restarts; each content read still requires current authorization.
See the [native client contract](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/scratchpad-native.md) for recovery and capability fallback.

## License

Apache-2.0. See [LICENSE](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/typescript/LICENSE)
and [THIRD_PARTY_NOTICES](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/typescript/THIRD_PARTY_NOTICES).
