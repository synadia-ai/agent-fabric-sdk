"""Cross-language clients against the core repository's actual native service."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any


class NativeService:
    def __init__(self, process: asyncio.subprocess.Process, directory: Path) -> None:
        self.process = process
        self.directory = directory
        self.config: dict[str, Any] = {}
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self.ready: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.sequence = 0
        self.diagnostics = ""
        self.closed = False
        self.output = asyncio.create_task(self._read())
        self.errors = asyncio.create_task(self._stderr())

    async def _stderr(self) -> None:
        assert self.process.stderr is not None
        while data := await self.process.stderr.read(4096):
            self.diagnostics = (self.diagnostics + data.decode())[-131072:]

    async def _read(self) -> None:
        assert self.process.stdout is not None
        try:
            while line := await self.process.stdout.readline():
                text = line.decode()
                if not text.startswith("SP_NATIVE "):
                    self.diagnostics = (self.diagnostics + text)[-131072:]
                    continue
                message = json.loads(text[len("SP_NATIVE ") :])
                if message.get("event") == "ready":
                    self.ready.set_result(message)
                    continue
                future = self.pending.pop(message["id"])
                if "error" in message:
                    future.set_exception(RuntimeError(f"fixture: {message['error']}"))
                else:
                    future.set_result(message["value"])
        except Exception as error:
            self._fail(error)
        finally:
            await self.errors
            self._fail(RuntimeError(f"native fixture exited: {self.diagnostics}"))

    def _fail(self, error: Exception) -> None:
        for future in [self.ready, *self.pending.values()]:
            if not future.done():
                future.set_exception(error)
        self.pending.clear()

    @classmethod
    async def start(cls, root: Path) -> NativeService:
        directory = Path(tempfile.mkdtemp(prefix="scratchpad-python-service-"))
        fixture: NativeService | None = None
        try:
            binary = directory / "fixture"
            build = await asyncio.create_subprocess_exec(
                "go",
                "test",
                "-c",
                "-o",
                str(binary),
                "./internal/volumeservice",
                cwd=root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            try:
                output, _ = await asyncio.wait_for(build.communicate(), 120)
            except BaseException:
                build.kill()
                await build.wait()
                raise
            if build.returncode != 0:
                raise RuntimeError(f"native fixture build failed: {output.decode()}")
            process = await asyncio.create_subprocess_exec(
                str(binary),
                "-test.run=^TestNativeClientFixtureProcess$",
                "-test.timeout=180s",
                cwd=root,
                env={**os.environ, "SP_NATIVE_CLIENT_FIXTURE": "1"},
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            fixture = cls(process, directory)
            fixture.config = await asyncio.wait_for(asyncio.shield(fixture.ready), 20)
            return fixture
        except BaseException:
            if fixture:
                await fixture.kill()
            shutil.rmtree(directory)
            raise

    async def command(self, command: str, **fields: Any) -> Any:
        if self.closed:
            raise RuntimeError("fixture is closed")
        self.sequence += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[self.sequence] = future
        assert self.process.stdin is not None
        self.process.stdin.write(
            json.dumps({**fields, "id": self.sequence, "command": command}).encode() + b"\n"
        )
        await self.process.stdin.drain()
        return await asyncio.wait_for(asyncio.shield(future), 15)

    async def kill(self) -> None:
        if self.process.returncode is None:
            self.process.kill()
        await asyncio.wait_for(self.process.wait(), 5)
        await asyncio.gather(self.output, self.errors)

    async def close(self) -> dict[str, int]:
        try:
            counts = await self.command("stop")
            code = await asyncio.wait_for(self.process.wait(), 15)
            if code != 0:
                raise RuntimeError(f"fixture exit {code}: {self.diagnostics}")
            return counts
        finally:
            self.closed = True
            await self.kill()
            shutil.rmtree(self.directory)


class NativeWorker:
    def __init__(self, process: asyncio.subprocess.Process) -> None:
        self.process = process
        self.errors = asyncio.create_task(self._errors())

    async def _errors(self) -> str:
        assert self.process.stderr is not None
        return (await self.process.stderr.read()).decode()

    @classmethod
    async def start(
        cls, mode: str, options: dict[str, Any], *, typescript: Path | None = None
    ) -> NativeWorker:
        if typescript:
            node = shutil.which("node")
            if not node:
                raise RuntimeError("explicit TypeScript interoperability requires node")
            command = [
                node,
                str(Path(__file__).with_name("native_typescript_worker.mjs")),
                str(typescript),
                mode,
                json.dumps(options),
            ]
        else:
            command = [
                sys.executable,
                str(Path(__file__).with_name("native_worker.py")),
                mode,
                json.dumps(options),
            ]
        process = await asyncio.create_subprocess_exec(
            *command,
            env={**os.environ, "PATH": options["empty_path"], "SCRATCHPAD_BIN": "sp-unavailable"},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return cls(process)

    async def event(self) -> dict[str, Any]:
        assert self.process.stdout is not None
        line = await asyncio.wait_for(self.process.stdout.readline(), 20)
        if not line:
            raise RuntimeError(f"native worker exited: {await self.errors}")
        return json.loads(line)

    async def exited(self) -> int:
        result = await asyncio.wait_for(self.process.wait(), 10)
        errors = await self.errors
        if result != 0:
            raise RuntimeError(f"native worker exit {result}: {errors}")
        return result

    async def kill(self) -> int:
        if self.process.returncode is None:
            self.process.kill()
        result = await asyncio.wait_for(self.process.wait(), 5)
        await self.errors
        return result
