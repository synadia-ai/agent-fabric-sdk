# synadia-ai-agent-fabric

The SDK for agents on the Synadia Agent Fabric, for Python, built on the
hooks of the Synadia Agent Protocol SDK (`synadia-ai-agents`,
`synadia-ai-agent-service`). See the repository's
[README](https://github.com/synadia-ai/agent-fabric-sdk#readme) for usage.

- **Tracing:** `fabric_tracing()` and `trace_headers()`.
- **The `served` record**, for a harness plugin's add-on: the plugin's
  binding of a served thread to the harness's own thread id, two records
  per prompt (`served.json`). `build_served_record(…)` writes one, from the
  agent, the thread and root, the harness, its thread id, the phase and, on
  `end`, the status; `served_publisher(agents, subject=...)` publishes a
  prompt's pair through the plugin's own client, signed with the record id
  as nonce, in the order the records were due, counted with the edges:
  `begin_turn(scope, harness)` when the prompt arrives, then
  `bind(harness_thread_id)` for `start` and `settle(status, at_s=None)` for
  `end`; `await flush()` before stopping. `valid_harness_thread_id` is the
  rule an id must pass. The bytes are the TypeScript package's; the add-ons
  themselves are TypeScript.
- **The ScratchPad extension** for the agent tools:
  `scratch_pad_extension(scratch_pad=..., agents=...)` in `AgentTools`'
  `extensions`, with the grant request's two sides, `request_grant` and
  `grant_request_endpoint` (an `AgentService` extra endpoint). The agent
  brings its ScratchPad client behind the `ScratchPad` port, or takes the
  ready one below.

## ScratchPad without writing ScratchPad code

An agent gets ScratchPad by configuration. Two lines: build it from the
environment, then hand the object to the extension (and the grant request's
endpoint) and commit and read with it yourself.

```python
from synadia_ai.agent_fabric import scratch_pad_extension, native_scratchpad_from_env

scratch_pad = await native_scratchpad_from_env(nc=nc, creator=address)  # None: ScratchPad off
references = scratch_pad and scratch_pad_extension(scratch_pad=scratch_pad, agents=agents)
# in the handler: ref = await scratch_pad.commit(answer, f"/replies/{thread_id}.md", trace)
#                 text = await scratch_pad.read(ref, trace)
```

| Variable | Default | |
| --- | --- | --- |
| `SCRATCHPAD_VOLUME` | unset: ScratchPad off | the volume the agent commits to, by name: letters and digits only, provisioned for the agent's account and user; created on first commit |
| `SCRATCHPAD_DIR` | required when a volume is set | a private persistent directory, owned by one native writer; keep it across restarts |
| `SCRATCHPAD_GRANT_TTL_S` | `600` | publication retention and maximum grant duration, in seconds; at most 3600, and never past the reference |

The native client needs Python 3.12+, the agent's existing authenticated NATS connection,
and a private workspace. It needs no shell or binary. Use `native_scratchpad` for explicit
options and `scratchpad_reader` for a reader without a workspace. `publish_bytes` and
`publish_stream` accept binary content; `read_bytes` verifies content before return.
`read_stream` requires an explicit byte limit, and its bytes remain provisional until EOF.
Close the writer with `await scratch_pad.close()` before shutdown; this leaves NATS open.
See the [native contract](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/scratchpad-native.md)
for recovery, bounds, and test instructions. Other Fabric features still support Python 3.11.

### Optional CLI adapter

`scratchpad_from_env` and `SpCliScratchPad` remain available when an agent uses `sp`.
`SCRATCHPAD_BIN` selects that binary. `sp` connects as the agent does, with `NATS_CREDS` and `NATS_URL` (or pass
`nats=`, any object with `context`, `url` and `creds`, `SpCliConnection`); it
reads no NATS context, so a `NATS_CONTEXT` without `NATS_CREDS` is refused. The same from code:
`SpCliScratchPad(volume=..., nats=..., bin="sp", dir=None, grant_ttl_s=600, creator=None)`,
a `ScratchPadClient` — the `ScratchPad` port plus `commit(text, path, trace)`
and `read(reference, trace)`.

The CLI adapter and native client implement the same `ScratchPadClient` port.
Both require ScratchPad's service import in the tenant's NATS account.
