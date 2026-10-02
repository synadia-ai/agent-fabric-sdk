"""A durable run joins the task that started it by its id and by its input's trace.

``durable_run_id`` and ``durable_trace`` build both inside a traced handler;
``durable_headers`` turns the trace back into the proxy's headers inside a
step, where no scope is bound.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    ROOT_ID_HEADER,
    THREAD_ID_HEADER,
    TOOL_CALL_ID_MAX,
    TraceScope,
    bind_active_trace,
    durable_headers,
    durable_run_id,
    durable_trace,
)

THREAD, ROOT = "a" * 32, "b" * 32


def _scope() -> TraceScope:
    return TraceScope(thread_id=THREAD, root_id=ROOT)


def test_the_run_id_names_the_served_thread_and_the_tool_call() -> None:
    with bind_active_trace(_scope()):
        assert durable_run_id("call_Ab-9") == f"{THREAD}-call_Ab-9"


def test_every_character_outside_the_set_becomes_an_underscore_one_per_code_point() -> None:
    with bind_active_trace(_scope()):
        run_id = durable_run_id("toolu.1*>x y\u00e9\U0001f642")
    assert run_id == f"{THREAD}-toolu_1__x_y__"


def test_no_run_id_outside_a_traced_handler() -> None:
    assert durable_run_id("call_1") is None


@pytest.mark.parametrize("bad", ["", "x" * (TOOL_CALL_ID_MAX + 1), "a\ud800"])
def test_an_empty_overlong_or_invalid_tool_call_id_is_an_error(bad: str) -> None:
    with pytest.raises(ValueError, match="durable_run_id"):
        durable_run_id(bad)
    with bind_active_trace(_scope()), pytest.raises(ValueError, match="durable_run_id"):
        durable_run_id(bad)


def test_the_trace_is_the_active_pair_thread_then_root() -> None:
    scope = _scope()
    with bind_active_trace(scope):
        trace = durable_trace()
    wire = json.dumps(trace, separators=(",", ":"))
    assert wire == f'{{"thread_id":"{THREAD}","root_id":"{ROOT}"}}'
    # It starts no model call, so it counts no turn.
    assert scope.turn_count_hint[0] == 0


def test_no_trace_outside_a_traced_handler() -> None:
    assert durable_trace() is None


def test_the_headers_come_from_the_trace_outside_any_scope() -> None:
    assert durable_headers({"thread_id": THREAD, "root_id": ROOT}) == {
        THREAD_ID_HEADER: THREAD,
        ROOT_ID_HEADER: ROOT,
    }


def test_the_trace_round_trips_through_a_run_input() -> None:
    with bind_active_trace(_scope()):
        payload = json.dumps({"task": "t", "trace": durable_trace()})
    assert durable_headers(json.loads(payload)["trace"]) == {
        THREAD_ID_HEADER: THREAD,
        ROOT_ID_HEADER: ROOT,
    }


@pytest.mark.parametrize(
    "trace",
    [
        None,
        "x",
        {},
        {"thread_id": THREAD},
        {"thread_id": THREAD, "root_id": 7},
        {"thread_id": THREAD.upper(), "root_id": ROOT},
        {"thread_id": f"{THREAD}\r\nX-Evil: 1", "root_id": ROOT},
    ],
)
def test_no_headers_for_no_trace_or_one_not_shaped_like_thread_ids(trace: Any) -> None:
    assert durable_headers(trace) == {}
