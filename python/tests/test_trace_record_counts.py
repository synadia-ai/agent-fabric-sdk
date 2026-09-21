"""The fabric counts the trace records it published and the ones it could not.

A record that was never published leaves nothing behind, so the fabric
counts it itself: for the whole process, and the host reports both
numbers on its heartbeat as ``records_published`` and
``records_dropped``. The counters are process-wide, so every assertion
here is on the delta across one prompt. The TypeScript package counts the
same events.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import Agent, Identity, signer_from_seed

from synadia_ai.agent_fabric import TraceOptions, fabric_tracing, trace_record_counts
from tests.support import answer_prompts, capture, drain, make_agent_info

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.conftest import ConnectNkeyUser
    from tests.harness.nats_server import RunningServer
    from tests.support import NkeyUser

SUBJECT = "count.prompt"


def _agent(nc: NATSClient, seed: str | None, edge_subject: str | None = "TRACE.edges") -> Agent:
    return Agent(
        nc,
        make_agent_info(SUBJECT),
        identity=Identity(signer=signer_from_seed(seed)) if seed is not None else None,
        interceptors=[fabric_tracing(TraceOptions(edge_subject=edge_subject)).prompt_interceptor],
    )


async def test_a_record_handed_to_the_connection_counts_as_published(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await answer_prompts(nc, SUBJECT)
    before = trace_record_counts()
    await drain(_agent(nc, identity_keys["alice"].seed).prompt("hi"))
    after = trace_record_counts()
    assert after.published - before.published == 1
    assert after.dropped - before.dropped == 0


async def test_a_record_due_without_an_identity_counts_as_dropped_and_warns_once(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    caplog: pytest.LogCaptureFixture,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await answer_prompts(nc, SUBJECT)
    traces = await capture(nc, "TRACE.>")
    before = trace_record_counts()
    with caplog.at_level(logging.WARNING, logger="synadia_ai.agent_fabric"):
        await drain(_agent(nc, None).prompt("hi"))
        await drain(_agent(nc, None).prompt("hi"))
    after = trace_record_counts()
    await asyncio.sleep(0.2)
    assert after.published - before.published == 0
    assert after.dropped - before.dropped == 2
    assert traces == []
    # One warning per connection: a per-prompt log would itself disturb the agent.
    warned = [r for r in caplog.records if "no identity signer" in r.getMessage()]
    assert len(warned) == 1


async def test_nothing_is_counted_for_an_unsigned_prompt_that_never_goes_out(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    before = trace_record_counts()
    _agent(nc, None).prompt("hi")  # never iterated
    await asyncio.sleep(0.1)
    assert trace_record_counts() == before


async def test_a_record_whose_publish_raised_counts_as_dropped(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Fail-open: the record is dropped and counted, the prompt still goes out."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    prompts: list[str] = []
    await answer_prompts(nc, SUBJECT, prompts)
    real_publish = nc.publish

    async def failing(subject: str, *args: Any, **kwargs: Any) -> None:
        if subject == "TRACE.edges":
            raise RuntimeError("connection draining")
        await real_publish(subject, *args, **kwargs)

    monkeypatch.setattr(nc, "publish", failing)
    before = trace_record_counts()
    await drain(_agent(nc, identity_keys["alice"].seed).prompt("hi"))
    after = trace_record_counts()
    assert after.published - before.published == 0
    assert after.dropped - before.dropped == 1
    assert prompts == ["prompt"]


async def test_nothing_is_counted_in_propagate_only_mode(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    """No record is due, so none is published and none is dropped."""
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await answer_prompts(nc, SUBJECT)
    before = trace_record_counts()
    await drain(_agent(nc, identity_keys["alice"].seed, edge_subject=None).prompt("hi"))
    await drain(_agent(nc, None, edge_subject=None).prompt("hi"))
    assert trace_record_counts() == before


async def test_publishes_to_a_configured_subject(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    nc = await connect_nkey_user(nats_server_nkey, "alice")
    await answer_prompts(nc, SUBJECT)
    custom = await capture(nc, "acme.TRACE.edges.v2")
    await drain(_agent(nc, identity_keys["alice"].seed, "acme.TRACE.edges.v2").prompt("hi"))
    await asyncio.sleep(0.2)
    assert len(custom) == 1
