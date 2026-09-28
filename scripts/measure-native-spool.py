#!/usr/bin/env python3
"""Measure bounded streamed publication and event-loop gaps in both clients.

This uses the real core fixture and each client's ordinary durability settings.
It measures the full publication, including encoding, SQLite, and network work.
It does not isolate fsync latency or promise a deployment latency ceiling.
Run from python/ through uv after building the TypeScript package.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import resource
import sys
import time
from pathlib import Path

import nats

from synadia_ai.agent_fabric import native_scratchpad, scratchpad_reader

ROOT = Path(__file__).resolve().parents[1]
LARGE_ARTIFACT_MIB = 32
LARGE_SCOPE_OBJECTS = 512
sys.path.insert(0, str(ROOT / "python"))
from tests.harness.native_service import NativeService  # noqa: E402 -- checkout test harness


async def python_probe(  # noqa: PLR0915 -- one complete measured lifecycle
    fixture: NativeService, directory: Path, cycles: int, artifact_mib: int
) -> list[dict]:
    config = fixture.config
    nc = await nats.connect(
        config["url"],
        user_credentials=config["users"]["owner"]["credentials"],
        allow_reconnect=False,
    )
    options = dict(
        nc=nc, volume=config["volume"], creator="agents.native.spool-measurement", dir=directory
    )
    pad = None
    records = []
    try:
        pad = await native_scratchpad(**options)
        await pad.describe()
        reader = await scratchpad_reader(nc=nc)
        for cycle in range(cycles):
            expected = hashlib.sha256()
            input_bytes = 0

            def chunks(cycle=cycle, expected=expected):
                nonlocal input_bytes
                for index in range(2 * artifact_mib):
                    data = (
                        cycle.to_bytes(4, "big")
                        + index.to_bytes(4, "big")
                        + bytes([(cycle * 16 + index) % 256]) * (512 * 1024 - 8)
                    )
                    expected.update(data)
                    input_bytes += len(data)
                    yield data

            sample_start = time.perf_counter()
            last, max_gap, samples = sample_start, 0.0, 0
            stop = False
            started = asyncio.Event()

            async def sample():
                nonlocal last, max_gap, samples
                while not stop:  # noqa: B023 -- joined before the next cycle
                    await asyncio.sleep(0.005)
                    at = time.perf_counter()
                    max_gap = max(max_gap, at - last)
                    last = at
                    samples += 1
                    started.set()  # noqa: B023 -- joined before the next cycle

            sampling = asyncio.create_task(sample())
            try:
                await started.wait()
                begin = time.perf_counter()
                publication = await pad.publish_stream(
                    chunks(), "/large.bin", operation_id=f"spool-{cycle}"
                )
                publish_ms = 1000 * (time.perf_counter() - begin)
            finally:
                stop = True
                await sampling
                sample_end = time.perf_counter()
            assert samples >= 2  # noqa: PLR2004 -- one observation on each side
            assert input_bytes == artifact_mib * 1024 * 1024
            actual, read_bytes = hashlib.sha256(), 0
            async for chunk in reader.read_stream(
                publication["reference"], limit_bytes=input_bytes
            ):
                actual.update(chunk)
                read_bytes += len(chunk)
            assert read_bytes == input_bytes
            assert actual.digest() == expected.digest()
            occupied = (await pad.describe())["volume"]
            await pad.release(publication["reference"])
            marker = await pad.publish_bytes(
                f"cycle {cycle}".encode(), "/marker.txt", operation_id=f"marker-{cycle}"
            )
            await pad.release(marker["reference"])
            before_collection = (await pad.describe())["volume"]
            collected = await pad.maintain()
            assert collected["bytes"] < occupied["bytes"]
            assert collected["objects"] < occupied["objects"]
            await pad.close()
            high_water = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            records.append(
                dict(
                    language="python",
                    runtime=platform.python_version(),
                    platform=sys.platform,
                    arch=platform.machine(),
                    cycle=cycle,
                    artifactBytes=input_bytes,
                    generator="cycle-index-prefix-v1",
                    verifiedBytes=read_bytes,
                    sha256=expected.hexdigest(),
                    publishMs=publish_ms,
                    sampleWindowMs=1000 * (sample_end - sample_start),
                    requestedSampleMs=5,
                    samples=samples,
                    maxSchedulingGapMs=1000 * max_gap,
                    processLifetimeMaxRssBytes=high_water
                    if sys.platform == "darwin"
                    else high_water * 1024,
                    closedDatabaseBytes=(directory / "scratchpad.sqlite").stat().st_size,
                    collectedBytes=before_collection["bytes"] - collected["bytes"],
                    collectedObjects=before_collection["objects"] - collected["objects"],
                    writerCommand=marker["receipt"]["command"]["number"],
                )
            )
            print("NATIVE_SPOOL_RESULT", json.dumps(records[-1]), flush=True)
            pad = await native_scratchpad(**options)
            assert "pending" not in await pad.describe()
        return records
    finally:
        try:
            if pad:
                await pad.close()
        finally:
            await nc.close()


async def run(args) -> None:
    args.output.mkdir(parents=True, exist_ok=False)
    os.environ["SP_NATIVE_CLIENT_PROFILE"] = (
        "spool-32m" if args.artifact_mib == LARGE_ARTIFACT_MIB else ""
    )
    records = []
    for language in ("typescript", "python"):
        fixture = await NativeService.start(args.core_root)
        try:
            if args.artifact_mib == LARGE_ARTIFACT_MIB:
                assert fixture.config["profile"] == "spool-32m"
                assert fixture.config["scope_bytes"] == 128 * 1024 * 1024
                assert fixture.config["scope_objects"] == LARGE_SCOPE_OBJECTS
            directory = args.output / language / "workspace"
            if language == "python":
                part = await asyncio.wait_for(
                    python_probe(fixture, directory, args.cycles, args.artifact_mib), 150
                )
            else:
                process = await asyncio.create_subprocess_exec(
                    "node",
                    str(ROOT / "typescript/scripts/measure-native-spool.mjs"),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    output, errors = await asyncio.wait_for(
                        process.communicate(
                            json.dumps(
                                dict(
                                    config=fixture.config,
                                    directory=str(directory),
                                    cycles=args.cycles,
                                    artifactMiB=args.artifact_mib,
                                )
                            ).encode()
                        ),
                        150,
                    )
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                (args.output / "typescript.log").write_bytes(output + errors)
                if process.returncode:
                    raise RuntimeError(
                        f"TypeScript probe exited {process.returncode}; inspect typescript.log"
                    )
                part = [
                    json.loads(line.removeprefix("NATIVE_SPOOL_RESULT "))
                    for line in output.decode().splitlines()
                    if line.startswith("NATIVE_SPOOL_RESULT ")
                ]
            assert len(part) == args.cycles
            assert [row["writerCommand"] for row in part] == [
                2 * (i + 1) for i in range(args.cycles)
            ]
            records.extend(part)
        finally:
            counts = await fixture.close()
            (args.output / f"{language}-fixture.json").write_text(
                json.dumps(counts, indent=2) + "\n"
            )
        (args.output / "result.json").write_text(
            json.dumps(
                {
                    "scope": "local real service; complete publication; no timing ceiling",
                    "records": records,
                },
                indent=2,
            )
            + "\n"
        )
    assert len(records) == 2 * args.cycles
    for cycle in range(args.cycles):
        assert records[cycle]["sha256"] == records[cycle + args.cycles]["sha256"]
    print(
        json.dumps(
            {
                "completed_publications": len(records),
                "verified_bytes": sum(row["verifiedBytes"] for row in records),
                "cycles_per_language": args.cycles,
            }
        )
    )


def main() -> None:
    if not __debug__:
        raise RuntimeError("measurement assertions require ordinary, unoptimized Python")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cycles", type=int, choices=range(1, 11), default=3)
    parser.add_argument("--artifact-mib", type=int, choices=(7, LARGE_ARTIFACT_MIB), default=7)
    args = parser.parse_args()
    args.core_root, args.output = args.core_root.resolve(), args.output.resolve()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
