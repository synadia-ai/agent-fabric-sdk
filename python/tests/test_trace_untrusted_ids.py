"""A receiver adopts only well-formed lineage.

The ids a caller sends are stamped verbatim on the agent's model requests,
as header values, by :func:`~synadia_ai.agent_fabric.trace_headers`. They
are untrusted input, so an id that is not shaped like what the packages
mint is a malformed envelope: the §9 ``400`` frame and the terminator, no
ack, and the handler never runs — the same treatment as any other
wrongly-shaped field, and the same as the TypeScript host.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agent_fabric import fabric_tracing, trace_headers
from tests.support import replies, start_host

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

AGENT = "untrusted"
ROOT = "b" * 32


@pytest.mark.parametrize(
    "thread_id",
    [
        "a" * 30 + "\r\nX-Injected: yes",
        "A" * 32,
        "a" * 31,
        "a" * (1 << 16),
    ],
    ids=["header-injection", "uppercase", "short", "huge"],
)
async def test_a_malformed_thread_id_is_a_400_and_never_reaches_the_handler(
    nc: NATSClient, thread_id: str
) -> None:
    ran: list[Any] = []

    async def handler(_env: Any, stream: Any) -> None:
        ran.append(trace_headers())
        await stream.send("ok")

    svc = await start_host(
        nc, AGENT, interceptors=[fabric_tracing().request_interceptor], handler=handler
    )
    try:
        # A well-formed root alongside, so the 400 is the malformed id's
        # and not the half pair's.
        payload = json.dumps({"prompt": "hi", "thread_id": thread_id, "root_id": ROOT}).encode()
        frames = await replies(nc, svc.subject.inbox, payload)
    finally:
        await svc.stop()

    assert ran == [], f"handler ran with untrusted lineage: {ran}"
    assert len(frames) == 2, [(dict(m.headers or {}), m.data[:60]) for m in frames]
    error, terminator = frames
    assert (error.headers or {}).get("Nats-Service-Error-Code") == "400"
    assert terminator.data == b"" and not terminator.headers
