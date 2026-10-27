"""The durable engine for the durable tests: one ``durable-engine serve`` on the
test's nats-server, standalone, in the test's one account, on the prefix
``de``. The engine provisions its seven resources at start; the agent under
test creates nothing and reaches it on ``de.api.v1.*`` alone. The twin of the
TypeScript agent's ``test/harness/engine.ts``.

Adapted from the thin SDK's harness (``durable-sdk`` ``python/tests/engine.py``,
at ``81df5ea``).

The engine comes from Synadia, with a licence file:

- the binary: ``DE_ENGINE``, the path of the engine's executable.
- the licence: a standalone ``serve`` starts only with one; the engine reads
  its file from ``DE_LICENCE``.

Without ``DE_ENGINE``, ``ENGINE_UNAVAILABLE`` says why and the durable tests
skip. A ``DE_ENGINE`` that is not an executable fails the run.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import threading
from collections import deque


def _resolve() -> str | None:
    """Why there is no engine, or ``None`` when ``DE_ENGINE`` names one."""
    given = os.environ.get("DE_ENGINE", "")
    if not given:
        return "DE_ENGINE is not set: the path of the engine from Synadia (and DE_LICENCE, its licence file)"
    if not (os.path.isfile(given) and os.access(given, os.X_OK)):
        raise RuntimeError(f"DE_ENGINE={given}: not an executable file")
    return None


#: Why the durable tests skip, or ``None`` when the engine is there.
ENGINE_UNAVAILABLE: str | None = _resolve()


def _hint() -> str:
    """What a failed start adds to the engine's log: the licence it was not given."""
    return "" if os.environ.get("DE_LICENCE") else " (DE_LICENCE is not set)"


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
        if ENGINE_UNAVAILABLE is not None:
            raise RuntimeError(ENGINE_UNAVAILABLE)
        args = [os.environ["DE_ENGINE"], "serve", "--nats", url, "--prefix", "de", "--stream-max-bytes", str(256 * 1024 * 1024)]
        if ack_wait_ms is not None:
            args += ["--ack-wait", f"{ack_wait_ms}ms"]
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        engine = cls(proc)
        threading.Thread(target=engine._read, args=(proc,), daemon=True).start()
        up = await asyncio.to_thread(engine._serving.wait, 30.0)
        if not up or proc.poll() is not None:
            proc.kill()
            raise RuntimeError(f"durable-engine serve did not come up ({proc.poll()}){_hint()}:\n" + "\n".join(engine.log))
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
