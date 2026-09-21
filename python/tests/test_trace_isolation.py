"""One execution's trace must stay its own.

The ambient scope is bound per request and must not survive it, be shared
with a concurrent request, or carry its turn count into the next one.
Work spawned inside a handler is the deliberate exception: a tool running
as its own task belongs to the same execution and counts against it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from synadia_ai.agents import Agents

from synadia_ai.agent_fabric import active_trace, fabric_tracing, trace_headers
from tests.support import drain, handle_of, start_host

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


async def _serve(
    nc: NATSClient,
    agent: str,
    on_prompt: Callable[[], Awaitable[None]],
    prompts: Callable[[Callable[[], Awaitable[Any]]], Awaitable[Any]],
) -> None:
    async def handler(_env: Any, stream: Any) -> None:
        await on_prompt()
        await stream.send("ok")

    svc = await start_host(
        nc, agent, interceptors=[fabric_tracing().request_interceptor], handler=handler
    )
    client = Agents(nc=nc)
    try:
        handle = await handle_of(client, agent)
        await prompts(lambda: drain(handle.prompt("hi")))
        await asyncio.sleep(0.1)
    finally:
        await svc.stop()
        await client.close()


async def test_scope_does_not_leak_between_requests(nc: NATSClient) -> None:
    seen: list[str] = []

    async def on_prompt() -> None:
        scope = active_trace()
        assert scope is not None
        seen.append(scope.thread_id)
        await asyncio.sleep(0.02)  # yield mid-handler
        after = active_trace()
        assert after is not None and after.thread_id == scope.thread_id, "scope changed mid-handler"

    async def three(prompt: Callable[[], Awaitable[Any]]) -> None:
        for _ in range(3):
            await prompt()

    await _serve(nc, "iso", on_prompt, three)
    assert len(seen) == 3, seen
    assert len(set(seen)) == 3, f"threads repeated across requests: {seen}"
    assert active_trace() is None, "scope leaked outside the handler"


async def test_turn_counter_is_per_request(nc: NATSClient) -> None:
    counts: list[int] = []

    async def on_prompt() -> None:
        trace_headers()
        trace_headers()
        scope = active_trace()
        assert scope is not None
        counts.append(scope.turn_count_hint[0])

    async def three(prompt: Callable[[], Awaitable[Any]]) -> None:
        for _ in range(3):
            await prompt()

    await _serve(nc, "iso2", on_prompt, three)
    assert counts == [2, 2, 2], f"turn counter carried across requests: {counts}"


async def test_concurrent_requests_do_not_share_a_scope(nc: NATSClient) -> None:
    pairs: list[tuple[str, str]] = []

    async def on_prompt() -> None:
        before = active_trace().thread_id  # type: ignore[union-attr]
        await asyncio.sleep(0.15)  # overlap with the other requests
        after = active_trace().thread_id  # type: ignore[union-attr]
        pairs.append((before, after))

    async def concurrently(prompt: Callable[[], Awaitable[Any]]) -> None:
        await asyncio.gather(prompt(), prompt(), prompt())

    await _serve(nc, "conc", on_prompt, concurrently)
    assert len(pairs) == 3, pairs
    for before, after in pairs:
        assert before == after, f"scope changed under a concurrent request: {before} -> {after}"
    assert len({p[0] for p in pairs}) == 3, f"threads shared across concurrent requests: {pairs}"


async def test_task_spawned_inside_the_handler_shares_the_scope(nc: NATSClient) -> None:
    seen: dict[str, Any] = {}

    async def on_prompt() -> None:
        trace_headers()

        async def tool() -> None:
            # A tool running as its own task must count against the same
            # execution and see the same thread.
            seen["headers"] = trace_headers()
            seen["thread"] = active_trace().thread_id  # type: ignore[union-attr]

        await asyncio.create_task(tool())
        seen["count"] = active_trace().turn_count_hint[0]  # type: ignore[union-attr]
        seen["outer_thread"] = active_trace().thread_id  # type: ignore[union-attr]

    async def once(prompt: Callable[[], Awaitable[Any]]) -> None:
        await prompt()

    await _serve(nc, "spawn", on_prompt, once)
    assert seen["thread"] == seen["outer_thread"], seen
    assert seen["count"] == 2, f"spawned task did not count against the execution: {seen}"
