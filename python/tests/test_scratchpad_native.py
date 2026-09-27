"""Opt-in native client conformance against the real Go service and storage."""

# Load the opt-in client runtime only after pytest has selected an enabled case.
# ruff: noqa: PLC0415

from __future__ import annotations

import hashlib
import json
import os
import signal
from collections.abc import AsyncIterator, Awaitable
from pathlib import Path
from typing import Any

import nats
import pytest
import pytest_asyncio

from synadia_ai.agent_fabric import Grantee
from tests.harness.native_service import NativeService, NativeWorker

CORE = os.environ.get("SCRATCHPAD_CORE_ROOT")
TYPESCRIPT = os.environ.get("SCRATCHPAD_TYPESCRIPT_PACKAGE")
pytestmark = pytest.mark.skipif(not CORE, reason="set SCRATCHPAD_CORE_ROOT for actual service")


def payload(size: int) -> bytes:
    return bytes(index % 251 for index in range(size))


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


async def refused(operation: Awaitable[Any], code: str, *, local: bool | None = None) -> None:
    with pytest.raises(Exception) as caught:
        await operation
    assert getattr(caught.value, "code", None) == code
    if local is not None:
        assert getattr(caught.value, "local", None) is local


@pytest_asyncio.fixture
async def service() -> AsyncIterator[NativeService]:
    assert CORE
    fixture = await NativeService.start(Path(CORE))
    try:
        assert fixture.config["storage"] == "file"
        assert fixture.config["replicas"] == 1
        assert len({item["user"] for item in fixture.config["users"].values()}) == 3
        yield fixture
    finally:
        if not fixture.closed:
            print("PYTHON_NATIVE_SERVICE", json.dumps(await fixture.close()))


async def connect_as(service: NativeService, user: str, *, fault: bool = False) -> Any:
    connection = await nats.connect(
        service.config["fault_url" if fault else "url"],
        user_credentials=service.config["users"][user]["credentials"],
        allow_reconnect=False,
    )
    await connection.flush()
    return connection


async def test_native_workflow(service: NativeService, tmp_path: Path) -> None:  # noqa: PLR0915
    from synadia_ai.agent_fabric import native_scratchpad, scratchpad_reader
    from synadia_ai.agent_fabric._scratchpad_native.codec import (
        decode_reference as decode_native_reference,
    )
    from synadia_ai.agent_fabric._scratchpad_native.codec import (
        encode_reference as encode_native_reference,
    )

    owner = await connect_as(service, "owner")
    reader_nc = await connect_as(service, "reader")
    intruder_nc = await connect_as(service, "intruder")
    connections = [owner, reader_nc, intruder_nc]
    workers: list[NativeWorker] = []
    state = tmp_path / "owner"
    empty_path = tmp_path / "empty-path"
    state.mkdir(mode=0o700)
    empty_path.mkdir(mode=0o700)
    creator = "agents.python.native.fixture"
    options = {
        "nc": owner,
        "volume": service.config["volume"],
        "dir": state,
        "creator": creator,
        "timeout_s": 5,
    }
    worker_options = {
        "url": service.config["url"],
        "credentials": service.config["users"]["owner"]["credentials"],
        "volume": service.config["volume"],
        "dir": str(state),
        "creator": creator,
        "timeout_s": 5,
        "empty_path": str(empty_path),
    }
    pad = None
    try:
        pad = await native_scratchpad(**options)
        reader = await scratchpad_reader(nc=reader_nc, timeout_s=5)
        intruder = await scratchpad_reader(nc=intruder_nc, timeout_s=5)
        owner_reader = await scratchpad_reader(nc=owner, timeout_s=5)
        data = payload(1024 * 1024 + 137)
        publication = await pad.publish_bytes(
            data, "/payload/report.bin", operation_id="python-roundtrip", ttl_seconds=600
        )
        reference, receipt = publication["reference"], publication["receipt"]
        assert receipt["principal"] == {
            key: service.config["users"]["owner"][key] for key in ("account", "user")
        }
        assert pad.owns(reference)
        await refused(native_scratchpad(**options), "busy", local=True)
        lock_probe = await NativeWorker.start("lock-probe", worker_options)
        workers.append(lock_probe)
        assert await lock_probe.event() == {
            "event": "refused",
            "code": "busy",
            "local": True,
            "successful_opens": 0,
        }
        assert await lock_probe.exited() == 0
        missing = tmp_path / "missing-journal"
        missing.mkdir(mode=0o700)
        before_missing = await pad.describe()
        unjournaled = await native_scratchpad(**{**options, "dir": missing})
        try:
            await refused(
                unjournaled.publish_bytes(b"abc", "/refused.bin", operation_id="missing-journal"),
                "exists",
                local=False,
            )
        finally:
            await unjournaled.close()
        assert await pad.describe() == before_missing
        await refused(reader.read_bytes(reference), "denied", local=False)
        principal = service.config["users"]["reader"]
        await pad.grant_read(
            reference, Grantee(account=principal["account"], user=principal["user"])
        )
        await refused(pad.release(reference), "busy")
        assert await reader.read_bytes(reference, limit_bytes=len(data)) == data
        streamed = bytearray()
        chunks = 0
        async for chunk in reader.read_stream(reference, limit_bytes=len(data)):
            streamed.extend(chunk)
            chunks += 1
        assert bytes(streamed) == data
        assert chunks >= 3
        await refused(intruder.read_bytes(reference), "denied", local=False)
        for path in ("/payload", "/payload/other.bin"):
            changed = encode_native_reference({**decode_native_reference(reference), "path": path})
            await refused(reader.read_bytes(changed), "denied", local=False)
        go_read = await service.command("go_read", user="reader", reference=reference)
        assert go_read["bytes"] == len(data)
        assert go_read["sha256"] == digest(data)
        go_publication = await service.command("go_publish", path="/from-go.bin", bytes=4097)
        from_go = await reader.read_bytes(go_publication["reference"])
        assert from_go == payload(4097)
        assert digest(from_go) == go_publication["sha256"]
        await pad.close()
        pad = None
        assert not owner.is_closed
        await service.command("drop_publish", operation_id="python-lost-publish")
        lost_options = {
            **worker_options,
            "url": service.config["fault_url"],
            "timeout_s": 1,
            "bytes": 1024 * 1024 + 157,
            "path": "/payload/recovered.bin",
            "operation_id": "python-lost-publish",
        }
        lost = await NativeWorker.start("publish", lost_options)
        workers.append(lost)
        assert (await lost.event())["unknown"] is True
        accepted = await service.command("accepted", operation_id="python-lost-publish")
        assert accepted["receipt"]["command"]["operation_id"] == "python-lost-publish"
        assert await lost.kill() == -signal.SIGKILL
        pad = await native_scratchpad(**options)
        before_reset = await pad.describe()
        assert before_reset["pending"] == "publish"
        await refused(
            pad.reset_writer(
                expected_generation=accepted["receipt"]["command"]["writer"]["generation"] - 1
            ),
            "fenced",
            local=False,
        )
        assert await pad.describe() == before_reset
        await pad.close()
        pad = None
        await service.command("restart_service")
        recovery = await NativeWorker.start("recover", worker_options)
        workers.append(recovery)
        recovered_event = await recovery.event()
        assert recovered_event["event"] == "recovered"
        recovered = recovered_event["result"]
        assert recovered["kind"] == "publish"
        assert recovered["receipt"] == accepted["receipt"]
        recovered_ref = decode_native_reference(recovered["reference"])
        assert recovered_ref["path"] == lost_options["path"]
        assert recovered_ref["retention"] == accepted["receipt"]["retention"]
        assert recovered_ref["expires_at"] == accepted["receipt"]["command"]["retention"]["until"]
        assert recovered_ref["root"] == accepted["receipt"]["head"]["root"]
        assert recovered_ref["generation"] == accepted["receipt"]["head"]["generation"]
        assert await recovery.exited() == 0
        recovered_data = await owner_reader.read_bytes(
            recovered["reference"], limit_bytes=lost_options["bytes"]
        )
        assert recovered_data == payload(lost_options["bytes"])
        go_recovered = await service.command(
            "go_read", user="owner", reference=recovered["reference"]
        )
        assert go_recovered["bytes"] == len(recovered_data)
        assert go_recovered["sha256"] == digest(recovered_data)
        pad = await native_scratchpad(**options)
        await pad.release(recovered["reference"])
        reused = set()
        for cycle in range(10):
            value = payload(513 + cycle)
            item = await pad.publish_bytes(
                value, "/reuse.bin", operation_id=f"python-reuse-{cycle}", ttl_seconds=600
            )
            assert await owner_reader.read_bytes(item["reference"]) == value
            reused.add(item["receipt"]["retention"]["slot"])
            await pad.release(item["reference"])
            view = await pad.maintain()
            assert not view["closed"]
            assert sum(bool(slot.get("pin")) for slot in view["retentions"]) == 1
        assert len(reused) == 1
        retained = []
        for slot in range(7):
            item = await pad.publish_bytes(
                payload(20 + slot),
                "/capacity.bin",
                operation_id=f"python-capacity-{slot}",
                ttl_seconds=600,
            )
            retained.append(item["reference"])
        full = await pad.describe()
        assert sum(bool(slot.get("pin")) for slot in full["volume"]["retentions"]) == 8
        await refused(
            pad.publish_bytes(b"refuse", "/ninth.bin", operation_id="python-ninth"), "capacity"
        )
        assert await pad.describe() == full
        for item in retained:
            await pad.release(item)
        await pad.maintain()
        await pad.close()
        fault_nc = await connect_as(service, "owner", fault=True)
        connections.append(fault_nc)
        pad = await native_scratchpad(**{**options, "nc": fault_nc, "timeout_s": 1})
        await service.command("drop_next_publish")
        with pytest.raises(Exception) as unknown:
            await pad.commit("first commit survived", "/first-commit.txt", None)
        assert getattr(unknown.value, "unknown", False)
        first = await service.command("accepted_latest")
        assert (await pad.describe())["pending"] == "publish"
        second = await pad.commit("second commit succeeded", "/second-commit.txt", None)
        assert await owner_reader.read(second) == "second commit succeeded"
        after = await pad.describe()
        assert after.get("pending") is None
        next_command = after["volume"]["writers"][0]["receipt"]["command"]
        assert next_command["number"] == first["receipt"]["command"]["number"] + 1
        assert next_command["base"] == first["receipt"]["head"]
        first_ref = encode_native_reference(
            {
                **decode_native_reference(second),
                "root": first["receipt"]["head"]["root"],
                "generation": first["receipt"]["head"]["generation"],
                "retention": first["receipt"]["retention"],
                "expires_at": first["receipt"]["command"]["retention"]["until"],
                "path": "/first-commit.txt",
            }
        )
        assert await owner_reader.read(first_ref) == "first commit survived"
        await pad.close()
        pad = None
        counts = await service.close()
        assert counts == {
            "commands": 9,
            "accepted_receipts": 2,
            "dropped_replies": 2,
            "go_publications": 1,
            "go_reads": 2,
            "service_restarts": 1,
        }
        print(
            "PYTHON_NATIVE",
            json.dumps(
                {
                    "bytes": len(data),
                    "streamed_bytes": len(streamed),
                    "streamed_chunks": chunks,
                    "recovered_bytes": len(recovered_data),
                    "denied_reads": 4,
                    "live_process_lock_refusals": 1,
                    "same_process_lock_refusals": 1,
                    "missing_journal_refusals": 1,
                    "retention_reuse_cycles": 10,
                    "reused_slots": len(reused),
                    "full_retention_refusals_unchanged": 1,
                    "stale_reset_preserved_pending": 1,
                    "implicit_commit_recoveries": 1,
                    "exact_recovered_receipts": 1,
                    "killed_clients": 1,
                    "fixture": counts,
                }
            ),
        )
    finally:
        for worker in workers:
            await worker.kill()
        if pad:
            await pad.close()
        for connection in connections:
            await connection.close()


@pytest.mark.skipif(not TYPESCRIPT, reason="set SCRATCHPAD_TYPESCRIPT_PACKAGE for direct interop")
async def test_python_typescript_interop(service: NativeService, tmp_path: Path) -> None:
    from synadia_ai.agent_fabric import native_scratchpad, scratchpad_reader

    assert TYPESCRIPT
    package = Path(TYPESCRIPT)
    assert (package / "dist" / "index.js").is_file()
    owner = await connect_as(service, "owner")
    reader_nc = await connect_as(service, "reader")
    empty = tmp_path / "empty-path"
    empty.mkdir(mode=0o700)
    directory = tmp_path / "python"
    directory.mkdir(mode=0o700)
    ts_directory = tmp_path / "typescript"
    ts_directory.mkdir(mode=0o700)
    pad = None
    workers = []
    try:
        pad = await native_scratchpad(
            nc=owner,
            volume=service.config["volume"],
            dir=directory,
            creator="agents.python.ts.interop",
        )
        value = payload(1024 * 1024 + 193)
        publication = await pad.publish_bytes(
            value, "/from-python.bin", operation_id="python-typescript-interop", ttl_seconds=600
        )
        reader_identity = service.config["users"]["reader"]
        grantee = {key: reader_identity[key] for key in ("account", "user")}
        await pad.grant_read(publication["reference"], Grantee(**grantee))
        shared = {"url": service.config["url"], "empty_path": str(empty), "bytes": len(value)}
        ts_reader = await NativeWorker.start(
            "read",
            {
                **shared,
                "credentials": reader_identity["credentials"],
                "reference": publication["reference"],
            },
            typescript=package,
        )
        workers.append(ts_reader)
        assert await ts_reader.event() == {
            "event": "read",
            "bytes": len(value),
            "sha256": digest(value),
        }
        assert await ts_reader.exited() == 0
        # The fixture's second reserved volume has a 64 KiB capacity.
        reverse_value = payload(4097)
        ts_writer = await NativeWorker.start(
            "publish",
            {
                **shared,
                "bytes": len(reverse_value),
                "credentials": service.config["users"]["owner"]["credentials"],
                "volume": "Recreated",
                "dir": str(ts_directory),
                "grantee": grantee,
            },
            typescript=package,
        )
        workers.append(ts_writer)
        from_ts = await ts_writer.event()
        assert from_ts["event"] == "published"
        assert await ts_writer.exited() == 0
        reader = await scratchpad_reader(nc=reader_nc)
        received = await reader.read_bytes(from_ts["reference"], limit_bytes=len(reverse_value))
        assert received == reverse_value
        assert len(received) == from_ts["bytes"]
        assert digest(received) == from_ts["sha256"]
        counts = await service.close()
        assert counts == {
            "commands": 1,
            "accepted_receipts": 0,
            "dropped_replies": 0,
            "go_publications": 0,
            "go_reads": 0,
            "service_restarts": 0,
        }
        print(
            "PYTHON_TYPESCRIPT_INTEROP",
            json.dumps(
                {
                    "python_to_typescript_bytes": len(value),
                    "typescript_to_python_bytes": len(received),
                    "python_to_typescript_sha256": digest(value),
                    "typescript_to_python_sha256": digest(received),
                    "fixture": counts,
                }
            ),
        )
    finally:
        for worker in workers:
            await worker.kill()
        if pad:
            await pad.close()
        await owner.close()
        await reader_nc.close()
