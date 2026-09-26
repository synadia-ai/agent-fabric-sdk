# @synadia-ai/agent-fabric

The SDK for agents on the Synadia Agent Fabric, for TypeScript, built on the
hooks of the Synadia Agent Protocol SDK (`@synadia-ai/agents`,
`@synadia-ai/agent-service`). See the repository's
[README](https://github.com/synadia-ai/agent-fabric-sdk#readme) for usage.

- **Tracing:** `fabricTracing()` and `traceHeaders()`.
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

## ScratchPad without writing ScratchPad code

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

| Variable                 | Default                                        |                                                                        |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `SCRATCHPAD_VOLUME`      | unset: ScratchPad off                          | the volume the agent commits to, by name; created on first commit      |
| `SCRATCHPAD_BIN`         | `sp` on PATH                                   | the `sp` binary                                                        |
| `SCRATCHPAD_DIR`         | `scratchpad-<volume>` under the temp directory | a private directory for the CLI's saved replies, used by its real path |
| `SCRATCHPAD_GRANT_TTL_S` | `600`                                          | how long a read grant lasts, in seconds                                |

`sp` connects as the agent does: `NATS_CONTEXT`, or `NATS_CREDS` with
`NATS_URL` (or pass `{ nats }`, the SDK's `NatsConnectionSource`). The same
from code: `spCliScratchPad({ volume, nats, bin?, dir?, grantTtlS?, creator? })`,
both returning a `ScratchPadClient` — the `ScratchPad` port plus
`commit(text, path, trace)` and `read(reference, trace)`.

Today the implementation drives ScratchPad's command line, `sp`, which must
be on the machine (built from ScratchPad's repository) and connects with the
agent's own credentials; ScratchPad must be reachable in the tenant's
account, and it is not on NGS yet. `ScratchPadClient` is the interface a later implementation speaking
NATS directly will satisfy, once a TypeScript ScratchPad client exists;
nothing above it changes then.
