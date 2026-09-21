"""End to end, in operator mode.

Real account NKEYs, so the ``agent`` field is the ``{account}.{user}`` form
the edge schema requires. A traced caller A prompts a traced host B,
whose handler — as a model tool call would — prompts a traced host C.
Every edge lands before the prompt it describes, validates against
``edge.json``, verifies as alice's signed record, and carries one id three
ways; each host sees its thread and root through ``trace_headers()``; the
child is filed under its parent. The TypeScript suite runs the same
scenario.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import nats
import pytest
import pytest_asyncio
from synadia_ai.agent_service import AgentService
from synadia_ai.agents import (
    AgentId,
    Agents,
    Identity,
    VerifiedSender,
    signer_from_creds_file,
    verify_sender,
)

from synadia_ai.agent_fabric import fabric_tracing, trace_headers, trace_record_counts
from tests.harness.nats_server import identity_fixture
from tests.support import drain, edge_schema_errors, handle_of, start_host

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer

CREDS = identity_fixture("operator/alice.creds")
_OP_KEYS = json.loads(identity_fixture("operator/keys.json").read_text(encoding="utf-8"))
ALICE_ID = AgentId.new(_OP_KEYS["accounts"]["ACME"]["public"], _OP_KEYS["users"]["alice"]["public"])

pytestmark = pytest.mark.asyncio(loop_scope="module")


@dataclass
class Run:
    wire: list[tuple[str, Msg]] = field(default_factory=list)
    seen_by_b: list[dict[str, str]] = field(default_factory=list)
    seen_by_c: list[dict[str, str]] = field(default_factory=list)
    answer: list[str] = field(default_factory=list)
    published_before: int = 0
    published_after: int = 0
    dropped_delta: int = 0
    status_of_b: dict[str, Any] = field(default_factory=dict)

    def edges(self) -> list[Msg]:
        return [m for what, m in self.wire if what == "edge"]

    def records(self) -> list[dict[str, Any]]:
        return [json.loads(m.data) for m in self.edges()]

    def prompt_to(self, what: str) -> bytes:
        return next(m.data for w, m in self.wire if w == what)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def run(nats_server_operator: RunningServer) -> AsyncIterator[Run]:
    """The scenario, run once for the module; the tests read what it saw."""
    nc = await nats.connect(nats_server_operator.url, user_credentials=str(CREDS))
    observer = await nats.connect(nats_server_operator.url, user_credentials=str(CREDS))
    signer = signer_from_creds_file(CREDS)
    tracing = fabric_tracing()
    result = Run()
    services: list[AgentService] = []
    clients: list[Agents] = []
    try:

        async def c_handler(_env: Any, stream: Any) -> None:
            result.seen_by_c.append(trace_headers())
            await stream.send("c-ok")

        services.append(
            await start_host(
                nc,
                "fabric-c",
                interceptors=[tracing.request_interceptor],
                heartbeat_extras=tracing.heartbeat_extras,
                handler=c_handler,
            )
        )
        # B's own client, the one its "tool" prompts C with: traced, signed.
        tool = Agents(
            nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor]
        )
        clients.append(tool)
        to_c = await handle_of(tool, "fabric-c")

        async def b_handler(_env: Any, stream: Any) -> None:
            result.seen_by_b.append(trace_headers())  # two model calls before the tool call …
            trace_headers()
            await drain(to_c.prompt("to C", context={"tool_call_id": "toolu_B"}))  # … then C
            await stream.send("b-ok")

        b = await start_host(
            nc,
            "fabric-b",
            interceptors=[tracing.request_interceptor],
            heartbeat_extras=tracing.heartbeat_extras,
            handler=b_handler,
        )
        services.append(b)

        for subject, what in (
            ("TRACE.edges", "edge"),
            (b.subject.prompt, "B"),
            (services[0].subject.prompt, "C"),
        ):

            async def cb(msg: Msg, what: str = what) -> None:
                result.wire.append((what, msg))

            await observer.subscribe(subject, cb=cb)
        await observer.flush()

        a = Agents(
            nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor]
        )
        clients.append(a)
        to_b = await handle_of(a, "fabric-b")
        before = trace_record_counts()
        result.published_before = before.published
        result.answer = await drain(to_b.prompt("to B", context={"tool_call_id": "toolu_A"}))
        after = trace_record_counts()
        result.published_after = after.published
        result.dropped_delta = after.dropped - before.dropped
        result.status_of_b = dict((await to_b.status()).extras)
        await asyncio.sleep(0.3)
        yield result
    finally:
        for client in clients:
            await client.close()
        for svc in services:
            await svc.stop()
        await observer.close()
        await nc.close()


async def test_answers_the_caller_through_both_hops(run: Run) -> None:
    assert run.answer == ["b-ok"]


async def test_publishes_each_edge_before_the_prompt_it_describes(run: Run) -> None:
    assert [what for what, _ in run.wire] == ["edge", "B", "edge", "C"]


async def test_writes_records_that_validate_against_edge_json(run: Run) -> None:
    records = run.records()
    assert len(records) == 2
    for record in records:
        assert edge_schema_errors(record) == []


async def test_signs_every_record_as_its_writer_with_one_id_three_ways(run: Run) -> None:
    for msg in run.edges():
        record = json.loads(msg.data)
        # Stored mode, as the reader verifies: the signature over the short
        # form the writer published to.
        sender = verify_sender(msg, "stored")
        assert isinstance(sender, VerifiedSender)
        assert sender.id == ALICE_ID
        assert record["agent"] == str(ALICE_ID)
        assert sender.header.nonce == record["record_id"]
        assert (msg.headers or {})["Nats-Msg-Id"] == record["record_id"]


async def test_roots_the_callers_prompt(run: Run) -> None:
    root = run.records()[0]
    assert root["version"] == 1
    assert root["kind"] == "edge"
    assert root["parent_id"] is None
    assert root["root_id"] == root["thread_id"]
    assert root["tool_call_id"] == "toolu_A"
    assert root["turn_count_hint"] == 0


async def test_carries_exactly_the_two_fields_after_the_prompt(run: Run) -> None:
    root, child = run.records()
    t1, t2 = root["thread_id"], child["thread_id"]
    assert run.prompt_to("B") == (
        f'{{"prompt":"to B","thread_id":"{t1}","root_id":"{t1}"}}'.encode()
    )
    assert run.prompt_to("C") == (
        f'{{"prompt":"to C","thread_id":"{t2}","root_id":"{t1}"}}'.encode()
    )


async def test_lets_the_host_stamp_its_thread_and_root(run: Run) -> None:
    t1 = run.records()[0]["thread_id"]
    assert run.seen_by_b == [{"X-Synadia-Thread-ID": t1, "X-Synadia-Root-ID": t1}]


async def test_files_the_child_under_its_parent(run: Run) -> None:
    root, child = run.records()
    assert child["thread_id"] != root["thread_id"]
    assert child["parent_id"] == root["thread_id"]
    assert child["root_id"] == root["thread_id"]
    assert child["tool_call_id"] == "toolu_B"
    assert child["turn_count_hint"] == 2
    assert run.seen_by_c == [
        {"X-Synadia-Thread-ID": child["thread_id"], "X-Synadia-Root-ID": root["thread_id"]}
    ]


async def test_counts_both_records_and_reports_them_on_the_hosts_status(run: Run) -> None:
    assert run.published_after - run.published_before == 2
    assert run.dropped_delta == 0
    assert run.status_of_b["records_published"] == run.published_after
