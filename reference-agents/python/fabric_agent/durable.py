"""durable.py — durable work delegated by the model: the workflows this process hosts, and the tool that starts one.

``synadia-durable`` runs workflows on NATS: each step is journaled, and a run
survives a restart of the agent by replaying what its journal holds. An agent
whose own model loop is not durable can still hand a job to a workflow: the
model calls ``start_workflow`` with a workflow's name and its input, and gets
back the run id and the result. The workflows are the ones this process
hosts, in a small registry (:func:`hosted_workflows`); a worker on the agent's
connection runs them.

One is registered here, a demo, ``durable-task``, of two steps:

    ask-model     one model call through the proxy, with the two trace
                  headers taken from the run's input, so the call lands on
                  the thread of the prompt that started the run
    write-result  the step's answer written into the run's result

The run joins the tool call that started it by its id: the fabric package's
``durable_run_id(tool_call_id)`` is ``<thread_id>-<tool call id>``, the
served thread and the model's call, and the console shows the run under that
call. A step runs on the worker, outside the prompt's trace context, so the
trace travels in the run's input (``durable_trace()``) and comes back as
headers inside the step (``durable_headers()``).

The worker and the client are the thin SDK's: every call is one request to
``de.api.v1.<op>`` on the agent's own connection, and the engine owns the
journal and everything else. On the fabric the tenant's import carries the
requests to the engine; the agent creates nothing and needs no rights of its
own. The worker's first poll binds its workflow names on the engine.

An agent whose model loop is itself durable needs no such tool: its loop is
the workflow (``durable_agent.py``).

The same as ``typescript/src/durable.ts``: the same workflow, the same tool in
the same words, the same result.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from nats.aio.client import Client as NatsClient
from synadia_ai.agent_fabric import durable_headers, durable_run_id, durable_trace
from synadia_durable import Ctx, StartOptions, Workflow, create_client, create_worker, define_workflow

from .model import ChatMessage, ModelClient, ToolRunner

#: The tool the model sees.
START_WORKFLOW = "start_workflow"

#: The demo workflow's name: a subject token and a consumer name to the engine.
DURABLE_TASK = "durable-task"

#: What the demo workflow's step tells the model.
DURABLE_STEP_INSTRUCTION = "Carry out the task you are given. Answer briefly, in plain text."


@dataclass(frozen=True)
class HostedWorkflow:
    """One workflow the process hosts, as the model is told about it.

    A run's input is ``{"input": <what the model gave>, "trace": <the prompt's
    trace>}``, under keys of this agent's choosing.
    """

    name: str
    #: One line for the tool's description: what it does and the input it takes.
    description: str
    #: Why an input is refused, in words; ``None`` when it is accepted.
    check: Callable[[dict[str, Any]], str | None]
    workflow: Workflow[dict[str, Any], Any]


def durable_task_workflow(model: ModelClient) -> Workflow[dict[str, Any], dict[str, str]]:
    """The demo workflow, over this agent's model client."""

    async def run(ctx: Ctx, started: dict[str, Any]) -> dict[str, str]:
        task = str(started["input"]["task"])

        # Step one: the model, with the trace headers from the input. The step
        # runs outside the prompt's context, where ``trace_headers()`` has nothing.
        async def ask_model() -> str:
            messages: list[ChatMessage] = [
                {"role": "system", "content": DURABLE_STEP_INSTRUCTION},
                {"role": "user", "content": task},
            ]
            completion = await model.complete(messages, [], durable_headers(started.get("trace")))
            return str(completion.message.get("content") or "")

        answer: str = await ctx.run("ask-model", ask_model)
        # Step two: the answer, written into the result.
        result: dict[str, str] = await ctx.run("write-result", lambda: {"task": task, "answer": answer})
        return result

    return define_workflow(DURABLE_TASK, run)


def _check_task(input: dict[str, Any]) -> str | None:
    task = input.get("task")
    return None if isinstance(task, str) and task.strip() else "input.task is required"


def hosted_workflows(model: ModelClient) -> list[HostedWorkflow]:
    """The workflows this process hosts: the demo, ``durable-task``. Add yours here."""
    return [
        HostedWorkflow(
            name=DURABLE_TASK,
            description=(
                "carries out a task given in words with one model call, then writes the answer into its result; "
                'input {"task": "<the task>"}'
            ),
            check=_check_task,
            workflow=durable_task_workflow(model),
        )
    ]


def start_workflow_tool(workflows: list[HostedWorkflow]) -> dict[str, Any]:
    """The tool's definition, from the workflows hosted; the same words as ``durable.ts``."""
    return {
        "type": "function",
        "function": {
            "name": START_WORKFLOW,
            "description": (
                "Starts a durable workflow this agent hosts and waits for its result. Each step of a workflow is "
                "journaled, so the work survives a restart of this agent and a finished step is not done again. "
                "Use it when the prompt asks for durable work. The workflows: "
                + " ".join(f"{w.name}: {w.description}." for w in workflows)
                + " Returns the run id and the workflow's result."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "enum": [w.name for w in workflows], "description": "The workflow to start."},
                    "input": {"type": "object", "description": "The workflow's input, as its description says."},
                },
                "required": ["name", "input"],
            },
            "strict": False,
        },
    }


@dataclass
class DurableTasks:
    """The worker and the client on the agent's own connection, and the tool that starts a run."""

    definition: dict[str, Any]
    _run: Callable[[Any, str], Any]
    _stop: Callable[[], Any]

    async def run(self, args: Any, tool_call_id: str) -> str:
        """Start a run for one tool call and wait for its result; the result, or ``{"error": …}``, as JSON text."""
        result: str = await self._run(args, tool_call_id)
        return result

    async def stop(self) -> None:
        await self._stop()


async def start_durable_tasks(
    nc: NatsClient,
    model: ModelClient,
    *,
    result_timeout_s: float,
    log: Callable[[str], None],
) -> DurableTasks:
    """Start the worker, which binds two durable consumers per workflow and nothing else."""
    hosted = hosted_workflows(model)
    by_name = {w.name: w for w in hosted}
    worker = create_worker(nc, [w.workflow for w in hosted], logger=_SdkLogger(log))
    await worker.start()
    client = create_client(nc)

    def error(message: str) -> str:
        return json.dumps({"error": f"{START_WORKFLOW}: {message}"})

    async def run(args: Any, tool_call_id: str) -> str:
        try:
            parsed = json.loads(args) if isinstance(args, str) else args
        except ValueError:
            return error("the arguments are not JSON")
        name = parsed.get("name") if isinstance(parsed, dict) else None
        hosted_workflow = by_name.get(name) if isinstance(name, str) else None
        if hosted_workflow is None:
            return error(f"no workflow named {json.dumps(name)}; the workflows: {', '.join(by_name)}")
        input = parsed.get("input")
        if not isinstance(input, dict):
            return error("input must be an object")
        refused = hosted_workflow.check(input)
        if refused is not None:
            return error(refused)
        try:
            # (5) The run joins the tool call that started it: its id names the
            # served thread and this call, and its input carries the trace.
            # Outside a traced prompt there is no thread to name, and the run
            # joins no task.
            run_id = durable_run_id(tool_call_id) or f"{hosted_workflow.name}-{uuid.uuid4()}"
            trace = durable_trace()
            started: dict[str, Any] = {"input": input, **({"trace": trace} if trace is not None else {})}
            handle = await client.start(hosted_workflow.workflow, started, StartOptions(run_id=run_id))
            log(f"durable run {run_id} started")
            result = await handle.result(timeout_ms=result_timeout_s * 1000)
            return json.dumps({"run_id": run_id, "result": result})
        except Exception as err:  # noqa: BLE001 — told to the model in words
            return error(str(err))

    return DurableTasks(definition=start_workflow_tool(hosted), _run=run, _stop=worker.stop)


class _WithDurableTasks:
    def __init__(self, runner: ToolRunner, durable: DurableTasks) -> None:
        self.definitions = [*runner.definitions, durable.definition]
        self._runner = runner
        self._durable = durable

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        if name == START_WORKFLOW:
            return await self._durable.run(args, tool_call_id)
        return await self._runner.call(name, args, tool_call_id)


def with_durable_tasks(runner: ToolRunner, durable: DurableTasks) -> ToolRunner:
    """The tool runner with ``start_workflow`` next to the tools it already has."""
    return _WithDurableTasks(runner, durable)


class _SdkLogger:
    """The SDK's log lines, to the agent's ``log``; debug is left out."""

    def __init__(self, log: Callable[[str], None]) -> None:
        self._log = log

    def _line(self, message: str, fields: dict[str, Any]) -> None:
        self._log(f"[durable] {message}{' ' + json.dumps(fields, default=str) if fields else ''}")

    def debug(self, message: str, **fields: Any) -> None:
        pass

    def info(self, message: str, **fields: Any) -> None:
        self._line(message, fields)

    def warn(self, message: str, **fields: Any) -> None:
        self._line(message, fields)

    def error(self, message: str, **fields: Any) -> None:
        self._line(message, fields)


__all__ = [
    "DURABLE_STEP_INSTRUCTION",
    "DURABLE_TASK",
    "START_WORKFLOW",
    "DurableTasks",
    "HostedWorkflow",
    "durable_task_workflow",
    "hosted_workflows",
    "start_durable_tasks",
    "start_workflow_tool",
    "with_durable_tasks",
]
