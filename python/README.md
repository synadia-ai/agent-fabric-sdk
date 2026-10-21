# synadia-ai-agent-fabric

The SDK for agents on the Synadia Agent Fabric, for Python, built on the
hooks of the Synadia Agent Protocol SDK (`synadia-ai-agents`,
`synadia-ai-agent-service`). See the repository's
[README](https://github.com/synadia-ai/agent-fabric-sdk#readme) for usage.

- **A caller:** `fabric_caller()` and the `agent-fabric` command, to prompt
  your agents with the creds file the console gave you (below).
- **Tracing:** `fabric_tracing()` and `trace_headers()`.
- **Durable runs** joined to the task that started them:
  `durable_run_id(tool_call_id)`, `durable_trace()`, `durable_headers(trace)`
  and `with_durable_trace(trace, turn_count)`, with no dependency on a durable-execution library
  ([`docs/durable.md`](../docs/durable.md)).
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

## Prompt your agents

All a caller needs is the creds file the console gave you and the URL it
showed next to that file. The command and the helper below connect with that
file and sign every prompt with its key. Each prompt is traced as a task of its
own, so the console shows it with everything the agent did for it.

### From the command line

```sh
export NATS_URL=<the URL the console showed>
uvx --from synadia-ai-agent-fabric agent-fabric agents --creds ./my.creds
uvx --from synadia-ai-agent-fabric agent-fabric prompt writer "Write two lines about the sea." --creds ./my.creds
```

`pip install synadia-ai-agent-fabric` installs the same `agent-fabric`
command.

- `agents` lists the agents your creds file can reach: the address, the kind
  and the agent's own registered identity (`agent identity: none` when it
  registered none; your prompts are signed either way).
- `prompt <address or kind> "<text>"` streams the reply to stdout. An agent
  is named by its address, or by its kind when exactly one agent has it.
- On stderr: the URL, the agent and its identity, `root <id>` (the task's root id, which is
  how the console finds the task), and `reference: <token>` when the reply
  hands back a ScratchPad reference.
- A question the agent asks mid-reply is printed on stderr, prefixed `? `.
  The next line on stdin answers it. With no input, the agent is told the
  caller cannot answer and goes on.

| Flag | What |
| --- | --- |
| `--creds <file>` | the creds file; default `NATS_CREDS` |
| `--url <url>` | the URL the console showed; default `NATS_URL`. There is no built-in default |
| `--timeout <s>` | how long to wait for the whole reply; default 600 seconds |
| `--json` | one JSON object, `{"root", "text", "references"}`, instead of the stream |

Exit codes: `0` done; `1` no such agent, a refused prompt, or no connection;
`2` a usage error, or no creds file or URL.

### From code

```python
import asyncio
import os

from synadia_ai.agent_fabric import fabric_caller
from synadia_ai.agents import ResponseChunk


async def main() -> None:
    async with await fabric_caller(creds="./my.creds", url=os.environ["NATS_URL"]) as caller:
        # The whole reply as a string.
        reply = await caller.ask("writer", "Name three rivers.")
        print(reply.text, reply.root_id)

        # Or streamed: the SDK's messages, unchanged.
        prompt = await caller.prompt("writer", "Write two lines about the sea.")
        async for msg in prompt.stream:
            if isinstance(msg, ResponseChunk):
                print(msg.text, end="", flush=True)
        print(f"\nroot {await prompt.root_id}")


asyncio.run(main())
```

- `fabric_caller(creds=..., url=None, name=None, edge_subject="TRACE.edges")` connects.
  `url` defaults to `NATS_URL`. `fabric_caller_from_env()` reads `NATS_CREDS`
  and `NATS_URL`. Use the caller with `async with`, or call `await caller.close()`.
- `list()` returns the agents. `find(who)` returns one by address, or by
  kind when exactly one agent has it. `agents` is the protocol SDK's client,
  for anything else.
- `prompt(who, text, **options)` returns `CallerPrompt(stream, root_id)`.
  `root_id` is a future that resolves once you start iterating the stream,
  before the first chunk. Await it after iteration has begun, never before.
  If the prompt never goes out (the stream is closed with `aclose()`, or
  fails first), `root_id` fails instead. The options are `Agent.prompt`'s, such as `max_wait_s`.
- `ask(who, text, on_query=None, **options)` returns
  `CallerReply(text, root_id)`. `on_query` answers a question the agent asks
  and may be a coroutine function. Without it, the agent is told the caller
  cannot answer.
- `close()` closes the connection and wipes the credentials from memory.

Errors are `FabricCallerError`s with a `reason`:

| `reason` | When |
| --- | --- |
| `config` | no creds file, or no URL |
| `connect` | the server at the URL cannot be reached, or refuses the creds file; the message names the URL and the server's reason |
| `identity` | the server will not tell the creds file's identity, which signing needs |
| `not-found` | no agent by that address or kind; the message lists the agents there |
| `ambiguous` | more than one agent of that kind; the message lists their addresses |
| `not-sent` | the prompt never went out, so it has no root (from `root_id`) |

A prompt the agent refuses fails the stream with the protocol SDK's error.
The source distribution also holds five examples in `examples/`: one prompt,
a reply in a script, questions answered, the agents listed, and topics
prompted on an interval.

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

Short artifact references
-------------------------

The client accepts `sp-r1:` short tokens and existing `sp-ref:` tokens.
Publication uses the short form when the service and the selected client support it.
Copy the returned token unchanged into prompts and replies.
The token survives client restarts; each content read still requires current authorization.
See the [native client contract](../docs/scratchpad-native.md) for recovery and capability fallback.
