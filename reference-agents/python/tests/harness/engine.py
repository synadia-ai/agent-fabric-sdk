"""The durable engine for the durable tests: one ``durable-engine serve`` on the
test's nats-server, standalone, in the test's one account, on the prefix
``de``. The engine provisions its seven resources at start; the agent under
test creates nothing and reaches it on ``de.api.v1.*`` alone. The twin of the
TypeScript agent's ``test/harness/engine.ts``.

Adapted from the thin SDK's harness (``../durable-sdk`` ``python/tests/engine.py``,
at ``81df5ea``):

- the binary: ``DE_ENGINE`` (a path), or built with ``go build -tags
  devlicence`` from the engine checkout (``DE_ENGINE_REPO``, default
  ``../durable-engine`` next to this repo) at the commit the SDK's
  ``engine.pin`` names, into ``reference-agents/.engine-bin/``; a checkout at
  another commit or with local changes is refused unless ``DE_ENGINE_ANY=1``.
  Nothing is written in the checkout.
- the licence: a standalone ``serve`` starts only with one: ``DE_LICENCE``, or
  a test licence minted once per process by the ``durable-licence`` built
  beside the engine (``mint -test``), or ``DE_LICENCE_TOOL``.

Without the binary and without Go to build it, ``ENGINE_UNAVAILABLE`` says why
and the durable tests skip.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
import threading
from collections import deque
from pathlib import Path

AGENTS = Path(__file__).resolve().parents[3]
SDK = Path(os.environ.get("DE_SDK_REPO") or AGENTS.parents[1] / "durable-sdk")


def engine_pin() -> str:
    """The commit the thin SDK's ``engine.pin`` names."""
    return (SDK / "engine.pin").read_text(encoding="utf-8").strip()


def _resolve() -> tuple[str, str | None] | str:
    """The engine and its licence tool, or why they cannot be had (a wrong
    checkout raises: it must not skip silently)."""
    given = os.environ.get("DE_ENGINE", "")
    if given:
        if not (os.path.isfile(given) and os.access(given, os.X_OK)):
            raise RuntimeError(f"DE_ENGINE={given}: not an executable file")
        beside = Path(given).with_name("durable-licence")
        return given, str(beside) if beside.exists() else None
    src = Path(os.environ.get("DE_ENGINE_REPO") or AGENTS.parents[1] / "durable-engine")
    if not (src / "go.mod").exists():
        return f"no DE_ENGINE and no engine checkout at {src} (DE_ENGINE_REPO)"
    if not (SDK / "engine.pin").exists():
        return f"no thin SDK at {SDK} for its engine.pin (DE_SDK_REPO)"
    if shutil.which("go") is None:
        return f"no DE_ENGINE, and Go is not on PATH to build {src}"

    def git(*args: str) -> str:
        return subprocess.check_output(["git", "-C", str(src), *args], text=True).strip()

    pin = engine_pin()
    head = git("rev-parse", "HEAD")
    any_ = os.environ.get("DE_ENGINE_ANY") == "1"
    if not head.startswith(pin) and not any_:
        raise RuntimeError(
            f"the engine checkout {src} is at {head[:7]}, the SDK's engine.pin names {pin}: "
            f"check out {pin} there, point DE_ENGINE at a binary, or set DE_ENGINE_ANY=1"
        )
    dirty = git("status", "--porcelain", "--untracked-files=no") != ""
    if dirty and not any_:
        raise RuntimeError(f"the engine checkout {src} has local changes (DE_ENGINE_ANY=1 to run it anyway)")
    out = AGENTS / ".engine-bin"
    out.mkdir(exist_ok=True)
    tag = f"{head[:12]}{'-dirty' if dirty else ''}"
    binary = out / f"durable-engine-dev-{tag}"
    tool = out / f"durable-licence-{tag}"
    if not binary.exists() or not tool.exists() or dirty:
        build = ["go", "build", "-tags", "devlicence", "-o", str(binary), "./cmd/durable-engine"]
        subprocess.run(build, cwd=src, check=True)
        subprocess.run(["go", "build", "-o", str(tool), "./cmd/durable-licence"], cwd=src, check=True)
    return str(binary), str(tool)


_resolved = _resolve()

#: Why the durable tests skip, or ``None`` when the engine is there.
ENGINE_UNAVAILABLE: str | None = _resolved if isinstance(_resolved, str) else None

_licence: str | None = None


def _run_licence() -> str:
    """The licence the engines of this process start with: ``DE_LICENCE``, or one test licence minted once."""
    global _licence
    given = os.environ.get("DE_LICENCE", "")
    if given:
        return given
    if _licence is not None:
        return _licence
    if isinstance(_resolved, str):
        raise RuntimeError(_resolved)
    binary, beside = _resolved
    tool = os.environ.get("DE_LICENCE_TOOL") or beside
    if tool is None:
        raise RuntimeError(f"no durable-licence beside {binary}: set DE_LICENCE to a licence or DE_LICENCE_TOOL to the tool")
    out = Path(tempfile.mkdtemp(prefix="fabric-de-licence-")) / "licence.jwt"
    mint = [tool, "mint", "-test", "-name", "agent-fabric-sdk-tests", "-out", str(out)]
    subprocess.run(mint, check=True, capture_output=True)
    _licence = str(out)
    return _licence


class LocalEngine:
    """One ``durable-engine serve`` process, standalone, on the prefix ``de``. Its stderr is kept."""

    def __init__(self, proc: subprocess.Popen[bytes]) -> None:
        self._proc: subprocess.Popen[bytes] | None = proc
        self.log: deque[str] = deque(maxlen=2_000)
        self._serving = threading.Event()

    @classmethod
    async def start(cls, url: str, *, ack_wait_ms: int | None = None) -> LocalEngine:
        """Start an engine on ``url`` (a user of the test's account, its
        password in the URL) and wait for its ``serving`` line: it has
        provisioned the seven. Each is sized 256 MiB, so all of them fit a
        tenant's 4 GB of file storage."""
        if isinstance(_resolved, str):
            raise RuntimeError(_resolved)
        args = [_resolved[0], "serve", "--nats", url, "--prefix", "de", "--stream-max-bytes", str(256 * 1024 * 1024)]
        if ack_wait_ms is not None:
            args += ["--ack-wait", f"{ack_wait_ms}ms"]
        env = {**os.environ, "DE_LICENCE": _run_licence()}
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
        engine = cls(proc)
        threading.Thread(target=engine._read, args=(proc,), daemon=True).start()
        up = await asyncio.to_thread(engine._serving.wait, 30.0)
        if not up or proc.poll() is not None:
            proc.kill()
            raise RuntimeError(f"durable-engine serve did not come up ({proc.poll()}):\n" + "\n".join(engine.log))
        return engine

    def _read(self, proc: subprocess.Popen[bytes]) -> None:
        assert proc.stderr is not None
        echo = os.environ.get("DE_ENGINE_LOG") == "1"
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").rstrip("\n")
            self.log.append(line)
            if echo:
                print(f"[engine] {line}", flush=True)
            if "msg=serving" in line:
                self._serving.set()
        self._serving.set()  # exited: start() looks at the process

    async def stop(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            await asyncio.to_thread(proc.wait, 10.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            await asyncio.to_thread(proc.wait)
