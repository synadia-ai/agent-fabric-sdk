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
from synadia_ai.agent_fabric import scratch_pad_extension, scratchpad_from_env

scratch_pad = scratchpad_from_env(creator=address)  # None: ScratchPad off
references = scratch_pad and scratch_pad_extension(scratch_pad=scratch_pad, agents=agents)
# in the handler: ref = await scratch_pad.commit(answer, f"/replies/{thread_id}.md", trace)
#                 text = await scratch_pad.read(ref, trace)
```

| Variable | Default | |
| --- | --- | --- |
| `SCRATCHPAD_VOLUME` | unset: ScratchPad off | the volume the agent commits to, by name; created on first commit |
| `SCRATCHPAD_BIN` | `sp` on PATH | the `sp` binary |
| `SCRATCHPAD_DIR` | `scratchpad-<volume>` under the temp directory | a private directory for the CLI's saved replies, used by its real path |
| `SCRATCHPAD_GRANT_TTL_S` | `600` | how long a read grant lasts, in seconds |

`sp` connects as the agent does: `NATS_CONTEXT`, or `NATS_CREDS` with
`NATS_URL` (or pass `nats=`, any object with `context`, `url` and `creds`,
`SpCliConnection`). The same from code:
`SpCliScratchPad(volume=..., nats=..., bin="sp", dir=None, grant_ttl_s=600, creator=None)`,
a `ScratchPadClient` — the `ScratchPad` port plus `commit(text, path, trace)`
and `read(reference, trace)`.

Today the implementation drives ScratchPad's command line, `sp`, which must
be on the machine (built from ScratchPad's repository) and connects with the
agent's own credentials; ScratchPad must be reachable in the tenant's
account, and it is not on NGS yet. `ScratchPadClient` is the interface a later implementation speaking
NATS directly will satisfy, once a Python ScratchPad client exists; nothing
above it changes then.
