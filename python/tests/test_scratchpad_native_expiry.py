"""Real native service proof for expired and cancelled publication recovery."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio

from synadia_ai.agent_fabric import native_scratchpad
from tests.harness.native_service import NativeService
from tests.test_scratchpad_native import CORE, connect_as

pytestmark = pytest.mark.skipif(not CORE, reason="set SCRATCHPAD_CORE_ROOT for actual service")


@pytest_asyncio.fixture(name="service")
async def real_service() -> AsyncIterator[NativeService]:
    assert CORE
    fixture = await NativeService.start(Path(CORE))
    try:
        yield fixture
    finally:
        if not fixture.closed:
            print("PYTHON_EXPIRY_SERVICE", json.dumps(await fixture.close()))


@pytest.mark.parametrize("accepted", [False, True])
async def test_expired_publication_recovery(
    service: NativeService, tmp_path: Path, accepted: bool
) -> None:
    nc = await connect_as(service, "owner", fault=True)
    directory = tmp_path / "state"
    directory.mkdir(mode=0o700)
    pad = await native_scratchpad(
        nc=nc,
        volume=service.config["volume"],
        dir=directory,
        creator="agents.python.expiry",
        timeout_s=1,
    )
    try:
        operation = "accepted-expiry" if accepted else "unaccepted-expiry"
        await service.command(
            "drop_publish" if accepted else "drop_unaccepted_publish", operation_id=operation
        )
        with pytest.raises(Exception) as unknown:
            await pad.publish_bytes(
                b"short-lived", "/expires.txt", operation_id=operation, ttl_seconds=3
            )
        assert getattr(unknown.value, "unknown", False)
        observation = await service.command(
            "accepted" if accepted else "observed_unaccepted", operation_id=operation
        )
        command = (
            observation["receipt"]["command"] if accepted else observation["request"]["command"]
        )
        if not accepted:
            assert observation["dropped_requests"] == 1
            assert (
                observation["view"]["writers"][command["writer"]["slot"]]["number"]
                < command["number"]
            )
        before_recovery = await pad.describe()
        assert before_recovery["pending"] == "publish"
        expiry = await service.command("wait_expired", operation_id=operation)
        assert expiry["expired"] is True
        assert expiry["until"] == command["retention"]["until"]
        assert expiry["now"] >= expiry["until"]
        result = await pad.recover()
        if accepted:
            assert result["kind"] == "publish"
            assert result["receipt"] == observation["receipt"]
        else:
            assert result == {"kind": "expired"}
        settled = await pad.describe()
        assert settled.get("pending") is None
        assert settled["volume"]["head"] == before_recovery["volume"]["head"]
        assert settled["volume"]["writers"] == before_recovery["volume"]["writers"]
        if not accepted:
            assert not settled["volume"]["closed"]
            assert settled["volume"]["revision"] >= before_recovery["volume"]["revision"] + 2
            assert settled["volume"]["epoch"] > before_recovery["volume"]["epoch"]
        following = await pad.commit("writer remains usable", "/next.txt", None)
        assert await pad.read(following) == "writer remains usable"
        writer = (await pad.describe())["volume"]["writers"][command["writer"]["slot"]]
        assert writer["generation"] == command["writer"]["generation"]
        assert writer["number"] == command["number"] + (1 if accepted else 0)
        counts = await service.close()
        assert counts == {
            "commands": 4,
            "accepted_receipts": int(accepted),
            "dropped_replies": int(accepted),
            "go_publications": 0,
            "go_reads": 0,
            "service_restarts": 0,
            **({} if accepted else {"dropped_requests": 1}),
        }
        print(
            "PYTHON_NATIVE_EXPIRY",
            json.dumps(
                {
                    "accepted": accepted,
                    "observed_expiry": expiry,
                    "recovery": result["kind"],
                    "revision_before": before_recovery["volume"]["revision"],
                    "revision_after": settled["volume"]["revision"],
                    "epoch_before": before_recovery["volume"]["epoch"],
                    "epoch_after": settled["volume"]["epoch"],
                    "same_writer": True,
                    "next_number": writer["number"],
                    "fixture": counts,
                }
            ),
        )
    finally:
        await pad.close()
        await nc.close()


async def test_task_cancellation_preserves_publication(
    service: NativeService, tmp_path: Path
) -> None:
    nc = await connect_as(service, "owner", fault=True)
    directory = tmp_path / "state"
    directory.mkdir(mode=0o700)
    pad = await native_scratchpad(
        nc=nc,
        volume=service.config["volume"],
        dir=directory,
        creator="agents.python.cancellation",
        timeout_s=10,
    )
    task = None
    try:
        operation = "cancelled-publication"
        await service.command("drop_unaccepted_publish", operation_id=operation)
        task = asyncio.create_task(
            pad.publish_bytes(
                b"saved despite cancellation",
                "/cancelled.txt",
                operation_id=operation,
                ttl_seconds=600,
            )
        )
        observed = await service.command("observed_unaccepted", operation_id=operation)
        assert observed["dropped_requests"] == 1
        assert not task.done()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert task.cancelled()
        assert (await pad.describe())["pending"] == "publish"
        recovered = await pad.recover()
        assert recovered["kind"] == "publish"
        assert recovered["receipt"]["command"] == observed["request"]["command"]
        assert await pad.read(recovered["reference"]) == "saved despite cancellation"
        assert (await pad.describe()).get("pending") is None
        counts = await service.close()
        assert counts == {
            "commands": 3,
            "accepted_receipts": 0,
            "dropped_replies": 0,
            "dropped_requests": 1,
            "go_publications": 0,
            "go_reads": 0,
            "service_restarts": 0,
        }
        print(
            "PYTHON_NATIVE_CANCEL",
            json.dumps(
                {
                    "cancelled_tasks": 1,
                    "preserved_intents": 1,
                    "exact_recovered_commands": 1,
                    "bytes": len(b"saved despite cancellation"),
                    "fixture": counts,
                }
            ),
        )
    finally:
        if task and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await pad.close()
        await nc.close()
