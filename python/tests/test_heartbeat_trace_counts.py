"""A host that runs the fabric's heartbeat extras reports its trace record counts.

It puts how many trace records its process has published and dropped
since it started on every heartbeat and on the status reply, as
``records_published`` and ``records_dropped`` — so whoever consumes the
heartbeat knows how many records the process failed to publish. A host
without them reports neither: its heartbeat stays byte-identical to plain
protocol 0.3. The TypeScript host does the same.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from synadia_ai.agents import HeartbeatPayload

from synadia_ai.agent_fabric import (
    TraceOptions,
    count_trace_record_dropped,
    count_trace_record_published,
    fabric_tracing,
    trace_record_counts,
)
from tests.support import start_host

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

# The §8.3 fields the host publishes, with the prompt endpoint's declaration
# the SDK adds since synadia-agents #217 (``protocol_version``, ``endpoints``):
# nothing else.
REQUIRED = {
    "agent",
    "owner",
    "session",
    "instance_id",
    "ts",
    "interval_s",
    "protocol_version",
    "endpoints",
}


async def _first_heartbeat_and_status(
    nc: NATSClient,
    agent: str,
    *,
    trace: TraceOptions | None,
    between_beat_and_status: Callable[[], None] = lambda: None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    extras = fabric_tracing(trace).heartbeat_extras if trace is not None else None
    sub = await nc.subscribe(f"agents.hb.{agent}.>")
    await nc.flush()
    svc = await start_host(nc, agent, heartbeat_extras=extras)
    try:
        first = await sub.next_msg(timeout=2.0)
        heartbeat = json.loads(first.data)
        between_beat_and_status()
        reply = await nc.request(svc.subject.status, b"", timeout=2.0)
        status = json.loads(reply.data)
        for payload in (heartbeat, status):
            HeartbeatPayload.model_validate(payload)
        return heartbeat, status
    finally:
        await sub.unsubscribe()
        await svc.stop()


async def test_traced_host_reports_the_process_wide_counts(nc: NATSClient) -> None:
    # The counters are process-wide and cumulative; move both so the
    # heartbeat provably reads them rather than a constant.
    count_trace_record_published()
    count_trace_record_dropped()
    expected = trace_record_counts()
    heartbeat, status = await _first_heartbeat_and_status(nc, "hb-traced", trace=TraceOptions())
    for payload in (heartbeat, status):
        assert payload["records_published"] == expected.published
        assert payload["records_dropped"] == expected.dropped


async def test_counts_are_read_fresh_on_every_beat(nc: NATSClient) -> None:
    """One service: a drop counted after its first heartbeat shows on the
    status reply that follows."""
    heartbeat, status = await _first_heartbeat_and_status(
        nc, "hb-fresh", trace=TraceOptions(), between_beat_and_status=count_trace_record_dropped
    )
    assert status["records_dropped"] == heartbeat["records_dropped"] + 1


async def test_propagate_only_host_reports_neither_count(nc: NATSClient) -> None:
    """Propagate-only publishes no records; a constant 0/0 would look like a healthy zero."""
    heartbeat, status = await _first_heartbeat_and_status(
        nc, "hb-propagate", trace=TraceOptions(edge_subject=None)
    )
    for payload in (heartbeat, status):
        assert set(payload) == REQUIRED


async def test_host_without_the_extras_reports_neither_count(nc: NATSClient) -> None:
    heartbeat, status = await _first_heartbeat_and_status(nc, "hb-untraced", trace=None)
    for payload in (heartbeat, status):
        assert set(payload) == REQUIRED
