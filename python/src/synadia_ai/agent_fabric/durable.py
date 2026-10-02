"""Durable runs on the Synadia Agent Fabric — how a run joins the task that started it.

Mirrors ``typescript/src/durable.ts``; the two must stay wire-identical.

The join is a convention, not a record. A run started by a tool call takes
the id ``<thread_id>-<tool call id>``: the served thread it was started
from, and the model's call that started it. Whoever reads the runs can name
the task of each without anything else being written. A model call made
inside one of the run's steps carries the two headers the model proxy
already reads, taken from the trace the run's input carries: a step runs on
a worker, outside the prompt's context, so the trace has to travel in the
input.

Nothing here depends on a durable-execution library: these are strings and
dicts an agent hands to whichever one it uses.
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

from .trace import ROOT_ID_HEADER, THREAD_ID_HEADER, active_trace, is_thread_id, valid_tool_call_id


class DurableTrace(TypedDict):
    """The served prompt's trace as a run's input carries it, in this key order."""

    thread_id: str
    root_id: str


# What a run id may hold: the durable-execution protocol uses a run id as a
# subject token and as a key, so it is held to the intersection of the two.
# A Python string is code points, so one code point is one character, as the
# TypeScript package's `u` flag makes it there.
_OUTSIDE_RUN_ID = re.compile(r"[^A-Za-z0-9_-]")


def durable_run_id(tool_call_id: str) -> str | None:
    """The run id that joins a durable run to the task that started it.

    ``<thread_id>-<tool call id>``: the active trace's thread and the
    model's tool-call id, with every character of the tool-call id outside
    ``[A-Za-z0-9_-]`` replaced by ``_``. Pass it as the run id when the run
    is started; the run's children and generations keep it as their prefix.

    ``None`` outside a traced prompt handler: there is no served thread to
    name. Pick a run id of your own then; that run joins no task.

    Raises :class:`ValueError` when the tool-call id is empty, longer than
    the trace accepts (``TOOL_CALL_ID_MAX`` code points) or not valid
    Unicode.
    """
    if not valid_tool_call_id(tool_call_id):
        raise ValueError(
            f"durable_run_id: tool call id {tool_call_id!r} is empty, too long or not valid Unicode"
        )
    scope = active_trace()
    if scope is None:
        return None
    return f"{scope.thread_id}-{_OUTSIDE_RUN_ID.sub('_', tool_call_id)}"


def durable_trace() -> DurableTrace | None:
    """The active trace as ``{"thread_id", "root_id"}``, for the run's input.

    Put it under a key of your choosing; :func:`durable_headers` turns it
    back into the proxy's headers inside a step. ``None`` outside a traced
    prompt handler.

    Unlike :func:`trace_headers`, it counts no model turn: it starts no
    model call.
    """
    scope = active_trace()
    if scope is None:
        return None
    return {"thread_id": scope.thread_id, "root_id": scope.root_id}


def durable_headers(trace: DurableTrace | dict[str, Any] | None) -> dict[str, str]:
    """The proxy's two headers from a trace a run's input carries.

    ``X-Synadia-Thread-ID`` and ``X-Synadia-Root-ID``, for a model call
    inside a step: the call then lands on the thread that started the run.

    The input is read back from the run's journal, so it is checked as
    untrusted: ``{}`` unless both ids have the shape of a thread id. ``{}``
    for ``None`` as well, so a run started outside a traced handler makes
    its model calls without the headers.
    """
    if not isinstance(trace, dict):
        return {}
    thread_id = trace.get("thread_id")
    root_id = trace.get("root_id")
    if not isinstance(thread_id, str) or not isinstance(root_id, str):
        return {}
    if not is_thread_id(thread_id) or not is_thread_id(root_id):
        return {}
    return {THREAD_ID_HEADER: thread_id, ROOT_ID_HEADER: root_id}
