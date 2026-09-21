"""Tracing must be entirely opt-in.

A host that does not run the fabric's request interceptor behaves exactly
as the protocol SDK does alone: no ids minted per request, no ambient
scope bound, and — the one with teeth — no trace headers handed to the
harness, which would stamp them on model requests going to a third party
the operator never opted into.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from typing import TYPE_CHECKING, Any

from synadia_ai.agent_service import RequestInterceptor
from synadia_ai.agents import Agents, PromptInterceptor

from synadia_ai.agent_fabric import TraceOptions, active_trace, fabric_tracing, trace_headers
from tests.support import capture, drain, handle_of, start_host

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


async def _run(
    nc: NATSClient,
    agent: str,
    *,
    host_side: Sequence[RequestInterceptor],
    caller_side: Sequence[PromptInterceptor],
) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    async def handler(_env: Any, stream: Any) -> None:
        seen["headers"] = trace_headers()
        seen["scope"] = active_trace()
        await stream.send("ok")

    svc = await start_host(nc, agent, interceptors=host_side, handler=handler)
    prompts = await capture(nc, svc.subject.prompt)
    client = Agents(nc=nc, interceptors=caller_side)
    try:
        await drain((await handle_of(client, agent)).prompt("hi"))
        await asyncio.sleep(0.1)
    finally:
        await svc.stop()
        await client.close()
    seen["sent"] = json.loads(prompts[0].data)
    return seen


async def test_untraced_agent_hands_out_no_trace_headers(nc: NATSClient) -> None:
    seen = await _run(nc, "optout", host_side=(), caller_side=())
    assert seen["headers"] == {}
    assert seen["scope"] is None, "an untraced host still bound an ambient scope"
    assert seen["sent"] == {"prompt": "hi"}


async def test_host_that_opted_in_gets_headers(nc: NATSClient) -> None:
    seen = await _run(nc, "optin", host_side=[fabric_tracing().request_interceptor], caller_side=())
    assert set(seen["headers"]) == {"X-Synadia-Thread-ID", "X-Synadia-Root-ID"}


async def test_a_host_without_the_fabric_passes_a_traced_callers_pair_through_unread(
    nc: NATSClient,
) -> None:
    """Before the split, a service that had not opted in still adopted a
    caller's pair; with the protocol SDK alone the two fields are plain
    §5.6 extras that nothing reads. A tree that starts upstream continues
    only through a host that runs the fabric's request interceptor."""
    tracing = fabric_tracing(TraceOptions(edge_subject=None))
    seen = await _run(nc, "relay", host_side=(), caller_side=[tracing.prompt_interceptor])
    assert list(seen["sent"]) == ["prompt", "thread_id", "root_id"]
    assert seen["headers"] == {}
    assert seen["scope"] is None
