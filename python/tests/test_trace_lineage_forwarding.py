"""A relay forwarding its envelope: traced, it spawns a thread; untraced, it passes the lineage on.

The most natural relay code hands what it received straight to a
sub-agent. That envelope names this execution's own thread; a subprompt
filed under it would collapse two executions into one and record an edge
from a thread to itself. The protocol SDK sends an explicit envelope's
extra fields with it, since a relay must preserve them (§5.6), and a
prompt interceptor's field of the same name replaces one. So a traced
relay spawns a child thread under the ambient root, as for any other
prompt; an untraced relay sends the parent's ``thread_id`` and
``root_id`` on, and a traced receiver adopts them. So every client in a
traced agent gets the fabric's prompt interceptor.

Ported from the pre-split ``test_trace_lineage_override.py``. The cases
there in which an explicit ``Envelope`` *chose* the lineage it was sent
with have no counterpart: the fabric's prompt interceptor mints the pair
itself, under the ambient root or as a fresh root, and never reads it from
the envelope handed to ``prompt()`` (see the README, "What the hooks do
not carry").
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING, Any

from synadia_ai.agents import Agent, Envelope

from synadia_ai.agent_fabric import TraceScope, active_trace, bind_active_trace, fabric_tracing
from tests.support import answer_prompts, capture, drain, make_agent_info, start_host

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

PROMPT_SUBJECT = "lineage.prompt"
THREAD = "a" * 32
ROOT = "b" * 32
AMBIENT_THREAD = "c" * 32
AMBIENT_ROOT = "d" * 32


async def _send(nc: NATSClient, envelope: Envelope, *, traced: bool = True) -> bytes:
    await answer_prompts(nc, PROMPT_SUBJECT)
    seen = await capture(nc, PROMPT_SUBJECT)
    interceptors = [fabric_tracing().prompt_interceptor] if traced else []
    agent = Agent(nc, make_agent_info(PROMPT_SUBJECT), interceptors=interceptors)
    await drain(agent.prompt(envelope))
    await asyncio.sleep(0.1)
    return seen[0].data


async def test_forwarding_the_incoming_envelope_spawns_a_new_thread(nc: NATSClient) -> None:
    incoming = Envelope(prompt="hi", thread_id=AMBIENT_THREAD, root_id=AMBIENT_ROOT)
    with bind_active_trace(TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)):
        sent = json.loads(await _send(nc, incoming))
    assert sent["thread_id"] != AMBIENT_THREAD, "sub-agent filed under its parent's thread"
    assert sent["root_id"] == AMBIENT_ROOT


async def test_forwarding_an_envelope_with_only_the_thread_spawns_too(nc: NATSClient) -> None:
    with bind_active_trace(TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)):
        sent = json.loads(await _send(nc, Envelope(prompt="hi", thread_id=AMBIENT_THREAD)))
    assert sent["thread_id"] != AMBIENT_THREAD
    assert sent["root_id"] == AMBIENT_ROOT


async def test_an_envelopes_own_lineage_outside_a_handler_starts_a_fresh_root(
    nc: NATSClient,
) -> None:
    sent = json.loads(await _send(nc, Envelope(prompt="hi", thread_id=THREAD, root_id=ROOT)))
    assert sent["thread_id"] not in (THREAD, ROOT)
    assert sent["root_id"] == sent["thread_id"]


async def test_an_untraced_client_sends_the_envelopes_lineage_on(nc: NATSClient) -> None:
    """With tracing off the client adds nothing, and the SDK sends the
    envelope's extra fields as they are: an untraced relay forwarding
    what it received sends its lineage verbatim."""
    data = await _send(nc, Envelope(prompt="hi", thread_id=THREAD, root_id=ROOT), traced=False)
    assert data == f'{{"prompt":"hi","thread_id":"{THREAD}","root_id":"{ROOT}"}}'.encode()


async def test_an_untraced_client_inside_a_traced_handler_sends_the_parents_lineage_on(
    nc: NATSClient,
) -> None:
    """A client without the fabric's prompt interceptor, used inside a
    traced handler, stays untraced: it forwards the parent's thread to the
    sub-agent, not a child of it."""
    incoming = Envelope(prompt="hi", thread_id=AMBIENT_THREAD, root_id=AMBIENT_ROOT)
    with bind_active_trace(TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)):
        data = await _send(nc, incoming, traced=False)
    assert data == (
        f'{{"prompt":"hi","thread_id":"{AMBIENT_THREAD}","root_id":"{AMBIENT_ROOT}"}}'.encode()
    )


async def test_a_traced_receiver_files_an_untraced_relays_child_under_the_parents_thread(
    nc: NATSClient,
) -> None:
    """The consequence: the sub-agent adopts the pair it was sent, so the
    child execution runs as the parent's own thread — two executions under
    one ID, and no edge between them."""
    adopted: list[TraceScope | None] = []

    async def handler(_env: Any, stream: Any) -> None:
        adopted.append(active_trace())
        await stream.send("ok")

    svc = await start_host(
        nc, "lineage-child", interceptors=[fabric_tracing().request_interceptor], handler=handler
    )
    try:
        agent = Agent(nc, make_agent_info(svc.subject.prompt))
        incoming = Envelope(prompt="hi", thread_id=AMBIENT_THREAD, root_id=AMBIENT_ROOT)
        with bind_active_trace(TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)):
            assert await drain(agent.prompt(incoming)) == ["ok"]
    finally:
        await svc.stop()
    assert adopted == [TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)]
