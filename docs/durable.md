# Durable runs on the fabric

**Version:** 0.1.0-alpha · **Date:** 2026-10-03 · **Status:** the helper in both packages; the reference agents run a durable workflow with `AGENT_DURABLE=1`

An agent on the fabric can hand work to a durable-execution library: a workflow
whose steps are journaled on NATS, so the work survives a restart of the agent
and a finished step is not run again. Such a run is started from inside a
prompt, usually by a tool call of the agent's model, and it belongs to that
prompt's task. This page is how the run says so.

The join is a convention, not a record. Nothing is written for a run: its id
names the task that started it, and a model call inside one of its steps
carries the two headers the model proxy already reads. The fabric package
turns the convention into one line for an agent author, in both languages,
with the same bytes:

| TypeScript | Python | What |
| --- | --- | --- |
| `durableRunId(toolCallId)` | `durable_run_id(tool_call_id)` | the run id, `<thread_id>-<tool call id>`, from the active trace |
| `durableTrace()` | `durable_trace()` | the active trace, `{ "thread_id", "root_id" }`, for the run's input |
| `durableHeaders(trace)` | `durable_headers(trace)` | the proxy's two headers from that trace, for a model call inside a step |

None of them depends on a durable-execution library. They take and return
strings and plain objects, and the library is used unchanged: an agent passes
the run id where the library takes one and the trace in the input it already
journals. The examples below use `@synadia-ai/durable` and `synadia-durable`,
which the reference agents run.

## The run id

```ts
import { durableRunId, durableTrace } from "@synadia-ai/agent-fabric";

const runId = durableRunId(toolCallId);   // "3f9c…e21a-call_8Hx2"
const handle = await client.start(workflow, { task, trace: durableTrace() }, { runId });
```

```python
from synadia_ai.agent_fabric import durable_run_id, durable_trace

run_id = durable_run_id(tool_call_id)     # "3f9c…e21a-call_8Hx2"
handle = await client.start(workflow, {"task": task, "trace": durable_trace()}, StartOptions(run_id=run_id))
```

A run id is `<thread_id>-<rest>`:

- `<thread_id>` is the served prompt's thread, 32 lowercase hex characters,
  from the trace the fabric's tracing binds around every prompt handler
  (`fabricTracing()`, `activeTrace()`).
- `<rest>` is the model's tool-call id with every character outside
  `[A-Za-z0-9_-]` replaced by `_`, one `_` per Unicode code point. A
  durable-execution library uses the run id as a NATS subject token and as a
  key-value key, so it is held to that set; `call.1 *` becomes `call_1__`.

Whoever reads the runs can then name the task of each: a run id of that form
names the thread, and the rest names the tool call within it. A run id of any
other form joins no task. A library that derives the ids of a run's children
and generations from its own (`<run id>_<n>`, `<run id>_g<n>` in the library
above) keeps the prefix, so they join the same task.

The tool-call id must be what the model gave the call, the same id the agent
passes to the SDK's agent tools. An empty id, one longer than 256 code points
(the limit tracing puts on a tool-call id), or one that is not valid Unicode is
an error. Use the run id as the start's idempotency key as well: a tool call
retried within the same prompt starts the same run once.

**Without an active trace** (code that runs outside a traced prompt handler)
`durableRunId` returns `undefined` and `durable_run_id` returns `None`. There
is no served thread to name; pick a run id of your own. That run joins no task.

## The trace in the input, the headers inside a step

A step runs on the library's worker, which takes the run from a queue: it runs
outside the prompt's async context, where `traceHeaders()` has nothing to
give. So the trace travels in the run's input, under a key of your choosing,
and comes back as headers inside the step:

```ts
const answer = await ctx.run("ask-model", async () => {
  const { message } = await model.complete(messages, [], durableHeaders(input.trace));
  return message.content ?? "";
});
```

```python
async def ask_model() -> str:
    completion = await model.complete(messages, [], durable_headers(input.get("trace")))
    return completion.message.get("content") or ""

answer = await ctx.run("ask-model", ask_model)
```

`durableTrace()` is `{ "thread_id": …, "root_id": … }`, in that key order, the
same bytes from both packages; `undefined` / `None` outside a traced handler.
Unlike `traceHeaders()` it counts no model turn, because it makes no model
call.

`durableHeaders(trace)` gives `X-Synadia-Thread-ID` and `X-Synadia-Root-ID`,
the two headers `traceHeaders()` gives inside a handler and the model proxy
reads; no third header. The call then lands on the thread of the prompt that
started the run. The trace is read back from the run's journal, so it is
checked as untrusted input: both ids must have the shape of a thread id, or
the result is `{}`. `{}` too for no trace, so a run started outside a traced
handler makes its model calls without the headers.

## The library's resources are the tenant's

A durable-execution library keeps its runs in JetStream resources of its own;
the library above uses seven: three streams, three key-value buckets and an
object store. On the fabric they live in each tenant's own account, created by
the fabric's onboarding and sized to the tenant's tier. A library's defaults do
not fit a tier: a prefix reserves its `max_bytes` on every resource, and a
tier caps both the streams and the bytes an account may reserve.

So an agent's worker and client are given **no sizing and no replicas**. They
find the resources that are there, read them back, bind the worker's
consumers, and create and change nothing. In the library above, a worker or
client given no `streamMaxBytes` / `stream_max_bytes` and no `replicas`
reconciles only the settings the library owns and never sends a stream create
or update for existing resources. An account without the resources refuses
the worker at its first create that does not fit; ask your deployment for
them.

## The reference agents

Both reference agents run one durable workflow when `AGENT_DURABLE=1` (off by
default): `reference-agents/typescript/src/durable.ts` and
`reference-agents/python/fabric_agent/durable.py`, marked `(5)` where the run
joins its task. The workflow `durable-task` has two steps: `ask-model` calls
the model through the proxy with `durableHeaders` from the run's input and a
short instruction, and `write-result` writes the step's answer into the
result. The model sees one more tool, `run_durable_task`. Its runner starts the
run with `durableRunId(<the model's tool-call id>)` and the trace from
`durableTrace()` in the input, awaits the result, and returns it as the tool's
text, with the run id.

Their tests (`test/durable.test.ts`, `tests/test_durable.py`) run on a
throwaway `nats-server` with JetStream and one account shaped like a tenant's:
file storage only, `max_bytes` required on every stream, room for seven
streams. The seven are created first from the configurations the onboarding
applies (`test-fixtures/durable/`, at one replica). A prompt's tool call
starts the run, and the tests check that the journal's start entry has the run
id `<served thread>-<tool call id>` and the trace in its input, that the
step's model call reached the stub proxy with the two headers equal to that
trace, and that the account's JetStream API advisories show no stream create
or update from the worker's start or the run.
