"""With tracing off, the fabric must leave no trace on the wire.

Even with the package imported and a tracing object built but not
installed. Not "no edge records" — nothing at all: the prompt envelope
must be byte-identical to plain protocol 0.3, no subject outside the
normal set may be touched, and no message may carry the JetStream
de-duplication header the edge publisher uses. This is the guard that
fails the moment someone adds an unconditional publish. Propagate-only
mode adds the two envelope fields and nothing else.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING, Any

import nats
from synadia_ai.agent_service import RequestInterceptor
from synadia_ai.agents import Agents, PromptInterceptor

from synadia_ai.agent_fabric import TraceOptions, fabric_tracing, trace_headers
from tests.support import drain, handle_of, start_host

if TYPE_CHECKING:
    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer


async def _lifecycle(
    url: str,
    agent: str,
    *,
    host_side: Sequence[RequestInterceptor] = (),
    caller_side: Sequence[PromptInterceptor] = (),
    heartbeat_extras: Callable[[], Mapping[str, object]] | None = None,
) -> list[Msg]:
    """Discovery, a prompt, a status probe and shutdown."""
    nc = await nats.connect(url)
    seen: list[Msg] = []

    async def spy(msg: Msg) -> None:
        seen.append(msg)

    await nc.subscribe(">", cb=spy)
    await nc.flush()

    async def handler(_env: Any, stream: Any) -> None:
        trace_headers()  # what a harness calls before every model request
        await stream.send("ok")

    svc = await start_host(
        nc, agent, interceptors=host_side, heartbeat_extras=heartbeat_extras, handler=handler
    )
    client = Agents(nc=nc, interceptors=caller_side)
    handle = await handle_of(client, agent)
    await drain(handle.prompt("hello"))
    await handle.status()
    await asyncio.sleep(0.2)
    await svc.stop()
    await client.close()
    await nc.close()
    return seen


def _unexpected(seen: list[Msg]) -> list[str]:
    return sorted(
        {
            m.subject
            for m in seen
            if not (
                m.subject.startswith("_INBOX.")
                or m.subject.startswith("$SRV.")
                or m.subject.startswith("agents.")
            )
        }
    )


async def _untraced(url: str) -> list[Msg]:
    fabric_tracing()  # built, never installed
    return await _lifecycle(url, "silent")


async def test_no_message_reaches_a_trace_subject(nats_server: RunningServer) -> None:
    seen = await _untraced(nats_server.url)
    stray = [m.subject for m in seen if m.subject.startswith("TRACE")]
    assert stray == [], f"untraced run published to trace subjects: {stray}"


async def test_no_message_carries_a_dedup_header(nats_server: RunningServer) -> None:
    seen = await _untraced(nats_server.url)
    stray = [m.subject for m in seen if "Nats-Msg-Id" in (m.headers or {})]
    assert stray == [], f"untraced run stamped Nats-Msg-Id on: {stray}"


async def test_the_prompt_envelope_is_plain_v0_3(nats_server: RunningServer) -> None:
    seen = await _untraced(nats_server.url)
    prompts = [m for m in seen if m.subject.startswith("agents.prompt.silent.")]
    assert len(prompts) == 1
    assert prompts[0].data == b'{"prompt":"hello"}', prompts[0].data


async def test_only_the_expected_subjects_are_touched(nats_server: RunningServer) -> None:
    seen = await _untraced(nats_server.url)
    assert _unexpected(seen) == [], f"untraced run touched unexpected subjects: {_unexpected(seen)}"


async def test_propagate_only_adds_the_two_fields_and_nothing_else(
    nats_server: RunningServer,
) -> None:
    tracing = fabric_tracing(TraceOptions(edge_subject=None))
    seen = await _lifecycle(
        nats_server.url,
        "propagate",
        host_side=[tracing.request_interceptor],
        caller_side=[tracing.prompt_interceptor],
        heartbeat_extras=tracing.heartbeat_extras,
    )
    assert [m.subject for m in seen if m.subject.startswith("TRACE")] == []
    assert [m.subject for m in seen if "Nats-Msg-Id" in (m.headers or {})] == []
    assert _unexpected(seen) == []
    prompts = [m for m in seen if m.subject.startswith("agents.prompt.propagate.")]
    assert len(prompts) == 1
    assert re.fullmatch(
        rb'\{"prompt":"hello","thread_id":"([0-9a-f]{32})","root_id":"\1"\}', prompts[0].data
    ), prompts[0].data
    beats = [m for m in seen if m.subject.startswith("agents.hb.propagate.")]
    assert beats
    for beat in beats:
        assert "records_published" not in json.loads(beat.data)
