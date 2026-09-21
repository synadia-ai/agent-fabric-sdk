"""A relay that forwards the envelope it received spawns a thread; it never continues one.

The most natural relay code hands what it received straight to a
sub-agent. That envelope names this execution's own thread; a subprompt
filed under it would collapse two executions into one and record an edge
from a thread to itself. The protocol SDK drops an explicit envelope's
extra fields when it prompts, so the fabric's prompt interceptor mints the
child's thread under the ambient root, as for any other prompt.

Ported from the pre-split ``test_trace_lineage_override.py``. The cases
there in which an explicit ``Envelope`` *chose* the lineage it was sent
with have no counterpart: a prompt interceptor sees the prompt text and
``context``, never the envelope handed to ``prompt()``, and the SDK drops
that envelope's extras (see the README, "What the hooks do not carry").
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from synadia_ai.agents import Agent, Envelope

from synadia_ai.agent_fabric import TraceScope, bind_active_trace, fabric_tracing
from tests.support import answer_prompts, capture, drain, make_agent_info

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


async def test_an_untraced_client_drops_the_envelope_lineage(nc: NATSClient) -> None:
    """With tracing off nothing of it is on the wire, even when the envelope
    handed in carries lineage — an untraced relay forwarding what it
    received sends a plain v0.3 envelope."""
    data = await _send(nc, Envelope(prompt="hi", thread_id=THREAD, root_id=ROOT), traced=False)
    assert data == b'{"prompt":"hi"}'


async def test_an_untraced_client_drops_the_lineage_even_inside_a_traced_handler(
    nc: NATSClient,
) -> None:
    """A client without the fabric's prompt interceptor, used inside a
    traced handler, stays untraced and must not forward the parent's
    thread to the sub-agent."""
    incoming = Envelope(prompt="hi", thread_id=AMBIENT_THREAD, root_id=AMBIENT_ROOT)
    with bind_active_trace(TraceScope(AMBIENT_THREAD, AMBIENT_ROOT)):
        data = await _send(nc, incoming, traced=False)
    assert data == b'{"prompt":"hi"}'
