"""A durable run joins the task that started it by its id and by its input's trace.

``durable_run_id`` and ``durable_trace`` build both inside a traced handler;
``durable_headers`` turns the trace back into the proxy's headers inside a
step, where no scope is bound.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    ROOT_ID_HEADER,
    THREAD_ID_HEADER,
    TOOL_CALL_ID_MAX,
    TraceScope,
    active_trace,
    bind_active_trace,
    durable_headers,
    durable_run_id,
    durable_trace,
    trace_headers,
    with_durable_trace,
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


def test_with_durable_trace_binds_the_trace_with_the_turn_count() -> None:
    trace = {"thread_id": THREAD, "root_id": ROOT}
    with with_durable_trace(trace, 3):
        scope = active_trace()
        assert scope is not None
        assert (scope.thread_id, scope.root_id, scope.turn_count_hint[0]) == (THREAD, ROOT, 3)
        assert trace_headers() == durable_headers(trace)
        assert scope.turn_count_hint[0] == 4
    assert active_trace() is None


async def test_with_durable_trace_follows_awaits() -> None:
    with with_durable_trace({"thread_id": THREAD, "root_id": ROOT}, 1):
        await asyncio.sleep(0)
        scope = active_trace()
    assert scope is not None and scope.thread_id == THREAD


@pytest.mark.parametrize(
    "trace", [None, {"thread_id": THREAD}, {"thread_id": "x", "root_id": ROOT}]
)
def test_with_durable_trace_binds_nothing_for_no_trace_or_a_bad_one(trace: Any) -> None:
    with with_durable_trace(trace, 0):
        assert active_trace() is None


@pytest.mark.parametrize("bad", [-1, 1.5, True])
def test_with_durable_trace_refuses_a_bad_turn_count(bad: Any) -> None:
    with (
        pytest.raises(ValueError, match="with_durable_trace"),
        with_durable_trace({"thread_id": THREAD, "root_id": ROOT}, bad),
    ):
        pass
