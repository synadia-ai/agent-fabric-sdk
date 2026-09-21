"""``trace_headers()`` is what a handler stamps on every model request.

The two headers the model proxy files the call under, and a turn counted
against the execution for the edges of the threads it spawns later.
"""

from __future__ import annotations

import asyncio

from synadia_ai.agent_fabric import (
    ROOT_ID_HEADER,
    THREAD_ID_HEADER,
    TraceScope,
    active_trace,
    bind_active_trace,
    trace_headers,
)

THREAD = "a" * 32
ROOT = "b" * 32


def test_empty_outside_a_traced_handler() -> None:
    assert active_trace() is None
    assert trace_headers() == {}


def test_the_two_headers_of_the_bound_scope() -> None:
    with bind_active_trace(TraceScope(THREAD, ROOT)):
        headers = trace_headers()
    assert headers == {"X-Synadia-Thread-ID": THREAD, "X-Synadia-Root-ID": ROOT}
    assert (THREAD_ID_HEADER, ROOT_ID_HEADER) == ("X-Synadia-Thread-ID", "X-Synadia-Root-ID")


def test_every_call_counts_a_turn() -> None:
    scope = TraceScope(THREAD, ROOT)
    with bind_active_trace(scope):
        trace_headers()
        trace_headers()
        trace_headers()
    assert scope.turn_count_hint == [3]


async def test_a_task_spawned_inside_the_scope_counts_against_it() -> None:
    scope = TraceScope(THREAD, ROOT)
    with bind_active_trace(scope):
        trace_headers()

        async def tool() -> dict[str, str]:
            await asyncio.sleep(0)
            return trace_headers()

        seen = await asyncio.create_task(tool())
    assert seen == {"X-Synadia-Thread-ID": THREAD, "X-Synadia-Root-ID": ROOT}
    assert scope.turn_count_hint == [2]


def test_nothing_is_left_behind_once_the_binding_exits() -> None:
    with bind_active_trace(TraceScope(THREAD, ROOT)):
        pass
    assert active_trace() is None
    assert trace_headers() == {}


async def test_concurrent_executions_stay_apart() -> None:
    scopes = [TraceScope(d * 32, d * 32) for d in "123"]

    async def run(i: int) -> tuple[TraceScope | None, TraceScope | None]:
        with bind_active_trace(scopes[i]):
            before = active_trace()
            await asyncio.sleep(0.01 * (3 - i))
            for _ in range(i + 1):
                trace_headers()
            return before, active_trace()

    seen = await asyncio.gather(run(0), run(1), run(2))
    for i, (before, after) in enumerate(seen):
        assert before is scopes[i] and after is scopes[i]
    assert [s.turn_count_hint[0] for s in scopes] == [1, 2, 3]
