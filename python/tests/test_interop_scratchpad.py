"""Grant requests across languages: a Python requester against a TypeScript creator.

The caller (bob) runs ``AgentTools`` with the extension; the creator is
``test-fixtures/interop/ts-scratchpad-agent.ts`` (alice), fed to ``bun run -``
in ``typescript/``; the target (carol) reads references. The caller takes a
reference from the TypeScript creator's reply, passes it to the target, and
the TypeScript creator verifies the Python signature, reads the Python bytes,
and grants. Its refusals come back in the bytes this package writes. The
TypeScript suite runs the mirror image.

Skips when ``bun`` or the TypeScript package's dependencies are missing.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import nats
import pytest
import pytest_asyncio
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import (
    AgentId,
    Agents,
    AgentTools,
    Envelope,
    Identity,
    signer_from_creds_file,
)

from synadia_ai.agent_fabric import (
    TraceScope,
    bind_active_trace,
    encode_grant_reply,
    encode_grant_request,
    fabric_tracing,
    grant_subject,
    random_thread_id,
    scratch_pad_extension,
)
from tests.harness.nats_server import identity_fixture
from tests.interop import FABRIC_TS_MODULE, TS_DIR, interop_prereqs_missing
from tests.scratchpad_fake import MemoryScratchPad, make_reference
from tests.support import REPO_ROOT

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

    from tests.harness.nats_server import RunningServer

HOST_SCRIPT = REPO_ROOT / "test-fixtures" / "interop" / "ts-scratchpad-agent.ts"
READY_MARKER = "agent service listening on "
STARTUP_TIMEOUT_S = 30.0
_REF = re.compile(r"sp-ref:[A-Za-z0-9_-]+")
_KEYS = json.loads(identity_fixture("operator/keys.json").read_text(encoding="utf-8"))


def _id(user: str) -> str:
    u = _KEYS["users"][user]
    return str(AgentId.new(_KEYS["accounts"][u["account"]]["public"], u["public"]))


BOB, CAROL = _id("bob"), _id("carol")

pytestmark = pytest.mark.skipif(
    interop_prereqs_missing() is not None, reason=str(interop_prereqs_missing())
)


@dataclass
class TsAgent:
    """The TypeScript agent in a ``bun`` subprocess, and the events it printed."""

    proc: subprocess.Popen[str]
    subject: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    tail: list[str] = field(default_factory=list)

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e.get("event") == kind]


async def _start_ts_agent(url: str, creds: str, agent: str) -> TsAgent:
    proc = subprocess.Popen(
        ["bun", "run", "-"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        cwd=str(TS_DIR),
        env={
            **os.environ,
            "NATS_URL": url,
            "NATS_CREDS_FILE": creds,
            "AGENT": agent,
            "FABRIC_MODULE": str(FABRIC_TS_MODULE),
        },
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write(HOST_SCRIPT.read_text(encoding="utf-8"))
    proc.stdin.close()
    host = TsAgent(proc)
    loop = asyncio.get_running_loop()
    ready: asyncio.Future[None] = loop.create_future()
    stdout = proc.stdout

    def read() -> None:
        # One reader thread for the process's life: events keep arriving.
        for line in stdout:
            host.tail.append(line)
            if line.startswith("{"):
                host.events.append(json.loads(line))
            elif READY_MARKER in line and not ready.done():
                host.subject = line.split(READY_MARKER, 1)[1].strip()
                loop.call_soon_threadsafe(ready.set_result, None)
        if not ready.done():
            loop.call_soon_threadsafe(
                ready.set_exception,
                RuntimeError(f"TS agent exited before ready:\n{''.join(host.tail[-20:])}"),
            )

    loop.run_in_executor(None, read)
    await asyncio.wait_for(ready, STARTUP_TIMEOUT_S)
    return host


async def _stop(host: TsAgent) -> None:
    if host.proc.poll() is not None:
        return
    host.proc.terminate()
    try:
        await asyncio.get_running_loop().run_in_executor(None, lambda: host.proc.wait(timeout=5))
    except subprocess.TimeoutExpired:
        host.proc.kill()


@dataclass
class Side:
    ts: TsAgent
    client: Agents
    tools: AgentTools
    bob_nc: NATSClient
    scope: TraceScope
    seen_by_target: list[str]

    async def call(self, address: str, prompt: str, tool_call_id: str) -> dict[str, Any]:
        with bind_active_trace(self.scope):
            return await self.tools.execute(
                "prompt_agent", {"address": address, "prompt": prompt}, tool_call_id=tool_call_id
            )


@pytest_asyncio.fixture
async def side(nats_server_operator: RunningServer) -> AsyncIterator[Side]:
    url = nats_server_operator.url
    ts = await _start_ts_agent(url, str(identity_fixture("operator/alice.creds")), "ts-creator")
    nc_carol = await nats.connect(
        url, user_credentials=str(identity_fixture("operator/carol.creds")), allow_reconnect=False
    )
    nc_bob = await nats.connect(
        url, user_credentials=str(identity_fixture("operator/bob.creds")), allow_reconnect=False
    )
    seen: list[str] = []
    target = AgentService(
        nc=nc_carol,
        agent="py-target",
        owner="interop",
        session_name="t1",
        identity=ServiceIdentity(
            signer=signer_from_creds_file(identity_fixture("operator/carol.creds"))
        ),
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        extra_metadata={"scratchpad_refs_ok": "true"},
    )

    async def at_target(envelope: Envelope, stream: PromptStream) -> None:
        seen.append(envelope.prompt)
        await stream.send("read")

    target.on_prompt(at_target)
    await target.start()
    client = Agents(
        nc=nc_bob,
        identity=Identity(signer=signer_from_creds_file(identity_fixture("operator/bob.creds"))),
        interceptors=[fabric_tracing().prompt_interceptor],
    )
    ext = scratch_pad_extension(scratch_pad=MemoryScratchPad("vol-bob"), agents=client)
    tools = AgentTools(client, extensions=[ext])
    scope = TraceScope(random_thread_id(), random_thread_id())
    try:
        yield Side(ts, client, tools, nc_bob, scope, seen)
    finally:
        await tools.aclose()
        await client.close()
        await target.stop()
        await _stop(ts)
        await nc_bob.close()
        await nc_carol.close()


async def test_a_python_requester_passes_on_a_typescript_creators_reference(side: Side) -> None:
    creator = side.ts.subject
    result = await side.call(creator, "commit", "toolu_commit")
    assert result["state"] == "completed"
    match = _REF.search(result["reply"])
    assert match is not None
    reference = match.group(0)
    [first_hand] = side.ts.of("grant")
    assert first_hand["reference"] == reference and first_hand["grantee"] == BOB
    assert (first_hand["kind"], first_hand["root_id"]) == ("first-hand", side.scope.root_id)

    result = await side.call("agents.prompt.py-target.interop.t1", f"use {reference}", "toolu_pass")
    assert result["state"] == "completed" and result["reply"] == "read"
    assert side.seen_by_target == [f"use {reference}"]
    # The TypeScript creator got the Python bytes, verified the Python
    # signature, and granted on request under the call.
    assert [e["data"].encode() for e in side.ts.of("request")] == [
        encode_grant_request(
            {
                "reference": reference,
                "grantee": CAROL,
                "trace": {
                    "thread_id": side.scope.thread_id,
                    "root_id": side.scope.root_id,
                    "tool_call_id": "toolu_pass",
                },
            }
        )
    ]
    assert side.ts.of("grant")[-1] == {
        "event": "grant",
        "reference": reference,
        "grantee": CAROL,
        "thread_id": side.scope.thread_id,
        "root_id": side.scope.root_id,
        "tool_call_id": "toolu_pass",
        "kind": "on-request",
    }


async def test_a_typescript_creator_refuses_in_the_bytes_this_package_writes(side: Side) -> None:
    subject = grant_subject(side.ts.subject)
    never = make_reference("vol-ts-creator", "/99.md", side.ts.subject)
    body = encode_grant_request({"reference": never, "grantee": CAROL})
    signed = await side.client.request_signed(subject, body, timeout_s=5.0)
    assert signed.data == encode_grant_reply(
        {
            "granted": False,
            "reason": "this agent holds no live read grant it made to the requester on that "
            "reference",
        }
    )
    unsigned = await side.bob_nc.request(subject, body, timeout=5.0)
    assert unsigned.data == encode_grant_reply({"granted": False, "reason": "signature required"})
    assert not signed.headers and not unsigned.headers
