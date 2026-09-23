"""The served publisher on a real ``Agents`` client, over a nats-server in operator mode.

Real account NKEYs, so ``agent`` has the ``{account}.{user}`` form
``served.json`` requires. A turn's pair goes out signed by the client's
identity, one id three ways, ``start`` then ``end``, every record
validating against the vendored schema and counted on the process-wide
trace record counts. The counters are process-wide, so every assertion on
them is on the delta across one test. The TypeScript suite runs the same
cases.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import (
    AgentId,
    Agents,
    Identity,
    VerifiedSender,
    signer_from_creds_file,
    verify_sender,
)

from synadia_ai.agent_fabric import (
    DEFAULT_EDGE_SUBJECT,
    ServedPublisher,
    TraceScope,
    served_publisher,
    trace_record_counts,
    unix_seconds,
)
from tests.harness.nats_server import identity_fixture
from tests.support import capture, served_schema_errors

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectCreds
    from tests.harness.nats_server import RunningServer

CREDS = identity_fixture("operator/alice.creds")
_OP_KEYS = json.loads(identity_fixture("operator/keys.json").read_text(encoding="utf-8"))
ALICE_ID = AgentId.new(_OP_KEYS["accounts"]["ACME"]["public"], _OP_KEYS["users"]["alice"]["public"])

THREAD = "a" * 32
ROOT = "c" * 32
TRACE_ID = "9f2c4b1e8a7d33051c6e0b42d78a91f0"
SESSION = "317f624b-c7c6-4b27-936b-c0de80892e6d"
LOGGER = "synadia_ai.agent_fabric"


def scope(thread_id: str = THREAD) -> TraceScope:
    return TraceScope(thread_id, ROOT)


class Rig:
    """A connection as alice, an observer on ``TRACE.>``, and publishers over fresh clients."""

    def __init__(self, nc: NATSClient, seen: list[Msg]) -> None:
        self.nc = nc
        self.seen = seen
        self.clients: list[Agents] = []

    def publisher(self, *, signed: bool = True, subject: str | None = None) -> ServedPublisher:
        identity = Identity(signer=signer_from_creds_file(CREDS)) if signed else None
        agents = Agents(nc=self.nc, identity=identity)
        self.clients.append(agents)
        kwargs: dict[str, Any] = {} if subject is None else {"subject": subject}
        return served_publisher(agents, **kwargs)

    async def settled(self, publisher: ServedPublisher) -> list[dict[str, Any]]:
        """The records the observer saw, in arrival order, after the publisher flushed."""
        await publisher.flush()
        await asyncio.sleep(0.2)
        return [json.loads(m.data) for m in self.seen]

    async def close(self) -> None:
        for client in self.clients:
            await client.close()


@pytest.fixture
async def rig(nats_server_operator: RunningServer, connect_creds: ConnectCreds) -> Any:
    nc = await connect_creds(nats_server_operator, CREDS)
    observer = await connect_creds(nats_server_operator, CREDS)
    seen = await capture(observer, "TRACE.>")
    r = Rig(nc, seen)
    try:
        yield r
    finally:
        await r.close()


async def test_publishes_the_pair_signed_as_its_writer_with_one_id_three_ways(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    p = rig.publisher()
    assert p.subject == DEFAULT_EDGE_SUBJECT
    before = trace_record_counts()
    arrived = unix_seconds()
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        turn = p.begin_turn(scope(), "openclaw")
        turn.bind(TRACE_ID)
        turn.settle("ok")
        records = await rig.settled(p)

    assert [m.subject for m in rig.seen] == ["TRACE.edges", "TRACE.edges"]
    assert [r["phase"] for r in records] == ["start", "end"]
    start, end = records
    assert start["version"] == 1
    assert start["kind"] == "served"
    assert start["agent"] == str(ALICE_ID)
    assert (start["thread_id"], start["root_id"]) == (THREAD, ROOT)
    assert (start["harness"], start["harness_thread_id"]) == ("openclaw", TRACE_ID)
    assert "status" not in start
    assert start["ts"] >= arrived
    assert end["agent"] == str(ALICE_ID)
    assert (end["thread_id"], end["root_id"]) == (THREAD, ROOT)
    assert (end["harness"], end["harness_thread_id"]) == ("openclaw", TRACE_ID)
    assert (end["phase"], end["status"]) == ("end", "ok")
    assert end["ts"] >= start["ts"]
    assert start["record_id"] != end["record_id"]
    for record in records:
        assert served_schema_errors(record) == []
    for msg in rig.seen:
        record = json.loads(msg.data)
        # Stored mode, as the reader verifies: the signature over the short
        # form the writer published to.
        sender = verify_sender(msg, "stored")
        assert isinstance(sender, VerifiedSender)
        assert sender.id == ALICE_ID
        assert sender.header.nonce == record["record_id"]
        assert (msg.headers or {})["Nats-Msg-Id"] == record["record_id"]
    after = trace_record_counts()
    assert after.published - before.published == 2
    assert after.dropped - before.dropped == 0
    assert caplog.records == []


async def test_stamps_start_with_the_arrival_and_end_with_the_moment_given(rig: Rig) -> None:
    p = rig.publisher()
    arrived = unix_seconds()
    turn = p.begin_turn(scope(), "claude")
    await asyncio.sleep(1.1)
    turn.bind(SESSION)
    turn.settle("error", 1_700_000_500.999)
    start, end = await rig.settled(p)
    assert start["ts"] <= arrived + 1
    assert (end["harness"], end["status"], end["ts"]) == ("claude", "error", 1_700_000_500)


async def test_keeps_the_records_in_the_order_they_were_due_across_interleaved_turns(
    rig: Rig,
) -> None:
    p = rig.publisher()
    a = p.begin_turn(scope("1" * 32), "openclaw")
    b = p.begin_turn(scope("2" * 32), "openclaw")
    a.bind("a" * 32)
    b.bind("b" * 32)
    a.settle("ok")
    b.settle("timeout")
    records = await rig.settled(p)
    assert [(r["thread_id"], r["phase"]) for r in records] == [
        ("1" * 32, "start"),
        ("2" * 32, "start"),
        ("1" * 32, "end"),
        ("2" * 32, "end"),
    ]


async def test_binds_once_and_refuses_an_unusable_repeated_or_late_binding(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    p = rig.publisher()
    before = trace_record_counts()
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        turn = p.begin_turn(scope(), "openclaw")
        turn.bind("has space")
        turn.bind("first")
        turn.bind("first")
        turn.bind("second")
        turn.settle("ok")
        turn.settle("error")
        turn.bind("third")
        unbound = p.begin_turn(scope(), "openclaw")
        unbound.settle("ok")
        records = await rig.settled(p)
    assert [(r["harness_thread_id"], r["phase"], r.get("status")) for r in records] == [
        ("first", "start", None),
        ("first", "end", "ok"),
    ]
    warnings = [r.getMessage() for r in caplog.records]
    assert len([w for w in warnings if "unusable" in w]) == 1
    assert len([w for w in warnings if "already bound" in w]) == 1
    assert len([w for w in warnings if "after the turn ended" in w]) == 1
    assert trace_record_counts().published - before.published == 2


async def test_publishes_nothing_without_a_signer_warns_once_and_counts_the_drops(
    rig: Rig, caplog: pytest.LogCaptureFixture
) -> None:
    p = rig.publisher(signed=False)
    before = trace_record_counts()
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        for harness_thread_id in ("one", "two"):
            turn = p.begin_turn(scope(), "openclaw")
            turn.bind(harness_thread_id)
            turn.settle("ok")
        records = await rig.settled(p)
    assert records == []
    warned = [r for r in caplog.records if "no identity signer" in r.getMessage()]
    assert len(warned) == 1
    after = trace_record_counts()
    assert after.published - before.published == 0
    assert after.dropped - before.dropped == 4


async def test_counts_a_record_whose_publish_raised_as_dropped_and_keeps_the_next_in_order(
    rig: Rig, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    real_publish = rig.nc.publish
    failures = 0

    async def failing(subject: str, *args: Any, **kwargs: Any) -> None:
        nonlocal failures
        if subject == "TRACE.edges":
            failures += 1
            if failures == 1:
                raise RuntimeError("connection draining")
        await real_publish(subject, *args, **kwargs)

    monkeypatch.setattr(rig.nc, "publish", failing)
    p = rig.publisher()
    before = trace_record_counts()
    with caplog.at_level(logging.WARNING, logger=LOGGER):
        turn = p.begin_turn(scope(), "claude")
        turn.bind(SESSION)
        turn.settle("ok")
        records = await rig.settled(p)
    assert [r["phase"] for r in records] == ["end"]
    warned = [r for r in caplog.records if "failed to publish" in r.getMessage()]
    assert len(warned) == 1
    after = trace_record_counts()
    assert after.published - before.published == 1
    assert after.dropped - before.dropped == 1


async def test_publishes_to_a_configured_subject(rig: Rig) -> None:
    custom = await capture(rig.nc, "acme.TRACE.edges.v2")
    p = rig.publisher(subject="acme.TRACE.edges.v2")
    turn = p.begin_turn(scope(), "openclaw")
    turn.bind(TRACE_ID)
    turn.settle("ok")
    on_default = await rig.settled(p)
    assert on_default == []
    assert [json.loads(m.data)["phase"] for m in custom] == ["start", "end"]
    assert isinstance(verify_sender(custom[0], "stored"), VerifiedSender)
