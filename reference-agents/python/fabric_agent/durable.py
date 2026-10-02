"""durable.py — a durable workflow the model can start, joined to the task that started it.

``synadia-durable`` runs workflows on NATS: each step is journaled, and a run
survives a restart of the agent by replaying what its journal holds. This
agent registers one workflow, ``durable-task``, of two steps:

    ask-model     one model call through the proxy, with the two trace
                  headers taken from the run's input, so the call lands on
                  the thread of the prompt that started the run
    write-result  the step's answer written into the run's result

and offers the model one more tool, ``run_durable_task``, that starts a run
and waits for its result.

The run joins the task that started it by its id: the fabric package's
``durable_run_id(tool_call_id)`` is ``<thread_id>-<tool call id>``, the
served thread and the model's call. A step runs on the worker, outside the
prompt's trace context, so the trace travels in the run's input
(``durable_trace()``) and comes back as headers inside the step
(``durable_headers()``).

The library's seven JetStream resources are the tenant's: the fabric's
onboarding creates them in the account, sized to its tier. The worker and the
client are given no sizing and no replicas, so starting them creates nothing
and changes nothing; they find what is there.

The same as ``typescript/src/durable.ts``: the same workflow name and steps,
the same tool in the same words, the same result.
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

#: The workflow's name: a subject token and a consumer name to the library.
DURABLE_WORKFLOW = "durable-task"

#: The tool the model sees.
RUN_DURABLE_TASK = "run_durable_task"

#: What the model reads about the tool; word for word the TypeScript agent's.
RUN_DURABLE_TASK_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": RUN_DURABLE_TASK,
        "description": (
            "Runs a task as a durable workflow on this agent: each step is journaled, so the work survives a restart "
            "and is not done twice. Use it when the prompt asks for durable work. Give the task in words; "
            "the result is the workflow's answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {"task": {"type": "string", "description": "The task, in words."}},
            "required": ["task"],
        },
        "strict": False,
    },
}

#: What the step tells the model.
DURABLE_STEP_INSTRUCTION = "Carry out the task you are given. Answer briefly, in plain text."


def durable_task_workflow(model: ModelClient) -> Workflow[dict[str, Any], dict[str, str]]:
    """The workflow, over this agent's model client.

    Its input is ``{"task": …, "trace": …}``: the task, and the trace of the
    prompt that started it, under a key of this agent's choosing. Its result
    is ``{"task": …, "answer": …}``.
    """

    async def run(ctx: Ctx, input: dict[str, Any]) -> dict[str, str]:
        task = str(input["task"])

        # Step one: the model, with the trace headers from the input. The step
        # runs outside the prompt's context, where ``trace_headers()`` has nothing.
        async def ask_model() -> str:
            messages: list[ChatMessage] = [
                {"role": "system", "content": DURABLE_STEP_INSTRUCTION},
                {"role": "user", "content": task},
            ]
            completion = await model.complete(messages, [], durable_headers(input.get("trace")))
            return str(completion.message.get("content") or "")

        answer: str = await ctx.run("ask-model", ask_model)
        # Step two: the answer, written into the result.
        result: dict[str, str] = await ctx.run("write-result", lambda: {"task": task, "answer": answer})
        return result

    return define_workflow(DURABLE_WORKFLOW, run)


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
    """Start the worker, which binds its two durable consumers and nothing else."""
    workflow = durable_task_workflow(model)
    worker = create_worker(nc, [workflow], logger=_LibraryLogger(log))
    await worker.start()
    client = create_client(nc)

    async def run(args: Any, tool_call_id: str) -> str:
        try:
            parsed = json.loads(args) if isinstance(args, str) else args
            task = parsed.get("task") if isinstance(parsed, dict) else None
            if not isinstance(task, str) or not task.strip():
                raise ValueError("task is required")
        except ValueError as err:
            return json.dumps({"error": f"run_durable_task: {err}"})
        try:
            # (5) The run joins the task that started it: its id names the
            # served thread and this tool call, and its input carries the
            # trace. Outside a traced prompt there is no thread to name, and
            # the run joins no task.
            run_id = durable_run_id(tool_call_id) or f"{DURABLE_WORKFLOW}-{uuid.uuid4()}"
            trace = durable_trace()
            run_input: dict[str, Any] = {"task": task, **({"trace": trace} if trace is not None else {})}
            handle = await client.start(workflow, run_input, StartOptions(run_id=run_id))
            log(f"durable run {run_id} started")
            result = await handle.result(timeout_ms=result_timeout_s * 1000)
            return json.dumps({"run_id": run_id, **result})
        except Exception as err:  # noqa: BLE001 — told to the model in words
            return json.dumps({"error": f"run_durable_task: {err}"})

    return DurableTasks(definition=RUN_DURABLE_TASK_TOOL, _run=run, _stop=worker.stop)


class _WithDurableTasks:
    def __init__(self, runner: ToolRunner, durable: DurableTasks) -> None:
        self.definitions = [*runner.definitions, durable.definition]
        self._runner = runner
        self._durable = durable

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        if name == RUN_DURABLE_TASK:
            return await self._durable.run(args, tool_call_id)
        return await self._runner.call(name, args, tool_call_id)


def with_durable_tasks(runner: ToolRunner, durable: DurableTasks) -> ToolRunner:
    """The tool runner with ``run_durable_task`` next to the tools it already has."""
    return _WithDurableTasks(runner, durable)


class _LibraryLogger:
    """The library's log lines, to the agent's ``log``; debug is left out."""

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
    "DURABLE_WORKFLOW",
    "RUN_DURABLE_TASK",
    "RUN_DURABLE_TASK_TOOL",
    "DurableTasks",
    "durable_task_workflow",
    "start_durable_tasks",
    "with_durable_tasks",
]
