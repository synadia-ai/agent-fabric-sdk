"""Tracing interoperates across languages and with peers that have none.

A traced Python caller is adopted by a TypeScript host that runs the
fabric, and served by one that runs the protocol SDK alone (which passes
the two envelope fields through unread, §5.6). An untraced caller is
served by a traced TypeScript host, which mints a root of its own, and
sees nothing of tracing on the wire. In operator mode the caller's edge
record names the thread the TypeScript host adopted, verifies, and
validates against edge.json. A caller (``fabric_caller``, with a caller's
permissions only) prompts a TypeScript host, which adopts the root it
returned. The TypeScript suite runs the mirror image against a Python host.

The host is ``test-fixtures/interop/ts-agent-service-host.ts`` (from the
protocol SDK's interop host at synadia-agents c9d7bcb), fed to ``bun run
-`` in ``typescript/``. The cross-version case needs the last published,
pre-tracing ``@synadia-ai/agent-service`` installed somewhere::

    mkdir old-ts && cd old-ts && echo '{"type":"module"}' > package.json
    bun add @synadia-ai/agent-service@0.5.2 @synadia-ai/agents@0.5.2 @nats-io/transport-node
    export SYNADIA_INTEROP_PRETRACING_TS_DIR=$PWD

and skips when that variable is unset. Everything else skips only when
``bun`` or the TypeScript package's dependencies are missing.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

import nats
import pytest
from synadia_ai.agents import (
    AgentId,
    Agents,
    Identity,
    SenderSigner,
    VerifiedSender,
    signer_from_creds_file,
    verify_sender,
)

from synadia_ai.agent_fabric import TraceOptions, fabric_caller, fabric_tracing, is_thread_id
from tests.harness.nats_server import identity_fixture
from tests.interop import FABRIC_TS_MODULE, TS_DIR, interop_prereqs_missing
from tests.support import REPO_ROOT, capture, drain, edge_schema_errors

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer

HOST_SCRIPT = REPO_ROOT / "test-fixtures" / "interop" / "ts-agent-service-host.ts"
READY_MARKER = "agent service listening on "
STARTUP_TIMEOUT_S = 30.0
PRETRACING_TS_DIR_ENV = "SYNADIA_INTEROP_PRETRACING_TS_DIR"
CREDS = identity_fixture("operator/alice.creds")
CALLER_CREDS = identity_fixture("operator/erin.creds")
_ECHO = re.compile(
    r"^echo: (?P<prompt>.*?)(?: thread=(?P<thread>[0-9a-f]{32}) root=(?P<root>[0-9a-f]{32}))?$"
)

pytestmark = pytest.mark.skipif(
    interop_prereqs_missing() is not None, reason=str(interop_prereqs_missing())
)


class _TsHost:
    """A TypeScript ``AgentService`` in a ``bun`` subprocess."""

    def __init__(
        self,
        nats_url: str,
        *,
        agent: str,
        cwd: Path = TS_DIR,
        traced: bool = False,
        creds: Path | None = None,
    ) -> None:
        self._env = {
            **os.environ,
            "NATS_URL": nats_url,
            "AGENT": agent,
            "TRACE": "1" if traced else "0",
            "FABRIC_MODULE": str(FABRIC_TS_MODULE),
            **({"NATS_CREDS_FILE": str(creds)} if creds else {}),
        }
        self._cwd = cwd
        self._proc: subprocess.Popen[str] | None = None
        self.prompt_subject: str = ""
        self.stdout_tail: list[str] = []

    async def start(self) -> None:
        self._proc = subprocess.Popen(
            ["bun", "run", "-"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            cwd=str(self._cwd),
            env=self._env,
            text=True,
            bufsize=1,
        )
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._proc.stdin.write(HOST_SCRIPT.read_text(encoding="utf-8"))
        self._proc.stdin.close()
        loop = asyncio.get_running_loop()
        deadline = loop.time() + STARTUP_TIMEOUT_S
        while loop.time() < deadline:
            line = await loop.run_in_executor(None, self._proc.stdout.readline)
            if not line:
                raise RuntimeError(
                    f"TS host exited before ready (code={self._proc.poll()}); "
                    f"tail:\n{''.join(self.stdout_tail[-20:])}"
                )
            self.stdout_tail.append(line)
            if READY_MARKER in line:
                self.prompt_subject = line.split(READY_MARKER, 1)[1].strip()
                return
        raise TimeoutError(
            f"TS host not ready in {STARTUP_TIMEOUT_S}s:\n{''.join(self.stdout_tail)}"
        )

    async def stop(self) -> None:
        proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        proc.terminate()
        try:
            await asyncio.get_running_loop().run_in_executor(None, lambda: proc.wait(timeout=5))
        except subprocess.TimeoutExpired:
            proc.kill()


async def _host(nats_url: str, **kwargs: Any) -> AsyncIterator[_TsHost]:
    host = _TsHost(nats_url, **kwargs)
    await host.start()
    try:
        yield host
    finally:
        await host.stop()


def _traced(nc: NATSClient, options: TraceOptions, signer: SenderSigner | None = None) -> Agents:
    return Agents(
        nc=nc,
        identity=Identity(signer=signer) if signer is not None else None,
        interceptors=[fabric_tracing(options).prompt_interceptor],
    )


async def _echo(agents: Agents, subject: str, text: str) -> tuple[str, str | None, str | None]:
    """Prompt the host at ``subject``; return the echoed prompt and lineage."""
    found = await agents.discover(timeout=3.0)
    handle = next(a for a in found if a.prompt_subject == subject)
    texts = await drain(handle.prompt(text, timeout=10.0))
    assert len(texts) == 1, texts
    m = _ECHO.match(texts[0])
    assert m is not None, texts[0]
    return m.group("prompt"), m.group("thread"), m.group("root")


async def test_traced_python_caller_is_adopted_by_a_traced_ts_host(
    nats_server: RunningServer, nc: NATSClient
) -> None:
    async for host in _host(nats_server.url, agent="ts-traced", traced=True):
        prompts = await capture(nc, host.prompt_subject)
        agents = _traced(nc, TraceOptions(edge_subject=None))
        try:
            prompt, thread, root = await _echo(agents, host.prompt_subject, "hi")
        finally:
            await agents.close()
        assert prompt == "hi"
        sent = json.loads(prompts[0].data)
        assert is_thread_id(sent["thread_id"]) and sent["root_id"] == sent["thread_id"]
        # The host adopted the caller's lineage rather than dropping it or
        # minting its own.
        assert thread == sent["thread_id"]
        assert root == sent["root_id"]


async def test_untraced_python_caller_is_served_by_a_traced_ts_host(
    nats_server: RunningServer, nc: NATSClient
) -> None:
    async for host in _host(nats_server.url, agent="ts-mint", traced=True):
        prompts = await capture(nc, host.prompt_subject)
        traces = await capture(nc, "TRACE.>")
        agents = Agents(nc=nc)  # never traced
        try:
            prompt, thread, root = await _echo(agents, host.prompt_subject, "hi")
        finally:
            await agents.close()
        assert prompt == "hi"
        # Plain protocol 0.3 on the wire …
        assert prompts[0].data == b'{"prompt":"hi"}'
        # … and the host minted a root of its own for the execution.
        assert thread is not None and root == thread
        await asyncio.sleep(0.2)
        assert traces == [], "a host writes no trace record"


async def test_traced_python_caller_is_served_by_a_ts_host_without_the_fabric(
    nats_server: RunningServer, nc: NATSClient
) -> None:
    async for host in _host(nats_server.url, agent="ts-plain"):
        prompts = await capture(nc, host.prompt_subject)
        agents = _traced(nc, TraceOptions(edge_subject=None))
        try:
            prompt, thread, _root = await _echo(agents, host.prompt_subject, "hello plain host")
        finally:
            await agents.close()
        assert prompt == "hello plain host"
        assert thread is None, "a host without the fabric adopts nothing"
        assert list(json.loads(prompts[0].data)) == ["prompt", "thread_id", "root_id"]


async def test_traced_python_callers_edge_names_the_thread_the_ts_host_adopted(
    nats_server_operator: RunningServer,
) -> None:
    nc = await nats.connect(nats_server_operator.url, user_credentials=str(CREDS))
    keys = json.loads(identity_fixture("operator/keys.json").read_text(encoding="utf-8"))
    alice_id = AgentId.new(keys["accounts"]["ACME"]["public"], keys["users"]["alice"]["public"])
    try:
        async for host in _host(
            nats_server_operator.url, agent="ts-traced-op", traced=True, creds=CREDS
        ):
            edges = await capture(nc, "TRACE.edges")
            agents = _traced(nc, TraceOptions(), signer_from_creds_file(CREDS))
            try:
                prompt, thread, root = await _echo(agents, host.prompt_subject, "hi")
            finally:
                await agents.close()
            assert prompt == "hi"
            await asyncio.sleep(0.2)
            assert len(edges) == 1, [e.data for e in edges]
            record = json.loads(edges[0].data)
            assert edge_schema_errors(record) == []
            assert record["thread_id"] == thread, "the edge names the thread the host adopted"
            assert record["root_id"] == root
            assert record["parent_id"] is None
            sender = verify_sender(edges[0], "stored")
            assert isinstance(sender, VerifiedSender), "edge records are signed"
            # The body names the same writer the signed header attests.
            assert sender.id == alice_id
            assert record["agent"] == str(alice_id)
            # One id three ways: the body's record_id is the signed nonce and the Nats-Msg-Id.
            assert sender.header.nonce == record["record_id"]
            assert (edges[0].headers or {})["Nats-Msg-Id"] == record["record_id"]
    finally:
        await nc.close()


async def test_a_caller_prompts_a_ts_host_which_adopts_the_root_it_returned(
    nats_server_operator: RunningServer,
) -> None:
    nc = await nats.connect(nats_server_operator.url, user_credentials=str(CREDS))
    try:
        async for host in _host(
            nats_server_operator.url, agent="ts-for-caller", traced=True, creds=CREDS
        ):
            edges = await capture(nc, "TRACE.edges")
            async with await fabric_caller(
                creds=CALLER_CREDS, url=nats_server_operator.url
            ) as caller:
                reply = await caller.ask(host.prompt_subject, "from a caller")
            m = _ECHO.match(reply.text)
            assert m is not None, reply.text
            assert m.group("prompt") == "from a caller"
            assert m.group("thread") == m.group("root") == reply.root_id
            await asyncio.sleep(0.2)
            assert len(edges) == 1, [e.data for e in edges]
            record = json.loads(edges[0].data)
            assert edge_schema_errors(record) == []
            assert record["parent_id"] is None
            assert record["thread_id"] == record["root_id"] == reply.root_id
    finally:
        await nc.close()


@pytest.mark.skipif(
    PRETRACING_TS_DIR_ENV not in os.environ, reason=f"{PRETRACING_TS_DIR_ENV} unset"
)
async def test_traced_python_caller_against_the_last_published_ts_host(
    nats_server_operator: RunningServer,
) -> None:
    """A host that predates tracing sees two unknown envelope fields and
    nothing else; it must serve the prompt as if they were not there."""
    old_dir = Path(os.environ[PRETRACING_TS_DIR_ENV])
    nc = await nats.connect(nats_server_operator.url, user_credentials=str(CREDS))
    try:
        async for host in _host(nats_server_operator.url, agent="ts-old", cwd=old_dir, creds=CREDS):
            edges = await capture(nc, "TRACE.edges")
            agents = _traced(nc, TraceOptions(), signer_from_creds_file(CREDS))
            try:
                prompt, thread, _root = await _echo(agents, host.prompt_subject, "hello old host")
            finally:
                await agents.close()
            assert prompt == "hello old host"
            assert thread is None, "a pre-tracing host has no lineage to echo"
            await asyncio.sleep(0.2)
            assert len(edges) == 1, "the caller still records the edge"
            assert edge_schema_errors(json.loads(edges[0].data)) == []
    finally:
        await nc.close()
