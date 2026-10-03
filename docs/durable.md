# Durable runs on the fabric

**Version:** 0.1.0-alpha · **Date:** 2026-10-03 · **Status:** the helper in both packages; the reference agents delegate durable work with `AGENT_DURABLE=1`; a durable reference agent in each language

An agent on the fabric can hand work to a durable-execution library: a workflow
whose steps are journaled on NATS, so the work survives a restart of the agent
and a finished step is not run again. Such a run is started from inside a
prompt, usually by a tool call of the agent's model, and it belongs to that
prompt's task. This page is how the run says so.

Two things follow from it. **Durable agents**, where even the model calls are
durable: the model loop is the workflow, and a crash of the agent loses no
model turn it had finished. And **durable work for every agent on the
fabric**, harness agents included: any agent can hand a job to a workflow, and
the run is shown under the tool call that started it. One limit is named
below: the reply of a prompt that was being served when its process died is
not delivered.

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
| `withDurableTrace(trace, turnCount, fn)` | `with with_durable_trace(trace, turn_count):` | the trace bound around code inside a step, as a prompt's handler is bound |

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

## The trace scope inside a step

A model call inside a step needs only the headers. A step that prompts
another agent needs more: the fabric's prompt interceptor writes an edge for
the prompt, naming the thread that sends it as the parent, and it reads that
thread from the active trace, which a worker does not have.
`withDurableTrace(trace, turnCount, fn)` binds the trace from the run's input
around `fn`, as the fabric's tracing binds a prompt's handler:

```ts
const result = await ctx.run("tool-0-0", () =>
  withDurableTrace(input.trace, turnsSoFar, () => tools.execute(name, args, { toolCallId })),
);
```

```python
async def tool() -> str:
    with with_durable_trace(input.get("trace"), turns_so_far):
        return json.dumps(await tools.execute(name, args, tool_call_id=tool_call_id))

result = await ctx.run("tool-0-0", tool)
```

`turnCount` is how many model calls the run has made so far. It becomes the
`turn_count_hint` of any edge written inside, so the edge records where in the
thread the prompt went out, as it does for a handler; a `traceHeaders()` call
inside counts one more. A trace that is missing or not shaped like thread ids
binds nothing. An author never builds the scope by hand.

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

## The reference agents: durable work, delegated

Both reference agents delegate durable work when `AGENT_DURABLE=1` (off by
default): `reference-agents/typescript/src/durable.ts` and
`reference-agents/python/fabric_agent/durable.py`, marked `(5)` where the run
joins its task. This is the shape for an agent whose model loop is not
durable, a plain SDK agent or a harness: the model hands a job to a workflow
the agent's process hosts, by name with an input, and gets back the run id and
the result.

The process hosts a small registry of named workflows, run by a worker on the
agent's connection. The model sees one more tool, `start_workflow`, defined
word for word the same in both languages:

```json
{"type": "function", "function": {
  "name": "start_workflow",
  "description": "Starts a durable workflow this agent hosts and waits for its result. Each step of a workflow is journaled, so the work survives a restart of this agent and a finished step is not done again. Use it when the prompt asks for durable work. The workflows: durable-task: carries out a task given in words with one model call, then writes the answer into its result; input {\"task\": \"<the task>\"}. Returns the run id and the workflow's result.",
  "parameters": {"type": "object", "properties": {
    "name": {"type": "string", "enum": ["durable-task"], "description": "The workflow to start."},
    "input": {"type": "object", "description": "The workflow's input, as its description says."}},
    "required": ["name", "input"]},
  "strict": false}}
```

The `enum` and the list in the description are built from the registry. Its one
entry is a demo, `durable-task`, of two steps: `ask-model` calls the model
through the proxy with `durableHeaders` from the run's input and a short
instruction, and `write-result` writes the step's answer into the result. The
tool's runner starts the run under `durableRunId(<the model's tool-call id>)`,
with `{ "input": <the model's input>, "trace": durableTrace() }` as the run's
input, awaits the result, and returns `{ "run_id", "result" }` as the tool's
text. The console shows the run under the tool call that started it.

Their tests (`test/start-workflow.test.ts`, `tests/test_start_workflow.py`) run
on a throwaway `nats-server` with JetStream and one account shaped like a
tenant's: file storage only, `max_bytes` required on every stream, room for
seven streams. The seven are created first from the configurations the
onboarding applies (`test-fixtures/durable/`, at one replica). A prompt's tool
call starts the run, and the tests check that the journal's start entry has
the run id `<served thread>-<tool call id>` and the trace in its input, that
the step's model call reached the stub proxy with the two headers equal to that
trace, and that the account's JetStream API advisories show no stream create
or update from the worker's start or the run. `tests/test_durable_parity.py`
compares the tool's definition and the workflows' names and words between the
two agents, byte for byte.

## A durable agent

The workflow above is one tool of an agent whose model loop lives in memory.
A crash of that agent loses the conversation, and the prompt it was serving
is gone with every model turn and tool call it had made. A **durable agent**
makes the model loop itself the workflow: every model turn and every tool
call is a journaled step, so after a crash the loop replays from its journal,
a recorded turn returns what it returned, a recorded tool call returns its
result, and execution resumes at the first step not yet journaled. With the
fabric's helpers, its model calls before and after a crash land on one thread
under one agent.

This is the shape for an agent whose own work must survive a crash; it needs no
`start_workflow`, since its loop is the workflow. Both reference packages have
one, configured by the same `.env` as the reference agent:
`reference-agents/typescript/src/durable-agent.ts`, started with
`npm run start:durable`, and `reference-agents/python/fabric_agent/durable_agent.py`,
started with `uv run python -m fabric_agent.durable_main`. The Python host
serves one prompt at a time unless told otherwise, and the front door waits on
the run's result while it serves, so the Python agent sets
`max_concurrent_prompts` as the reference agent does.

**The front door** is the fabric's: `AgentService` with `fabricTracing()`'s
interceptors and the signed identity. It is a thin relay and not durable
itself. For each prompt it starts a run of the workflow `agent-loop` and
sends the run's answer:

```ts
service.onPrompt(async (envelope, response) => {
  const runId = durableRunId("prompt");            // "<thread_id>-prompt"
  const handle = await runs.start(agentLoop, { prompt: envelope.prompt, trace: durableTrace(), caller }, { runId });
  const result = await handle.result(timeoutMs);
  await response.send(result.answer);
});
```

**The run id of a prompt-level run** is `durableRunId("prompt")`,
`<thread_id>-prompt`: it names the served thread, and since `prompt` is no
tool call's id, the run belongs to the thread itself. The run id is the
start's idempotency key, so the same prompt again on the same thread finds
the run it started.

**The loop** is the workflow, in the shape of any tool-calling loop:

| Step | What |
| --- | --- |
| `llm-N` | a model turn through the proxy, with `durableHeaders(input.trace)` |
| `tool-N-i` | a tool call, in the run's tool scope and inside `withDurableTrace(input.trace, N + 1, …)` |
| `ask-request-N-i`, then the signal `ask-N-i` | a question the prompted agent asked: the run parks on `ctx.await` (`ctx.wait` in Python); the front door asks the caller and signals the answer |
| `answer-N-i` | the caller's answer, carried back to the prompted agent with `answer_agent` |

The tools are the fabric's agent tools, with the ScratchPad extension when
ScratchPad is configured. A worker serves no prompt, so the tools need a scope
of their own: `AgentTools.runInPromptScope(fn, { caller })` opens one
(`async with tools.prompt_scope(caller=…)` in Python), with
the verified caller for the loop guard. A call that asked a question has to
stay open while the run waits for the answer, across steps, so the agent holds
one scope per run open until the run ends, and each tool step enters it.
That scope lives in memory.

**After a crash** a worker of the same agent, in a restarted process or
another instance, takes the run up once its work item is delivered again:
after the library's acknowledgement wait, 30 seconds by default, and once the
dead worker's lease on the run has lapsed.

**What is exactly-once, and what is at-least-once.**

- A model turn whose step ended is never made again: it is journaled before
  the next step begins. A model turn in flight when the process died is made
  again.
- A tool call in flight when the process died runs again. `prompt_agent`
  carries no idempotency key, so the prompted agent may be prompted twice,
  and a second edge is written for it.
- A question parked on a durable signal survives a crash in the journal. The call
  that asked it does not: it lived on the dead process's connection. An answer
  signalled later reaches `answer_agent` as a call it does not know, and the
  model reads that in words.
- **The reply to the prompt that was being served when the process died is
  not delivered.** The run completes in the journal, but the caller's prompt
  stream ended with the process. Delivering that reply needs a durable prompt,
  which the protocol does not have yet. The agent does not work around it.

Its tests, the same in both languages: `test/durable-agent.test.ts` and
`tests/test_durable_agent.py` run the agent as a child process
against a stub model and a tenant-shaped server. The stub holds the second
model turn. The test kills the agent after the run's first step has ended and
starts it again. The run completes, with one `step-end` per step. The stub saw
the first model turn exactly once, every model call of both processes carried
the same two headers, and the caller's prompt ended without the reply.
`test/durable-agent-question.test.ts` and `tests/test_durable_agent_question.py`
relay a prompted agent's question to
the caller through `ask-0-0`, and checks the edge `prompt_agent` wrote from the
worker: under the served thread, under the model's call.
