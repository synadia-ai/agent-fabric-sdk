#!/usr/bin/env python3
"""Python worker for native-sustained.py; the wire contract is in docs/."""
# ruff: noqa: PLR2004 -- fixed qualification bounds are specified in the plan

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import resource
import sys
import time
from pathlib import Path

import nats

from synadia_ai.agent_fabric import native_scratchpad, scratchpad_reader
from synadia_ai.agent_fabric.scratchpad import Grantee

CHUNK = 512 * 1024
LANGUAGE = 2
PRIVATE_VALUES = set()


def failure(error: Exception) -> dict:
    message = str(error)
    for secret in PRIVATE_VALUES:
        message = message.replace(secret, "[redacted]")
    message = re.sub(r"(nats://)[^/@\s]+@", r"\1[redacted]@", message)
    return {
        "code": getattr(error, "code", "worker"),
        "message": message,
        "unknown": getattr(error, "unknown", False),
    }


class Worker:
    def __init__(self):
        self.pad = None
        self.owner = None
        self.connection = None
        self.watch_task = None
        self.maintenance = False
        self.samples = []
        self.failures = []

    async def writer(self, ttl):
        return await native_scratchpad(
            nc=self.owner,
            volume=self.volume,
            dir=self.directory,
            creator="agents.native.sustained.python",
            timeout_s=2,
            ttl_seconds=ttl,
        )

    async def read(self, request):
        started = time.monotonic()
        digest = hashlib.sha256()
        count = 0
        async for chunk in self.reader.read_stream(
            request["reference"], limit_bytes=request["bytes"]
        ):
            count += len(chunk)
            digest.update(chunk)
        return {
            "bytes": count,
            "sha256": digest.hexdigest(),
            "durationMs": 1000 * (time.monotonic() - started),
        }

    async def watch(self, request):
        due = time.monotonic()
        while not self.watch_done.is_set():
            start = time.monotonic()
            phase = self.maintenance
            row = {"monotonicStartMs": start * 1000, "maintenanceAtStart": phase}
            try:
                result = await self.read(request)
                row.update(result)
                if result["bytes"] != request["bytes"] or result["sha256"] != request["sha256"]:
                    raise RuntimeError("canary bytes or digest differ")
                row["outcome"] = "ok"
            except Exception as error:
                row.update(error=failure(error), outcome="error")
                if getattr(error, "code", None) == "closed" and (phase or self.maintenance):
                    row["outcome"] = "closed"
                else:
                    self.failures.append(row)
            row.update(monotonicEndMs=time.monotonic() * 1000, maintenanceAtEnd=self.maintenance)
            row.setdefault("durationMs", row["monotonicEndMs"] - row["monotonicStartMs"])
            self.samples.append(row)
            if len(self.samples) > 1900:
                self.failures.append({"error": "canary sample bound exceeded"})
                return
            due += 1
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.watch_done.wait(), max(0.001, due - time.monotonic()))

    async def stop_watch(self):
        if self.watch_task is not None:
            self.watch_done.set()
            await self.watch_task
            self.watch_task = None
        result = {
            "samples": self.samples,
            "monotonicStartMs": getattr(self, "watch_started_ms", 0),
            "monotonicEndMs": time.monotonic() * 1000,
        }
        if self.failures:
            result["failures"] = self.failures
        return result

    async def publish(self, request):
        digest = hashlib.sha256()
        count = 0
        if request["bytes"] not in (1 << 20, 8 << 20, 32 << 20):
            raise RuntimeError("artifact size outside workload contract")

        def chunks():
            nonlocal count
            for index in range(request["bytes"] // CHUNK):
                prefix = b"".join(n.to_bytes(4, "big") for n in (LANGUAGE, request["cycle"], index))
                data = prefix + bytes([(LANGUAGE * 67 + request["cycle"] * 17 + index) % 256]) * (
                    CHUNK - 12
                )
                count += len(data)
                digest.update(data)
                yield data

        stop = asyncio.Event()
        ready = asyncio.Event()
        samples = 0
        gap = 0.0

        async def sample():
            nonlocal samples, gap
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.005)
                at = time.monotonic()
                gap = max(gap, at - last)
                last = at
                samples += 1
                ready.set()

        sampling = asyncio.create_task(sample())
        await ready.wait()
        started = time.monotonic()
        result = {}
        try:
            result["publication"] = await self.pad.publish_stream(
                chunks(),
                "/artifact.bin",
                operation_id=request["operationId"],
                ttl_seconds=3600,
            )
        except Exception as error:
            result["error"] = failure(error)
        finally:
            result["publishMs"] = 1000 * (time.monotonic() - started)
            stop.set()
            await sampling
        result.update(
            inputBytes=count, sha256=digest.hexdigest(), samples=samples, maxGapMs=1000 * gap
        )
        return result

    async def command(self, request):  # noqa: PLR0911, PLR0912, PLR0915 -- explicit wire dispatcher
        command = request["command"]
        if command == "open":
            self.config = request["config"]
            self.directory = Path(request["directory"])
            self.volume = request["volume"]
            self.ttl = request["grantTtlSeconds"]
            for role in ("owner", "reader"):
                content = Path(self.config["users"][role]["credentials"]).read_text()
                PRIVATE_VALUES.add(content)
                PRIVATE_VALUES.update(
                    line for line in content.splitlines() if line and not line.startswith("-")
                )
            self.owner = await nats.connect(
                self.config["fault_url"],
                user_credentials=self.config["users"]["owner"]["credentials"],
                allow_reconnect=False,
            )
            self.connection = await nats.connect(
                self.config["url"],
                user_credentials=self.config["users"]["reader"]["credentials"],
                allow_reconnect=False,
            )
            self.reader = await scratchpad_reader(nc=self.connection, timeout_s=2)
            self.grantee = Grantee(
                account=self.config["users"]["reader"]["account"],
                user=self.config["users"]["reader"]["user"],
            )
            self.pad = await self.writer(self.ttl)
            return {"description": await self.pad.describe(), "pid": os.getpid()}
        if command == "canary":
            await self.pad.close()
            self.pad = await self.writer(3600)
            data = bytes([LANGUAGE]) * 4096
            publication = await self.pad.publish_bytes(
                data, "/canary.bin", operation_id="canary-python"
            )
            await self.pad.grant_read(publication["reference"], self.grantee)
            await self.pad.close()
            self.pad = await self.writer(self.ttl)
            return {
                "publication": publication,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        if command == "publish":
            return await self.publish(request)
        if command == "read":
            return await self.read(request)
        if command == "grant":
            await self.pad.grant_read(request["reference"], self.grantee)
            token = request["reference"].removeprefix("sp-ref:")
            ref = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
            view = (await self.pad.describe())["volume"]
            matches = [
                row["grant"]
                for row in view["grants"]
                if row.get("grant")
                and row["grant"]["root"] == ref["root"]
                and row["grant"]["path"] == ref["path"]
                and row["grant"]["retention"] == ref["retention"]
                and row["grant"]["principal"]
                == {"account": self.grantee.account, "user": self.grantee.user}
            ]
            if len(matches) != 1:
                raise RuntimeError("expected exactly one observed handoff grant")
            return {"until": matches[0]["until"]}
        if command == "release":
            await self.pad.release(request["reference"])
            return {"released": True}
        if command == "maintain":
            before = (await self.pad.describe())["volume"]
            started = time.monotonic()
            after = await self.pad.maintain()
            return {
                "before": before,
                "after": after,
                "durationMs": 1000 * (time.monotonic() - started),
            }
        if command == "recover":
            return await self.pad.recover()
        if command == "inspect":
            sizes = {}
            for field, suffix in (
                ("databaseBytes", ""),
                ("walBytes", "-wal"),
                ("journalBytes", "-journal"),
            ):
                path = self.directory / ("scratchpad.sqlite" + suffix)
                sizes[field] = (
                    path.stat().st_size if field == "databaseBytes" or path.exists() else 0
                )
            maximum = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return {
                "description": await self.pad.describe(),
                **sizes,
                "maxRssBytes": maximum if sys.platform == "darwin" else maximum * 1024,
            }
        if command == "watch":
            if self.watch_task is not None:
                raise RuntimeError("watch is already running")
            self.samples, self.failures = [], []
            self.maintenance = False
            self.watch_done = asyncio.Event()
            self.watch_started_ms = time.monotonic() * 1000
            self.watch_task = asyncio.create_task(self.watch(request))
            return {"watching": True, "monotonicStartMs": self.watch_started_ms}
        if command == "watch-phase":
            self.maintenance = request["maintenance"]
            return {"maintenance": self.maintenance}
        if command == "watch-stop":
            return await self.stop_watch()
        if command == "stop":
            watch = await self.stop_watch()
            if self.pad:
                await self.pad.close()
            for nc in (self.owner, self.connection):
                if nc:
                    await nc.close()
            return {"stopped": True, **watch}
        raise RuntimeError("unknown worker command")


async def main():
    worker = Worker()
    while line := await asyncio.to_thread(sys.stdin.readline):
        request = json.loads(line)
        try:
            result = {"id": request["id"], "value": await worker.command(request)}
        except Exception as error:
            result = {"id": request["id"], "error": failure(error)}
        print(json.dumps(result), flush=True)
        if request["command"] == "stop":
            break


if __name__ == "__main__":
    asyncio.run(main())
