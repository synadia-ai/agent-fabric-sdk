"""Recover real accepted control operations and observe native reconnects."""

# Native Python 3.12 implementation is loaded only for enabled tests.
# ruff: noqa: PLC0415

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import nats
import pytest

from synadia_ai.agent_fabric import Grantee
from tests.harness.native_service import NativeService
from tests.test_scratchpad_native import connect_as
from tests.test_scratchpad_native import (
    service as service,  # noqa: PLC0414 -- pytest fixture export
)

pytestmark = pytest.mark.skipif(
    not os.environ.get("SCRATCHPAD_CORE_ROOT"), reason="set SCRATCHPAD_CORE_ROOT for actual service"
)


def options(fixture: NativeService, connection: Any, directory: Path) -> dict[str, Any]:
    return {
        "nc": connection,
        "volume": fixture.config["volume"],
        "creator": "agents.native.control-fixture",
        "dir": directory / "writer",
        "timeout_s": 1,
    }


async def test_delayed_grant_after_definite_refusal(  # noqa: PLR0915
    service: NativeService, tmp_path: Path
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader
    from synadia_ai.agent_fabric._scratchpad_native.codec import decode_reference

    original = await connect_as(service, "owner", fault=True)
    direct = await connect_as(service, "owner")
    pad = None
    try:
        pad = await native_scratchpad(**options(service, original, tmp_path))
        data = b"delivered after the refusal"
        publication = await pad.publish_bytes(data, "/late.txt", operation_id="late-grant")
        grantee = Grantee(
            account=service.config["users"]["reader"]["account"],
            user=service.config["users"]["reader"]["user"],
        )
        assert await service.command("delay_grant") == {"armed": "grant.issue"}
        with pytest.raises(NativeScratchPadError) as failure:
            await pad.grant_read(publication["reference"], grantee)
        assert failure.value.unknown
        held = await service.command("delayed_grant_status")
        assert held["held_requests"] == 1 and held["released_requests"] == 0
        assert held["accepted"] is False
        reference = decode_reference(publication["reference"])
        assert reference["target"]["volume"] == service.config["volume"]
        assert held["request"]["principal"] == {"account": grantee.account, "user": grantee.user}
        for field in ("target", "root", "path", "retention"):
            assert held["request"][field] == reference[field]
        await pad.close()
        pad = await native_scratchpad(**options(service, direct, tmp_path))
        assert (await pad.describe())["pending"] == "grant"
        closed = await service.command("operator_close", reference=publication["reference"])
        with pytest.raises(NativeScratchPadError) as refusal:
            await pad.recover()
        assert refusal.value.code == "closed" and refusal.value.unknown, (
            "a later refusal cannot clear an earlier unknown grant"
        )
        cause = refusal.value.__cause__
        assert isinstance(cause, NativeScratchPadError)
        assert cause.code == "closed" and not cause.local and not cause.unknown
        refused = await pad.describe()
        assert refused.get("pending") == "grant", (
            "a later refusal cannot clear an earlier unknown grant"
        )
        assert refused["volume"] == closed["view"]
        await pad.close()
        pad = await native_scratchpad(**options(service, direct, tmp_path))
        assert (await pad.describe())["pending"] == "grant"
        await service.command("operator_collect", reference=publication["reference"])
        delivered = await service.command("release_delayed_grant")
        assert delivered["held_requests"] == delivered["released_requests"] == 1
        assert delivered["accepted"] is True
        assert delivered["request"] == held["request"]
        assert (await pad.recover())["kind"] == "grant"
        assert "pending" not in await pad.describe()
        assert pad.granted(publication["reference"], grantee) == "first-hand"
        read = await service.command("go_read", user="reader", reference=publication["reference"])
        assert read["bytes"] == len(data)
        with pytest.raises(RuntimeError, match="denied"):
            await service.command("go_read", user="intruder", reference=publication["reference"])
        reader = await scratchpad_reader(nc=direct)
        assert await reader.read_bytes(publication["reference"]) == data
        print(
            "NATIVE_DELAYED_RESULT",
            json.dumps(
                {
                    "language": "python",
                    "held": 1,
                    "released": 1,
                    "recoveredGrants": 1,
                    "verifiedBytes": len(data),
                }
            ),
        )
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await original.close()
            await direct.close()


async def test_failed_constructor_binding_releases_workspace(
    service: NativeService, tmp_path: Path
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    connection = await connect_as(service, "owner")
    pad = None
    try:
        opts = options(service, connection, tmp_path)
        pad = await native_scratchpad(**opts)
        data = b"preserved across failed startup"
        publication = await pad.publish_bytes(data, "/startup.txt", operation_id="startup")
        await pad.close()
        with pytest.raises(NativeScratchPadError, match="workspace is bound"):
            await native_scratchpad(**{**opts, "creator": "agents.another.creator"})
        pad = await native_scratchpad(**opts)
        replay = await pad.publish_bytes(b"", "/startup.txt", operation_id="startup")
        assert replay == publication
        reader = await scratchpad_reader(nc=connection)
        assert await reader.read_bytes(replay["reference"]) == data
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await connection.close()


@pytest.mark.parametrize(
    ("fail_input", "cancel_close"),
    [(False, False), (True, False), (False, True)],
    ids=["completes", "input-fails", "cancel-close"],
)
async def test_close_joins_active_publication(  # noqa: PLR0915
    service: NativeService, tmp_path: Path, fail_input: bool, cancel_close: bool
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    connection = await connect_as(service, "owner")
    pad = None
    publishing = closing = None
    entered, proceed, close_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
    data = bytes([37]) * (512 * 1024)

    async def source() -> AsyncIterator[bytes]:
        yield data
        entered.set()
        await proceed.wait()
        if fail_input:
            raise RuntimeError("controlled input failure")

    async def close_client() -> None:
        close_started.set()
        assert pad is not None
        await pad.close()

    try:
        opts = options(service, connection, tmp_path)
        pad = await native_scratchpad(**opts)
        publishing = asyncio.create_task(
            pad.publish_stream(source(), "/close.bin", operation_id="close-active")
        )
        await asyncio.wait_for(entered.wait(), 5)
        closing = asyncio.create_task(close_client())
        await asyncio.wait_for(close_started.wait(), 5)
        with pytest.raises(NativeScratchPadError) as closed:
            await pad.describe()
        assert closed.value.code == "closed" and closed.value.local
        with pytest.raises(NativeScratchPadError) as busy:
            await native_scratchpad(**opts)
        assert busy.value.code == "busy" and busy.value.local
        assert not closing.done()
        if cancel_close:
            closing.cancel()
            with pytest.raises(asyncio.CancelledError):
                await closing
            close_started.clear()
            closing = asyncio.create_task(close_client())
            await asyncio.wait_for(close_started.wait(), 5)
            with pytest.raises(NativeScratchPadError) as still_busy:
                await native_scratchpad(**opts)
            assert still_busy.value.code == "busy"
            assert not closing.done()
        proceed.set()
        completed = None
        if fail_input:
            with pytest.raises(RuntimeError, match="controlled input failure"):
                await publishing
        else:
            completed = await publishing
        await closing
        pad = await native_scratchpad(**opts)
        assert "pending" not in await pad.describe()
        published = await pad.publish_bytes(data, "/close.bin", operation_id="close-active")
        assert published["receipt"]["command"]["number"] == 1
        if not fail_input:
            assert published == completed
        reader = await scratchpad_reader(nc=connection)
        assert await reader.read_bytes(published["reference"]) == data
    finally:
        proceed.set()
        await asyncio.gather(
            *(task for task in (publishing, closing) if task), return_exceptions=True
        )
        try:
            if pad:
                await pad.close()
        finally:
            await connection.close()


@pytest.mark.parametrize(
    ("kind", "verb"),
    [("grant", "grant.issue"), ("close", "maintenance.close"), ("apply", "maintenance.apply")],
)
async def test_accepted_control_recovery(  # noqa: PLR0915
    service: NativeService, tmp_path: Path, kind: str, verb: str
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    connection = await connect_as(service, "owner", fault=True)
    pad = None
    try:
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        old = await pad.publish_bytes(
            b"obsolete payload", "/old.txt", operation_id="old-publication"
        )
        await pad.release(old["reference"])
        data = b"retained exact payload"
        published = await pad.publish_bytes(
            data, "/result.txt", operation_id="protected-publication"
        )
        before = (await pad.describe())["volume"]
        grantee = Grantee(
            account=service.config["users"]["reader"]["account"],
            user=service.config["users"]["reader"]["user"],
        )
        assert await service.command("drop_control", verb=verb) == {"armed": verb}
        with pytest.raises(NativeScratchPadError) as failure:
            if kind == "grant":
                await pad.grant_read(published["reference"], grantee)
            else:
                await pad.maintain()
        assert failure.value.unknown
        captured = await service.command("control_status")
        assert captured["verb"] == verb
        assert captured["control_requests"] == 1
        assert captured["same_requests"] == 1
        assert captured["dropped_control_replies"] == 1
        assert captured["dropped_observation_replies"] == 1
        assert captured["view"]["closed"] is (kind == "close")
        assert captured["view"]["head"] == before["head"]
        assert (await pad.describe())["pending"] == kind
        with pytest.raises(NativeScratchPadError) as blocked:
            await pad.publish_bytes(b"blocked", "/blocked.txt", operation_id="blocked-by-control")
        assert blocked.value.code == "busy"
        assert blocked.value.local and not blocked.value.unknown
        await pad.close()
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        assert (await pad.describe()).get("pending") == kind, (
            "reopened workspace retains its control"
        )
        assert (await pad.recover())["kind"] == kind
        replay = await service.command("control_status")
        assert replay["control_requests"] == 2
        assert replay["same_requests"] == 2
        assert replay["request"] == captured["request"]
        settled = await pad.describe()
        assert "pending" not in settled
        assert not settled["volume"]["closed"]
        assert settled["volume"]["head"] == before["head"]
        assert settled["volume"]["writers"] == before["writers"]
        if kind == "close":
            assert settled["volume"]["revision"] == captured["view"]["revision"] + 1
            assert settled["volume"]["objects"] < before["objects"]
        else:
            assert settled["volume"] == captured["view"]
        if kind == "apply":
            assert settled["volume"]["objects"] < before["objects"]
        if kind == "grant":
            assert sum(bool(slot.get("grant")) for slot in settled["volume"]["grants"]) == 1
            assert pad.granted(published["reference"], grantee) == "first-hand"
            await service.command("go_read", user="reader", reference=published["reference"])
            with pytest.raises(NativeScratchPadError) as live:
                await pad.release(published["reference"])
            assert live.value.code == "busy"
        reader = await scratchpad_reader(nc=connection)
        assert await reader.read_bytes(published["reference"]) == data
        following = await pad.publish_bytes(
            b"after recovery", "/next.txt", operation_id="after-control-recovery"
        )
        assert (
            following["receipt"]["command"]["number"]
            == published["receipt"]["command"]["number"] + 1
        )
        print(
            "NATIVE_CONTROL_RESULT",
            json.dumps(
                {
                    "language": "python",
                    "kind": kind,
                    "requests": replay["control_requests"],
                    "identical_requests": replay["same_requests"],
                    "dropped_replies": 2,
                    "recovered_pending": 1,
                    "preserved_bytes": len(data),
                    "reclaimed_objects": before["objects"] - settled["volume"]["objects"],
                    "writer_generation": following["receipt"]["command"]["writer"]["generation"],
                }
            ),
        )
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await connection.close()


async def test_exact_publication_after_real_reconnect(
    service: NativeService, tmp_path: Path
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    disconnected = asyncio.Event()
    reconnected = asyncio.Event()
    events: list[str] = []

    async def on_disconnect() -> None:
        events.append("disconnect")
        disconnected.set()

    async def on_reconnect() -> None:
        events.append("reconnect")
        reconnected.set()

    connection = await nats.connect(
        [service.config["fault_url"], service.config["url"]],
        user_credentials=service.config["users"]["owner"]["credentials"],
        dont_randomize=True,
        allow_reconnect=True,
        reconnect_time_wait=0.05,
        max_reconnect_attempts=10,
        disconnected_cb=on_disconnect,
        reconnected_cb=on_reconnect,
    )
    pad = None
    try:
        assert connection.connected_url == urlparse(service.config["fault_url"])
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        await service.command("drop_publish", operation_id="reconnect-publication")
        data = b"accepted before disconnect"
        with pytest.raises(NativeScratchPadError) as failure:
            await pad.publish_bytes(data, "/reconnect.txt", operation_id="reconnect-publication")
        assert failure.value.unknown
        accepted = await service.command("accepted", operation_id="reconnect-publication")
        await pad.close()
        assert await service.command("disconnect_fault_proxy") == {"closed": True}
        await asyncio.wait_for(disconnected.wait(), 5)
        await asyncio.wait_for(reconnected.wait(), 5)
        assert connection.connected_url == urlparse(service.config["url"])
        await connection.flush()
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        recovered = await pad.recover()
        assert recovered["kind"] == "publish"
        assert recovered["receipt"] == accepted["receipt"]
        reader = await scratchpad_reader(nc=connection)
        assert await reader.read_bytes(recovered["reference"]) == data
        assert (await pad.describe())["volume"]["writers"][0]["number"] == 1
        print(
            "NATIVE_RECONNECT_RESULT",
            json.dumps(
                {
                    "language": "python",
                    "disconnects": events.count("disconnect"),
                    "reconnects": events.count("reconnect"),
                    "exact_receipts": 1,
                    "bytes": len(data),
                    "accepted_commands": 1,
                }
            ),
        )
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await connection.close()


async def test_unrelated_maintenance_requires_operator(
    service: NativeService, tmp_path: Path
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    connection = await connect_as(service, "owner", fault=True)
    pad = None
    try:
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        published = await pad.publish_bytes(
            b"operator preserved", "/result.txt", operation_id="before-operator-close"
        )
        closed = await service.command("operator_close", reference=published["reference"])
        assert closed["view"]["closed"]
        with pytest.raises(NativeScratchPadError) as first:
            await pad.maintain()
        assert first.value.code == "closed"
        assert not first.value.unknown
        assert await pad.describe() == {"volume": closed["view"]}
        await pad.close()
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        with pytest.raises(NativeScratchPadError) as second:
            await pad.maintain()
        assert second.value.code == "closed"
        assert not second.value.unknown
        assert await pad.recover() == {"kind": "ready", **published}
        assert await pad.describe() == {"volume": closed["view"]}
        reopened = await service.command("operator_collect", reference=published["reference"])
        assert not reopened["view"]["closed"]
        assert reopened["view"]["writers"] == closed["view"]["writers"]
        reader = await scratchpad_reader(nc=connection)
        assert await reader.read_bytes(published["reference"]) == b"operator preserved"
        following = await pad.publish_bytes(
            b"usable again", "/next.txt", operation_id="after-operator-collection"
        )
        assert (
            following["receipt"]["command"]["number"]
            == published["receipt"]["command"]["number"] + 1
        )
        print(
            "NATIVE_OPERATOR_RESULT",
            json.dumps(
                {
                    "language": "python",
                    "takeover_refusals": 2,
                    "non_adopting_recoveries": 1,
                    "explicit_collections": 1,
                    "continued_commands": 1,
                }
            ),
        )
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await connection.close()


async def test_capacity_preserves_live_handoffs(service: NativeService, tmp_path: Path) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    connection = await connect_as(service, "owner", fault=True)
    readers = []
    pad = None
    try:
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        initial = await pad.publish_bytes(b"initial", "/initial.txt", operation_id="quota-initial")
        before = await pad.describe()
        oversized = (bytes([index]) * (512 * 1024) for index in range(17))
        with pytest.raises(NativeScratchPadError) as byte_refusal:
            await pad.publish_stream(oversized, "/oversized.bin", operation_id="byte-quota-refusal")
        assert byte_refusal.value.code == "capacity"
        assert byte_refusal.value.local
        assert await pad.describe() == before
        await pad.release(initial["reference"])
        publications = await asyncio.gather(
            *(
                pad.publish_bytes(
                    f"handoff {index}".encode(),
                    f"/result-{index}.txt",
                    operation_id=f"concurrent-handoff-{index}",
                )
                for index in range(8)
            )
        )
        assert [p["receipt"]["command"]["number"] for p in publications] == list(range(2, 10))
        recipients = [service.config["users"][name] for name in ("reader", "intruder")]
        await asyncio.gather(
            *(
                pad.grant_read(p["reference"], Grantee(account=user["account"], user=user["user"]))
                for p in publications
                for user in recipients
            )
        )
        full = await pad.describe()
        assert "pending" not in full
        assert sum(bool(entry.get("pin")) for entry in full["volume"]["retentions"]) == 8
        assert sum(bool(entry.get("grant")) for entry in full["volume"]["grants"]) == 16
        with pytest.raises(NativeScratchPadError) as retention_refusal:
            await pad.publish_bytes(b"ninth", "/ninth.txt", operation_id="ninth-handoff")
        assert retention_refusal.value.code == "capacity"
        owner = service.config["users"]["owner"]
        with pytest.raises(NativeScratchPadError) as grant_refusal:
            await pad.grant_read(
                publications[0]["reference"], Grantee(account=owner["account"], user=owner["user"])
            )
        assert grant_refusal.value.code == "capacity"
        assert await pad.describe() == full
        reads = 0
        for name in ("reader", "intruder"):
            receiver = await connect_as(service, name)
            readers.append(receiver)
            reader = await scratchpad_reader(nc=receiver)
            for index, publication in enumerate(publications):
                assert (
                    await reader.read_bytes(publication["reference"]) == f"handoff {index}".encode()
                )
                reads += 1
        print(
            "NATIVE_PRESSURE_RESULT",
            json.dumps(
                {
                    "language": "python",
                    "byte_refusals": 1,
                    "retention_refusals": 1,
                    "grant_refusals": 1,
                    "concurrent_publications": len(publications),
                    "retained_roots": 8,
                    "live_grants": 16,
                    "verified_reads": reads,
                }
            ),
        )
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            try:
                await asyncio.gather(*(reader.close() for reader in readers))
            finally:
                await connection.close()


@pytest.mark.parametrize("quota", ["bytes", "objects"])
async def test_retained_data_quota_headroom(  # noqa: PLR0915
    service: NativeService, tmp_path: Path, quota: str
) -> None:
    from synadia_ai.agent_fabric import NativeScratchPadError, native_scratchpad, scratchpad_reader

    connection = await connect_as(service, "owner", fault=True)
    pad = None
    try:
        pad = await native_scratchpad(**options(service, connection, tmp_path))
        chunk_bytes = 512 * 1024

        def chunk_data(count: int, first: int) -> bytes:
            return b"".join(bytes([first + index]) * chunk_bytes for index in range(count))

        seeds = (
            [chunk_data(6, 1), b"retained current head"]
            if quota == "bytes"
            else [f"retained object root {index}".encode() for index in range(3)]
        )

        def path(index: int) -> str:
            parts = [] if quota == "bytes" else [f"d{part}" for part in range(15)]
            return "/" + "/".join([*parts, f"artifact-{index}.bin"])

        publications = []
        observed_objects = []
        for index, data in enumerate(seeds):
            publications.append(
                await pad.publish_bytes(data, path(index), operation_id=f"headroom-seed-{index}")
            )
            observed_objects.append((await pad.describe())["volume"]["objects"])
        await pad.maintain()
        before = await pad.describe()
        candidate = chunk_data(12, 101) if quota == "bytes" else b"candidate object root"
        operation_id = f"headroom-candidate-{quota}"
        if quota == "bytes":
            assert len(candidate) < 8 * 1024 * 1024
            assert before["volume"]["bytes"] + len(candidate) > 8 * 1024 * 1024
            assert before["volume"]["objects"] == 11
        else:
            assert observed_objects == [18, 36, 54]
            assert before["volume"]["objects"] == 54
            assert before["volume"]["bytes"] < 64 * 1024
        with pytest.raises(NativeScratchPadError) as failure:
            await pad.publish_bytes(candidate, path(len(seeds)), operation_id=operation_id)
        assert failure.value.code == "capacity"
        assert not failure.value.unknown
        assert failure.value.local
        refused = await pad.describe()
        assert "pending" not in refused
        assert not refused["volume"]["closed"]
        for field in ("head", "writers", "grants", "retentions", "objects", "bytes"):
            assert refused["volume"][field] == before["volume"][field]
        reader = await scratchpad_reader(nc=connection)
        for index, publication in enumerate(publications):
            assert await reader.read_bytes(publication["reference"]) == seeds[index]

        for publication in publications[:-1]:
            await pad.release(publication["reference"])
        released = (await pad.describe())["volume"]
        collected = await pad.maintain()
        deleted_objects = released["objects"] - collected["objects"]
        deleted_bytes = released["bytes"] - collected["bytes"]
        assert deleted_objects > 0
        assert deleted_bytes > 0
        assert collected["head"] == before["volume"]["head"]
        assert collected["writers"] == before["volume"]["writers"]
        if quota == "objects":
            assert collected["objects"] == 18
        accepted = await pad.publish_bytes(candidate, path(len(seeds)), operation_id=operation_id)
        assert accepted["receipt"]["command"]["operation_id"] == operation_id
        assert (
            accepted["receipt"]["command"]["writer"]
            == publications[-1]["receipt"]["command"]["writer"]
        )
        assert (
            accepted["receipt"]["command"]["number"]
            == publications[-1]["receipt"]["command"]["number"] + 1
        )
        assert await reader.read_bytes(accepted["reference"]) == candidate
        assert await reader.read_bytes(publications[-1]["reference"]) == seeds[-1]
        after = await pad.describe()
        assert "pending" not in after
        admitted_objects = after["volume"]["objects"] - collected["objects"]
        assert admitted_objects == (14 if quota == "bytes" else 18)
        assert after["volume"]["objects"] <= 64
        assert after["volume"]["bytes"] <= 8 * 1024 * 1024
        print(
            "NATIVE_HEADROOM_RESULT",
            json.dumps(
                {
                    "language": "python",
                    "quota": quota,
                    "observed_objects": observed_objects,
                    "occupied_objects": before["volume"]["objects"],
                    "occupied_bytes": before["volume"]["bytes"],
                    "refusal_revision_delta": (
                        refused["volume"]["revision"] - before["volume"]["revision"]
                    ),
                    "deleted_objects": deleted_objects,
                    "deleted_bytes": deleted_bytes,
                    "admitted_objects": admitted_objects,
                    "accepted_number": accepted["receipt"]["command"]["number"],
                    "verified_candidate_bytes": len(candidate),
                }
            ),
        )
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await connection.close()
