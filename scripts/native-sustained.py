#!/usr/bin/env python3
"""Finite native SDK workload. See docs/native-sustained-plan.md for fixed gates."""
# ruff: noqa: PLR2004 -- fixed qualification bounds are specified in the plan

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from tests.harness.native_service import NativeService  # noqa: E402

LANGUAGES = ("typescript", "python")
MIB = 1024 * 1024
SIZES = (MIB, 8 * MIB, 32 * MIB)
CADENCE = 10


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def expected(language, cycle, size):
    """Independent oracle; does not trust either worker's generated digest."""
    identifier = LANGUAGES.index(language) + 1
    digest = hashlib.sha256()
    for index in range(size // (512 * 1024)):
        prefix = identifier.to_bytes(4, "big") + cycle.to_bytes(4, "big") + index.to_bytes(4, "big")
        digest.update(prefix)
        digest.update(bytes([(identifier * 67 + cycle * 17 + index) % 256]) * (512 * 1024 - 12))
    return {"bytes": size, "sha256": digest.hexdigest()}


def check_read(actual, wanted):
    require(
        "error" not in actual
        and actual["bytes"] == wanted["bytes"]
        and actual["sha256"] == wanted["sha256"],
        "read size or SHA-256 differs from the independent oracle",
    )


def other(language):
    return LANGUAGES[1 - LANGUAGES.index(language)]


class WorkerError(RuntimeError):
    def __init__(self, result):
        self.result = result
        super().__init__(json.dumps(result))


class Worker:
    def __init__(self, process, errors):
        self.process, self.errors, self.sequence = process, errors, 0

    @classmethod
    async def start(cls, language, output, generation):
        command = (
            ["node", str(ROOT / "typescript/scripts/native-sustained-worker.mjs")]
            if language == "typescript"
            else [sys.executable, str(ROOT / "scripts/native-sustained-worker.py")]
        )
        errors = (output / f"{language}-{generation}.log").open("x")
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=errors,
            limit=2 * MIB,
        )
        return cls(process, errors)

    async def command(self, command, **fields):
        self.sequence += 1
        self.process.stdin.write(
            json.dumps(dict(id=self.sequence, command=command, **fields)).encode() + b"\n"
        )
        await self.process.stdin.drain()
        line = await asyncio.wait_for(self.process.stdout.readline(), 20)
        require(line, f"worker exited during {command}")
        reply = json.loads(line)
        require(reply["id"] == self.sequence, "worker response is out of order")
        if "error" in reply:
            raise WorkerError(reply["error"])
        return reply["value"]

    async def kill(self):
        if self.process.returncode is None:
            self.process.kill()
        await asyncio.wait_for(self.process.wait(), 5)
        self.errors.close()
        return self.process.returncode

    async def close(self):
        try:
            if self.process.returncode is None:
                result = await self.command("stop")
                code = await asyncio.wait_for(self.process.wait(), 5)
                require(code == 0, f"worker stop exited {code}")
                require(not result.get("failures"), "worker stop contains canary failures")
            else:
                require(
                    self.process.returncode == 0,
                    f"worker exited {self.process.returncode}",
                )
        finally:
            self.errors.close()


async def fixture(binary, scratch):
    directory = Path(tempfile.mkdtemp(prefix="fixture-", dir=scratch))
    service = None
    try:
        process = await asyncio.create_subprocess_exec(
            str(binary),
            "-test.run=^TestNativeClientFixtureProcess$",
            "-test.timeout=2100s",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={
                **os.environ,
                "SP_NATIVE_CLIENT_FIXTURE": "1",
                "SP_NATIVE_CLIENT_PROFILE": "sustained-128m",
            },
        )
        service = NativeService(process, directory)
        service.config = await asyncio.wait_for(asyncio.shield(service.ready), 20)
        config = service.config
        require(
            config["profile"] == "sustained-128m"
            and config["scope_bytes"] == 128 * MIB
            and config["scope_objects"] == 512
            and config["replicas"] == 1
            and set(config["volumes"]) == set(LANGUAGES),
            "fixture profile differs",
        )
        return service
    except BaseException:
        try:
            if service is not None:
                await service.kill()
        finally:
            shutil.rmtree(directory)
        raise


async def open_worker(language, generation, service, scratch, output):
    worker = await Worker.start(language, output, generation)
    try:
        opened = await worker.command(
            "open",
            config=service.config,
            volume=service.config["volumes"][language],
            directory=str(scratch / language),
            grantTtlSeconds=20,
        )
        return worker, opened
    except BaseException:
        await worker.kill()
        raise


def canary_expected(language):
    return {
        "bytes": 4096,
        "sha256": hashlib.sha256(bytes([LANGUAGES.index(language) + 1]) * 4096).hexdigest(),
    }


def workspace_bytes(inspection):
    sizes = [inspection[field] for field in ("databaseBytes", "journalBytes", "walBytes")]
    require(
        all(size >= 0 for size in sizes) and 0 < sizes[0] <= 48 * MIB,
        "workspace database is missing or exceeds 48 MiB",
    )
    require(sum(sizes) <= 96 * MIB, "workspace database and journals exceeded 96 MiB")
    return sum(sizes)


def check_storage(observation):
    require(
        observation["native_stream"]["bytes"] <= 112 * MIB,
        "recorded native stream exceeded its bound",
    )
    require(
        observation["native_store"]["allocated_bytes"] <= 1024 * MIB,
        "recorded native allocation exceeded its bound",
    )
    for field in ("native_store", "physical_store"):
        require(
            observation[field]["vanished_entries"] == 0,
            "storage walk lost entries; this sample cannot establish the allocation bound",
        )


def check_watch(part, wanted):
    require(not part.get("failures"), "unexpected canary failure")
    require(part["samples"], "canary watcher performed no reads")
    for row in part["samples"]:
        require(row["outcome"] in ("ok", "closed"), "unexpected canary outcome")
        if row["outcome"] == "closed":
            require(
                row["maintenanceAtStart"] or row["maintenanceAtEnd"],
                "canary closed outside collection interval",
            )
        else:
            check_read(row, wanted)
        require(
            part["monotonicStartMs"]
            <= row["monotonicStartMs"]
            <= row["monotonicEndMs"]
            <= part["monotonicEndMs"],
            "canary sample falls outside its watch segment",
        )
    starts = [row["monotonicStartMs"] for row in part["samples"]]
    gaps = [starts[0] - part["monotonicStartMs"], part["monotonicEndMs"] - starts[-1]]
    for earlier, later in zip(part["samples"], part["samples"][1:], strict=False):
        require(
            later["monotonicStartMs"] >= earlier["monotonicEndMs"],
            "canary reads overlap or run backwards",
        )
        gaps.append(later["monotonicStartMs"] - earlier["monotonicStartMs"])
    require(max(gaps) <= 3000, "canary coverage gap exceeded three seconds")
    return max(gaps)


async def cleanup(workers, service, result, path):
    """Try every owned process and preserve evidence even when shutdown fails."""
    errors = []
    try:
        closed = await asyncio.gather(
            *[worker.close() for worker in workers.values()], return_exceptions=True
        )
        errors.extend(str(error) for error in closed if isinstance(error, BaseException))
        for worker in workers.values():
            if worker.process.returncode is None:
                try:
                    await worker.kill()
                except BaseException as error:
                    errors.append(str(error))
    finally:
        try:
            result["fixture"] = await service.close()
        except BaseException as error:
            errors.append(str(error))
        finally:
            result["cleanupErrors"] = errors
            if errors:
                result["complete"] = False
            write(path, result)


async def controls(binary, scratch, output):
    """Real-data controls: wrong reference and leaked retentions, then recovery."""
    service = await fixture(binary, scratch)
    workers = {}
    result = {"wrong_reference_rejected": False, "languages": {}}
    try:
        for language in LANGUAGES:
            workers[language], _ = await open_worker(language, 0, service, scratch, output)
        canaries = dict(
            zip(
                LANGUAGES,
                await asyncio.gather(*[workers[name].command("canary") for name in LANGUAGES]),
                strict=True,
            )
        )
        actual = await workers["typescript"].command(
            "read", reference=canaries["python"]["publication"]["reference"], bytes=4096
        )
        check_read(
            actual,
            {"bytes": 4096, "sha256": hashlib.sha256(bytes([2]) * 4096).hexdigest()},
        )
        try:
            check_read(
                actual,
                {
                    "bytes": 4096,
                    "sha256": hashlib.sha256(bytes([1]) * 4096).hexdigest(),
                },
            )
        except RuntimeError:
            result["wrong_reference_rejected"] = True
        require(
            result["wrong_reference_rejected"],
            "wrong reference escaped the read checker",
        )
        # Keep every retention live. Automatic admission collection must preserve it.
        for language in LANGUAGES:
            attempts = []
            result["languages"][language] = {"attempts": attempts}
            refusal = None
            for cycle in range(5):
                publication = await workers[language].command(
                    "publish",
                    cycle=cycle,
                    bytes=32 * MIB,
                    operationId=f"sustained-{language}-{cycle}",
                )
                attempts.append(publication)
                if "error" in publication:
                    refusal = publication["error"]
                    break
                check_read(
                    {
                        "bytes": publication["inputBytes"],
                        "sha256": publication["sha256"],
                    },
                    expected(language, cycle, 32 * MIB),
                )
            require(
                refusal and refusal["code"] == "capacity",
                "leaked retentions did not reach the real scope quota",
            )
            require(
                len(attempts) == 4 and all("publication" in attempt for attempt in attempts[:3]),
                "quota control must accept three 32 MiB artifacts before refusing the fourth",
            )
            inspected = await workers[language].command("inspect")
            result["languages"][language]["quotaInspection"] = inspected
            require(
                "pending" not in inspected["description"],
                "quota refusal left an unintended pending write",
            )
            volume = inspected["description"]["volume"]
            for accepted in attempts[:3]:
                receipt = accepted["publication"]["receipt"]
                handle = receipt["retention"]
                retained = volume["retentions"][handle["slot"]]
                require(
                    retained["generation"] == handle["generation"]
                    and retained.get("pin", {}).get("root") == receipt["head"]["root"],
                    "quota refusal discarded a live artifact retention",
                )
            for accepted in attempts[:3]:
                await workers[language].command(
                    "release", reference=accepted["publication"]["reference"]
                )
            maintained = await workers[language].command("maintain")
            require(
                maintained["before"]["bytes"] - maintained["after"]["bytes"] >= 64 * MIB,
                "collection did not free both old 32 MiB control artifacts",
            )
            retried = await workers[language].command(
                "publish",
                cycle=99,
                bytes=32 * MIB,
                operationId=f"sustained-{language}-99",
            )
            require(
                "publication" in retried,
                "writer failed to progress after control collection",
            )
            await workers[language].command("grant", reference=retried["publication"]["reference"])
            read = await workers[other(language)].command(
                "read", reference=retried["publication"]["reference"], bytes=32 * MIB
            )
            check_read(read, expected(language, 99, 32 * MIB))
            result["languages"][language].update(
                {
                    "attempts": attempts,
                    "refusal": refusal,
                    "before": maintained["before"],
                    "after": maintained["after"],
                    "verifiedAfterCollection": read,
                }
            )
        result["storage"] = await service.command("observe_storage")
        result["complete"] = True
        return result
    except BaseException as error:
        result["failure"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        await cleanup(workers, service, result, output / "controls.json")


async def workload(binary, scratch, output, cycles):  # noqa: PLR0912, PLR0915 -- ordered lifecycle milestones
    service = await fixture(binary, scratch)
    workers, canaries, records, faults = {}, {}, [], []
    watches = {name: [] for name in LANGUAGES}
    segments = {name: [] for name in LANGUAGES}
    watch_starts = {}
    result = {
        "mode": "qualification" if cycles == 180 else "rehearsal",
        "cycles": cycles,
        "cadenceSeconds": CADENCE,
        "records": records,
        "faults": faults,
        "watch": watches,
        "watchSegments": segments,
    }
    generation = dict.fromkeys(LANGUAGES, 0)
    fault_schedule = {cycles // 3: "typescript", 2 * cycles // 3: "python"}

    async def start_watches():
        for reader in LANGUAGES:
            canary = canaries[other(reader)]
            watch_starts[reader] = {"controllerMonotonicStartMs": time.monotonic() * 1000}
            watched = await workers[reader].command(
                "watch",
                reference=canary["publication"]["reference"],
                bytes=4096,
                sha256=canary["sha256"],
            )
            watch_starts[reader]["monotonicStartMs"] = watched["monotonicStartMs"]

    async def stop_watches():
        for name in LANGUAGES:
            try:
                part = await workers[name].command("watch-stop")
            except WorkerError as error:
                write(output / f"{name}-watch-failure.json", error.result)
                raise
            if part.get("failures"):
                write(output / f"{name}-watch-failure.json", part)
            require(
                part["monotonicStartMs"] == watch_starts[name]["monotonicStartMs"],
                "watch segment start differs from the recorded start",
            )
            part.update(
                generation=generation[name],
                controllerMonotonicStartMs=watch_starts[name]["controllerMonotonicStartMs"],
                controllerMonotonicEndMs=time.monotonic() * 1000,
            )
            segments[name].append(part)
            part["worstCoverageGapMs"] = check_watch(part, canary_expected(other(name)))
            watches[name].extend(part["samples"])

    try:
        for language in LANGUAGES:
            workers[language], opened = await open_worker(language, 0, service, scratch, output)
            require(
                "pending" not in opened["description"],
                "fresh workspace has pending intent",
            )
        canaries.update(
            zip(
                LANGUAGES,
                await asyncio.gather(*[workers[name].command("canary") for name in LANGUAGES]),
                strict=True,
            )
        )
        for name, canary in canaries.items():
            check_read(
                canary,
                {
                    "bytes": 4096,
                    "sha256": hashlib.sha256(bytes([LANGUAGES.index(name) + 1]) * 4096).hexdigest(),
                },
            )
        result["initialStorage"] = await service.command("observe_storage")
        # Compute all expected content before the timed interval.
        oracles = {
            (name, cycle): expected(name, cycle, SIZES[cycle % 3])
            for name in LANGUAGES
            for cycle in range(cycles)
        }
        await start_watches()
        started = time.monotonic()
        result["startedMonotonicMs"] = started * 1000
        result["startedUnixSeconds"] = time.time()
        with (output / "cycles.jsonl").open("x") as events:
            for cycle in range(cycles):
                due = started + cycle * CADENCE
                await asyncio.sleep(max(0, due - time.monotonic()))
                begin = time.monotonic()
                lag = begin - due
                require(lag <= 2, f"cycle {cycle} missed the offered schedule by {lag:.3f}s")
                size = SIZES[cycle % 3]
                if cycle in fault_schedule:
                    target = fault_schedule[cycle]
                    await service.command(
                        "drop_publish", operation_id=f"sustained-{target}-{cycle}"
                    )
                publications = dict(
                    zip(
                        LANGUAGES,
                        await asyncio.gather(
                            *[
                                workers[name].command(
                                    "publish",
                                    cycle=cycle,
                                    bytes=size,
                                    operationId=f"sustained-{name}-{cycle}",
                                )
                                for name in LANGUAGES
                            ]
                        ),
                        strict=True,
                    )
                )
                if cycle in fault_schedule:
                    target = fault_schedule[cycle]
                    failed = publications[target]
                    require(
                        failed.get("error", {}).get("unknown") is True,
                        "lost reply was not an unknown outcome",
                    )
                    require(
                        "publication" not in failed,
                        "withheld publication reply reached the writer",
                    )
                    captured = await service.command(
                        "accepted", operation_id=f"sustained-{target}-{cycle}"
                    )
                    pending = await workers[target].command("inspect")
                    require(
                        pending["description"].get("pending") == "publish",
                        "unknown publication intent was not persisted",
                    )
                    pause = time.monotonic()
                    await stop_watches()
                    exit_code = await workers[target].kill()
                    require(exit_code == -9, "fault writer was not killed with SIGKILL")
                    restarted = await service.command("restart_service")
                    require(restarted["restarted"], "service restart did not complete")
                    generation[target] += 1
                    workers[target], reopened = await open_worker(
                        target, generation[target], service, scratch, output
                    )
                    require(
                        reopened["description"].get("pending") == "publish",
                        "workspace lost its pending publication across process death",
                    )
                    recovered = await workers[target].command("recover")
                    require(
                        recovered["kind"] == "publish"
                        and recovered["receipt"] == captured["receipt"],
                        "recovered receipt differs from the real stored/dropped receipt",
                    )
                    publications[target]["publication"] = {
                        "receipt": recovered["receipt"],
                        "reference": recovered["reference"],
                    }
                    await start_watches()
                    faults.append(
                        {
                            "cycle": cycle,
                            "language": target,
                            "exitCode": exit_code,
                            "pauseMs": 1000 * (time.monotonic() - pause),
                            "pauseStartElapsedMs": 1000 * (pause - started),
                            "pauseEndElapsedMs": 1000 * (time.monotonic() - started),
                            "capturedReceipt": captured["receipt"],
                            "recoveredReceipt": recovered["receipt"],
                            "reopenedPending": reopened["description"]["pending"],
                        }
                    )
                row = {"cycle": cycle, "startLagMs": lag * 1000, "languages": {}}
                for name in LANGUAGES:
                    require(
                        "publication" in publications[name],
                        f"{name} publication failed: {publications[name]}",
                    )
                grants = await asyncio.gather(
                    *[
                        workers[name].command(
                            "grant",
                            reference=publications[name]
                            .get("publication", {})
                            .get("reference", ""),
                        )
                        for name in LANGUAGES
                    ]
                )
                reads = await asyncio.gather(
                    *[
                        workers[other(name)].command(
                            "read",
                            reference=publications[name]["publication"]["reference"],
                            bytes=size,
                        )
                        for name in LANGUAGES
                    ]
                )
                for index, name in enumerate(LANGUAGES):
                    published = publications[name]
                    require(
                        "publication" in published,
                        f"{name} publish failed at cycle {cycle}",
                    )
                    check_read(
                        {
                            "bytes": published["inputBytes"],
                            "sha256": published["sha256"],
                        },
                        oracles[name, cycle],
                    )
                    check_read(reads[index], oracles[name, cycle])
                    require(
                        published["samples"] >= 2,
                        "publication scheduling window has fewer than two samples",
                    )
                    require(
                        published["publication"]["receipt"]["command"]["number"] == cycle + 2,
                        "writer history did not advance exactly once",
                    )
                    row["languages"][name] = {
                        "publish": published,
                        "read": reads[index],
                        "grant": grants[index],
                    }
                    if cycle == 0:
                        try:
                            await workers[name].command(
                                "release",
                                reference=published["publication"]["reference"],
                            )
                        except WorkerError as error:
                            require(
                                error.result["code"] == "busy",
                                "live handoff release did not refuse busy",
                            )
                            row["languages"][name]["liveReleaseRefused"] = True
                        else:
                            raise RuntimeError("live handoff was evicted")
                    if cycle >= 3:
                        old = records[cycle - 3]["languages"][name]
                        require(
                            time.time() >= old["grant"]["until"],
                            "handoff release preceded the observed grant deadline",
                        )
                        await workers[name].command(
                            "release",
                            reference=old["publish"]["publication"]["reference"],
                        )
                await asyncio.gather(
                    *[workers[name].command("watch-phase", maintenance=True) for name in LANGUAGES]
                )
                collected = await asyncio.gather(
                    *[workers[name].command("maintain") for name in LANGUAGES]
                )
                await asyncio.gather(
                    *[workers[name].command("watch-phase", maintenance=False) for name in LANGUAGES]
                )
                after_reads = await asyncio.gather(
                    *[
                        workers[other(name)].command(
                            "read",
                            reference=canaries[name]["publication"]["reference"],
                            bytes=4096,
                        )
                        for name in LANGUAGES
                    ]
                )
                inspections = await asyncio.gather(
                    *[workers[name].command("inspect") for name in LANGUAGES]
                )
                for index, name in enumerate(LANGUAGES):
                    check_read(after_reads[index], canaries[name])
                    item = row["languages"][name]
                    item.update(
                        collection=collected[index],
                        inspect=inspections[index],
                        afterCollectionRead=after_reads[index],
                    )
                    volume = inspections[index]["description"]["volume"]
                    require(
                        "pending" not in inspections[index]["description"] and not volume["closed"],
                        "cycle left pending intent or closed volume",
                    )
                    require(
                        volume["bytes"] <= 42 * MIB and volume["objects"] <= 128,
                        "retained live set exceeded declared rolling bound",
                    )
                    require(
                        sum(bool(pin.get("pin")) for pin in volume["retentions"])
                        == min(cycle + 2, 4),
                        "retained handoff count differs",
                    )
                    require(
                        inspections[index]["databaseBytes"] <= 48 * MIB,
                        "sampled workspace exceeded 48 MiB",
                    )
                    workspace_bytes(inspections[index])
                    if cycle >= 3:
                        require(
                            collected[index]["before"]["bytes"]
                            > collected[index]["after"]["bytes"],
                            "old handoff content was not collected",
                        )
                row["storage"] = await service.command("observe_storage")
                check_storage(row["storage"])
                require(
                    row["storage"]["native_stream"]["bytes"] <= 112 * MIB,
                    "native stream retained too much data",
                )
                require(
                    row["storage"]["native_store"]["allocated_bytes"] <= 1024 * MIB,
                    "native store allocation exceeded 1 GiB",
                )
                row["durationMs"] = 1000 * (time.monotonic() - begin)
                require(
                    row["durationMs"] <= CADENCE * 1000,
                    f"cycle {cycle} exceeded its ten-second budget",
                )
                records.append(row)
                events.write(json.dumps(row) + "\n")
                events.flush()
                if cycle % 6 == 0:
                    print(
                        json.dumps(
                            {
                                "cycle": cycle,
                                "completedPublications": 2 * len(records),
                                "cycleMs": row["durationMs"],
                                "nativeBytes": row["storage"]["native_stream"]["bytes"],
                            }
                        ),
                        flush=True,
                    )
            await asyncio.sleep(max(0, started + cycles * CADENCE - time.monotonic()))
            final_reads = await asyncio.gather(
                *[
                    workers[other(name)].command(
                        "read",
                        reference=canaries[name]["publication"]["reference"],
                        bytes=4096,
                    )
                    for name in LANGUAGES
                ]
            )
            for index, name in enumerate(LANGUAGES):
                check_read(final_reads[index], canaries[name])
            result["finalReads"] = dict(zip(LANGUAGES, final_reads, strict=True))
            result["elapsedSeconds"] = time.monotonic() - started
            require(
                result["elapsedSeconds"] >= cycles * CADENCE,
                "workload ended before the full scheduled interval",
            )
            await stop_watches()
            result["finalStorage"] = await service.command("observe_storage")
            check_storage(result["finalStorage"])
            result["complete"] = True
        return result
    except BaseException as error:
        result["failure"] = {"type": type(error).__name__, "message": str(error)}
        raise
    finally:
        await cleanup(workers, service, result, output / "result.json")


def check_record(row, faults):
    """Recheck every saved cycle before reporting an interval as qualified."""
    cycle = row["cycle"]
    size = SIZES[cycle % len(SIZES)]
    require(
        0 <= row["startLagMs"] <= 2000 and 0 <= row["durationMs"] <= CADENCE * 1000,
        "recorded cycle exceeded its schedule or duration bound",
    )
    for language in LANGUAGES:
        item = row["languages"][language]
        publication = item["publish"]
        oracle = expected(language, cycle, size)
        check_read(
            {"bytes": publication["inputBytes"], "sha256": publication["sha256"]},
            oracle,
        )
        check_read(item["read"], oracle)
        check_read(item["afterCollectionRead"], canary_expected(language))
        require(publication["samples"] >= 2, "publication sampling is incomplete")
        command = publication["publication"]["receipt"]["command"]
        require(
            command["number"] == cycle + 2
            and command["operation_id"] == f"sustained-{language}-{cycle}",
            "recorded writer command differs from the scheduled publication",
        )
        fault = next(
            (
                fault
                for fault in faults
                if fault["cycle"] == cycle and fault["language"] == language
            ),
            None,
        )
        if fault:
            require(
                publication.get("error", {}).get("unknown") is True
                and publication["publication"]["receipt"] == fault["capturedReceipt"],
                "fault publication lacks its actual unknown result or recovered receipt",
            )
        else:
            require(
                "error" not in publication,
                "unexpected publication error in saved records",
            )
        description = item["inspect"]["description"]
        volume = description["volume"]
        require(
            "pending" not in description and not volume["closed"],
            "recorded cycle remained pending or closed",
        )
        require(
            volume["bytes"] <= 42 * MIB and volume["objects"] <= 128,
            "recorded live set exceeded declared rolling bound",
        )
        require(
            sum(bool(pin.get("pin")) for pin in volume["retentions"]) == min(cycle + 2, 4),
            "recorded retention count differs",
        )
        require(
            0 < item["inspect"]["databaseBytes"] <= 48 * MIB,
            "recorded workspace exceeded its bound or is missing",
        )
        workspace_bytes(item["inspect"])
        if cycle >= 3:
            require(
                item["collection"]["before"]["bytes"] > item["collection"]["after"]["bytes"],
                "recorded collection freed no old content",
            )
    require(
        row["storage"]["native_stream"]["bytes"] <= 112 * MIB,
        "recorded native stream exceeded its bound",
    )
    require(
        row["storage"]["native_store"]["allocated_bytes"] <= 1024 * MIB,
        "recorded native allocation exceeded its bound",
    )
    check_storage(row["storage"])


def summarize(result):
    require(result.get("complete"), "run is incomplete")
    require(
        not result.get("cleanupErrors") and not result.get("failure"),
        "run contains workload or cleanup failure",
    )
    records, cycles = result["records"], result["cycles"]
    if result["mode"] == "qualification":
        require(
            result["controls"]["sourceMatch"]
            and result["controls"]["quotaRefusals"] == 2
            and result["controls"]["wrongReferenceRejected"],
            "qualification lacks matching control evidence",
        )
    require(
        cycles in (12, 180)
        and result["cadenceSeconds"] == CADENCE
        and result["elapsedSeconds"] >= cycles * CADENCE,
        "recorded workload does not cover the declared interval",
    )
    require(
        len(records) == cycles and [row["cycle"] for row in records] == list(range(cycles)),
        "cycle coverage differs",
    )
    require(
        len(result["faults"]) == 2
        and result["fixture"]["dropped_replies"] == 2
        and result["fixture"]["accepted_receipts"] == 2
        and result["fixture"]["service_restarts"] == 2,
        "actual fault counts differ",
    )
    schedule = [(cycles // 3, "typescript"), (2 * cycles // 3, "python")]
    require(
        [(fault["cycle"], fault["language"]) for fault in result["faults"]] == schedule,
        "recorded faults differ from the declared schedule",
    )
    for fault in result["faults"]:
        require(
            fault["exitCode"] == -9
            and fault["reopenedPending"] == "publish"
            and fault["capturedReceipt"] == fault["recoveredReceipt"],
            "fault did not recover the exact accepted receipt after process death",
        )
        require(
            0
            <= fault["pauseStartElapsedMs"]
            <= fault["pauseEndElapsedMs"]
            <= result["elapsedSeconds"] * 1000,
            "restart pause lies outside the workload interval",
        )
    for row in records:
        check_record(row, result["faults"])
    for name in LANGUAGES:
        check_read(result["finalReads"][name], canary_expected(name))
    summary = {
        "complete": True,
        "mode": result["mode"],
        "elapsedSeconds": result["elapsedSeconds"],
        "publications": 2 * cycles,
        "verifiedBytes": 0,
        "faults": 2,
        "worstCycleMs": max(row["durationMs"] for row in records),
        "languages": {},
    }
    for name in LANGUAGES:
        parts = [row["languages"][name] for row in records]
        summary["verifiedBytes"] += sum(part["read"]["bytes"] for part in parts)
        quarters = []
        for quarter in range(4):
            selected = records[quarter * cycles // 4 : (quarter + 1) * cycles // 4]
            sizes = {}
            for size in SIZES:
                chosen = [
                    row["languages"][name]
                    for row in selected
                    if row["languages"][name]["read"]["bytes"] == size
                ]
                require(chosen, "time quarter lacks an artifact size")
                durations = sorted(p["publish"]["publishMs"] for p in chosen)
                sizes[str(size)] = {
                    "count": len(chosen),
                    "worstPublishMs": max(durations),
                    "medianPublishMs": durations[len(durations) // 2],
                    "worstReadMs": max(p["read"]["durationMs"] for p in chosen),
                }
            quarters.append(
                {
                    "quarter": quarter + 1,
                    "sizes": sizes,
                    "maxDatabaseBytes": max(
                        row["languages"][name]["inspect"]["databaseBytes"] for row in selected
                    ),
                    "maxJournalBytes": max(
                        row["languages"][name]["inspect"]["journalBytes"] for row in selected
                    ),
                    "maxWorkspaceBytes": max(
                        workspace_bytes(row["languages"][name]["inspect"]) for row in selected
                    ),
                    "maxRssBytes": max(
                        row["languages"][name]["inspect"]["maxRssBytes"] for row in selected
                    ),
                    "worstSchedulingGapMs": max(
                        row["languages"][name]["publish"]["maxGapMs"] for row in selected
                    ),
                }
            )
        segments = result["watchSegments"][other(name)]
        require(
            len(segments) == 3,
            "watch segment coverage differs from the two restart intervals",
        )
        gaps = [check_watch(segment, canary_expected(name)) for segment in segments]
        for segment in segments:
            actual_duration = segment["monotonicEndMs"] - segment["monotonicStartMs"]
            controller_duration = (
                segment["controllerMonotonicEndMs"] - segment["controllerMonotonicStartMs"]
            )
            require(
                abs(actual_duration - controller_duration) <= 3000,
                "watch segment does not cover its controller interval",
            )
        samples = [sample for segment in segments for sample in segment["samples"]]
        require(
            samples == result["watch"][other(name)],
            "watch samples differ from their segments",
        )
        start = result["startedMonotonicMs"]
        require(
            segments[0]["controllerMonotonicStartMs"] <= start + 3000
            and segments[-1]["controllerMonotonicEndMs"] >= start + cycles * CADENCE * 1000 - 3000,
            "watch segments omit an interval boundary",
        )
        for index, fault in enumerate(result["faults"]):
            end = segments[index]["controllerMonotonicEndMs"] - start
            begin = segments[index + 1]["controllerMonotonicStartMs"] - start
            require(
                fault["pauseStartElapsedMs"] <= end <= begin <= fault["pauseEndElapsedMs"],
                "canary watch paused outside the recorded restart interval",
            )
        summary["languages"][name] = {
            "quarters": quarters,
            "canaryReads": sum(row["outcome"] == "ok" for row in samples),
            "canaryClosedDuringMaintenance": sum(row["outcome"] == "closed" for row in samples),
            "worstCanaryMs": max(row["durationMs"] for row in samples),
            "worstCanaryCoverageGapMs": max(gaps),
            "watchSegments": [
                {
                    "generation": segment["generation"],
                    "sampleCount": len(segment["samples"]),
                    "worstCoverageGapMs": gap,
                    "durationMs": segment["monotonicEndMs"] - segment["monotonicStartMs"],
                }
                for segment, gap in zip(segments, gaps, strict=True)
            ],
            "databaseMinBytes": min(p["inspect"]["databaseBytes"] for p in parts),
            "databaseMaxBytes": max(p["inspect"]["databaseBytes"] for p in parts),
            "workspaceMaxBytes": max(workspace_bytes(p["inspect"]) for p in parts),
        }
    summary["storageQuarters"] = [
        {
            "quarter": q + 1,
            "nativeStreamMaxBytes": max(
                r["storage"]["native_stream"]["bytes"]
                for r in records[q * cycles // 4 : (q + 1) * cycles // 4]
            ),
            "nativeAllocatedMaxBytes": max(
                r["storage"]["native_store"]["allocated_bytes"]
                for r in records[q * cycles // 4 : (q + 1) * cycles // 4]
            ),
            "nativeFileMaxBytes": max(
                r["storage"]["native_store"]["logical_bytes"]
                for r in records[q * cycles // 4 : (q + 1) * cycles // 4]
            ),
        }
        for q in range(4)
    ]
    return summary


def controls_proof(directory, sources):
    require(
        directory is not None, "qualification requires --controls-evidence from matching sources"
    )
    raw = (directory / "controls.json").read_bytes()
    result = json.loads(raw)
    captured_sources = json.loads((directory / "sources.json").read_text())
    require(
        captured_sources["sources"] == sources["sources"], "controls used different source inputs"
    )
    require(
        result.get("complete")
        and not result.get("cleanupErrors")
        and not result.get("failure")
        and result["wrong_reference_rejected"]
        and set(result["languages"]) == set(LANGUAGES),
        "required controls did not complete",
    )
    for language in LANGUAGES:
        proof = result["languages"][language]
        require(
            len(proof["attempts"]) == 4
            and proof["attempts"][-1]["error"]["code"] == "capacity"
            and "pending" not in proof["quotaInspection"]["description"],
            "quota control boundary differs",
        )
        for cycle, attempt in enumerate(proof["attempts"][:3]):
            require(
                "publication" in attempt and "error" not in attempt,
                "quota control skipped an accepted artifact",
            )
            check_read(
                {"bytes": attempt["inputBytes"], "sha256": attempt["sha256"]},
                expected(language, cycle, 32 * MIB),
            )
        require(
            proof["before"]["bytes"] - proof["after"]["bytes"] >= 64 * MIB,
            "quota control did not demonstrate reclaimed content",
        )
        check_read(proof["verifiedAfterCollection"], expected(language, 99, 32 * MIB))
    return {
        "sourceMatch": True,
        "quotaRefusals": 2,
        "wrongReferenceRejected": True,
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


async def run(args):
    require(
        sys.platform == "linux" and sys.version_info >= (3, 12),
        "use the selected Linux/Python 3.12 environment",
    )
    output = args.output.resolve()
    scratch = Path(os.environ["TMPDIR"]).resolve()
    require(
        output != scratch and not scratch.is_relative_to(output),
        "credentials must stay outside exported evidence",
    )
    output.mkdir(parents=True, exist_ok=False)
    scratch.mkdir(parents=True, exist_ok=True)
    task_scratch = Path(tempfile.mkdtemp(prefix="sustained-", dir=scratch))
    core = Path(os.environ["SCRATCHPAD_CORE_ROOT"])
    environment = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "sqlite": sqlite3.sqlite_version,
        "node": subprocess.check_output(["node", "--version"], text=True).strip(),
        "go": subprocess.check_output(["go", "version"], text=True).strip(),
        "filesystem": subprocess.check_output(
            ["stat", "-f", "-c", "%T", str(task_scratch)], text=True
        ).strip(),
        "scope": "real authenticated service, R1 file-backed broker, local Linux storage",
    }
    write(output / "environment.json", environment)
    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/native-linux/sources.py"),
            "--sdk-root",
            str(ROOT),
            "--core-root",
            str(core),
            "--protocol-root",
            str(ROOT.parent / "synadia-agents"),
            "--output",
            str(output / "sources.json"),
            "--expected",
            str(args.expected_sources),
        ],
        check=True,
        timeout=30,
    )
    control_proof = None
    if args.mode == "qualification":
        control_proof = controls_proof(
            args.controls_evidence, json.loads((output / "sources.json").read_text())
        )
        write(output / "controls-proof.json", control_proof)
    binary = task_scratch / "fixture"
    with (output / "build.log").open("x") as log:
        subprocess.run(
            ["go", "test", "-c", "-o", str(binary), "./internal/volumeservice"],
            cwd=core,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=120,
        )
    if args.mode == "controls":
        result = await controls(binary, task_scratch, output)
        require(
            result.get("complete") and not result.get("cleanupErrors"),
            "controls or cleanup failed",
        )
        print(
            json.dumps(
                {
                    "complete": result["complete"],
                    "wrongReferenceRejected": result["wrong_reference_rejected"],
                    "quotaRefusals": len(result["languages"]),
                }
            ),
            flush=True,
        )
    else:
        result = await asyncio.wait_for(
            workload(
                binary,
                task_scratch,
                output,
                180 if args.mode == "qualification" else 12,
            ),
            1900,
        )
        try:
            if control_proof:
                result["controls"] = control_proof
            summary = summarize(result)
        except BaseException as error:
            result["complete"] = False
            result["failure"] = {"type": type(error).__name__, "message": str(error)}
            write(output / "result.json", result)
            raise
        write(output / "result.json", result)
        write(output / "summary.json", summary)
        print(json.dumps(summary, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("controls", "rehearsal", "qualification"), required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-sources", required=True, type=Path)
    parser.add_argument("--controls-evidence", type=Path)
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
