"""The prompt interceptor's first phase.

It decides everything the prompt carries and the record its second phase
publishes, and has no side effects of its own.
"""

from __future__ import annotations

from typing import Any, cast

import pytest
from synadia_ai.agents import PromptExtras, PromptInterceptorContext

from synadia_ai.agent_fabric import (
    TOOL_CALL_ID_MAX,
    TraceScope,
    bind_active_trace,
    fabric_tracing,
    is_thread_id,
)

PARENT = "c" * 32
ROOT = "d" * 32


class _Ctx:
    """Phase one needs nothing but the caller's ``context``."""

    def __init__(self, context: dict[str, object]) -> None:
        self.context = context


async def _phase_one(context: dict[str, object] | None = None) -> PromptExtras:
    interceptor = fabric_tracing().prompt_interceptor
    ctx = cast("PromptInterceptorContext", _Ctx(context or {}))
    return await interceptor.before_prompt(ctx)


def _state(extras: PromptExtras) -> Any:
    return extras.state


async def test_adds_exactly_thread_id_and_root_id_in_order_and_no_headers() -> None:
    extras = await _phase_one()
    assert list(extras.fields) == ["thread_id", "root_id"]
    assert dict(extras.headers) == {}


async def test_starts_a_tree_of_its_own_outside_a_handler() -> None:
    extras = await _phase_one()
    thread = extras.fields["thread_id"]
    assert isinstance(thread, str) and is_thread_id(thread)
    assert extras.fields["root_id"] == thread
    state = _state(extras)
    assert (state.parent_id, state.turn_count_hint, state.tool_call_id) == (None, 0, None)


async def test_inherits_root_parent_and_turn_count_from_the_ambient_scope() -> None:
    scope = TraceScope(PARENT, ROOT)
    scope.turn_count_hint[0] = 3
    with bind_active_trace(scope):
        extras = await _phase_one()
    assert extras.fields["root_id"] == ROOT
    assert extras.fields["thread_id"] != PARENT
    state = _state(extras)
    assert (state.parent_id, state.root_id, state.turn_count_hint) == (PARENT, ROOT, 3)


async def test_mints_a_fresh_thread_for_every_prompt() -> None:
    a, b = await _phase_one(), await _phase_one()
    assert a.fields["thread_id"] != b.fields["thread_id"]


async def test_takes_the_tool_call_id_from_the_prompt_context() -> None:
    extras = await _phase_one({"tool_call_id": "toolu_01"})
    assert _state(extras).tool_call_id == "toolu_01"


@pytest.mark.parametrize(
    "tool_call_id",
    ["", "a" * (TOOL_CALL_ID_MAX + 1), "call_\ud83d", 42, None],
    ids=["empty", "overlong", "lone-surrogate", "number", "none"],
)
async def test_drops_a_bad_tool_call_id_and_still_prompts(tool_call_id: object) -> None:
    """Tracing is best-effort: a bad tool call id never stops a prompt."""
    extras = await _phase_one({"tool_call_id": tool_call_id})
    assert _state(extras).tool_call_id is None
    thread = extras.fields["thread_id"]
    assert isinstance(thread, str) and is_thread_id(thread)


async def test_ignores_the_camel_case_key_which_is_typescripts() -> None:
    extras = await _phase_one({"toolCallId": "toolu_01"})
    assert _state(extras).tool_call_id is None
