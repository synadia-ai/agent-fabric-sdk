"""The envelope's lineage is a pair, adopted whole or not at all.

Neither field present: the host mints a root. Both present and
well-formed: adopted verbatim. Exactly one, or either malformed: a
malformed envelope — the §9 ``400`` frame and the terminator, no ack, and
the handler never runs — the same treatment as any other wrongly shaped
field, and the same as the TypeScript host. Completing a half pair would
file the execution under a tree the caller never named.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

import pytest

from synadia_ai.agent_fabric import fabric_tracing, is_thread_id, trace_headers
from tests.support import error_code, replies, start_host

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

THREAD = "a" * 32
ROOT = "b" * 32


async def _send(
    nc: NATSClient, agent: str, body: dict[str, Any]
) -> tuple[list[Msg], dict[str, str] | None]:
    """The frames the caller saw, and what the handler was handed —
    ``None`` when it never ran."""
    seen: list[dict[str, str]] = []

    async def handler(_env: Any, stream: Any) -> None:
        seen.append(trace_headers())
        await stream.send("ok")

    svc = await start_host(
        nc, agent, interceptors=[fabric_tracing().request_interceptor], handler=handler
    )
    try:
        frames = await replies(nc, svc.subject.prompt, json.dumps(body).encode())
    finally:
        await svc.stop()
    return frames, (seen[0] if seen else None)


@pytest.mark.parametrize(
    "body",
    [
        {"prompt": "hi", "thread_id": THREAD},
        {"prompt": "hi", "root_id": ROOT},
    ],
    ids=["thread-alone", "root-alone"],
)
async def test_a_half_pair_is_a_400_and_never_reaches_the_handler(
    nc: NATSClient, body: dict[str, Any]
) -> None:
    frames, headers = await _send(nc, "pair-half", body)
    assert headers is None, f"handler ran with a half pair: {headers}"
    assert error_code(frames) == "400"
    assert (frames[0].headers or {}).get("Nats-Service-Error") == (
        "malformed envelope: thread_id and root_id must be given together"
    )
    assert len(frames) == 2, [(dict(m.headers or {}), m.data[:60]) for m in frames]


@pytest.mark.parametrize(
    "body",
    [
        {"prompt": "hi", "thread_id": THREAD.upper(), "root_id": ROOT},
        {"prompt": "hi", "thread_id": THREAD, "root_id": ROOT[1:]},
        {"prompt": "hi", "thread_id": 7, "root_id": ROOT},
    ],
    ids=["uppercase-thread", "short-root", "numeric-thread"],
)
async def test_a_malformed_id_in_a_pair_is_a_400(nc: NATSClient, body: dict[str, Any]) -> None:
    frames, headers = await _send(nc, "pair-bad", body)
    assert headers is None, f"handler ran with a malformed id: {headers}"
    assert error_code(frames) == "400"
    assert len(frames) == 2


async def test_a_well_formed_pair_is_adopted_verbatim(nc: NATSClient) -> None:
    frames, headers = await _send(
        nc, "pair-full", {"prompt": "hi", "thread_id": THREAD, "root_id": ROOT}
    )
    assert error_code(frames) is None
    assert headers == {"X-Synadia-Thread-ID": THREAD, "X-Synadia-Root-ID": ROOT}


async def test_no_lineage_makes_the_host_mint_a_root(nc: NATSClient) -> None:
    frames, headers = await _send(nc, "pair-none", {"prompt": "hi"})
    assert error_code(frames) is None
    assert headers is not None
    thread = headers["X-Synadia-Thread-ID"]
    assert is_thread_id(thread)
    assert headers["X-Synadia-Root-ID"] == thread
