"""The ``agent-fabric`` command with exactly a caller's permissions, in operator mode.

Run in process with ``erin.creds``: the agents listed, a reply streamed with
its root and reference on stderr, ``--json``, a question answered from
stdin, and the exit codes. The TypeScript suite's ``command.test.ts``.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import TYPE_CHECKING, Any

import nats
import pytest
import pytest_asyncio
from synadia_ai.agent_service import AgentService

from synadia_ai.agent_fabric import CANNOT_ANSWER, fabric_tracing
from synadia_ai.agent_fabric.cli import EXIT_FAILED, EXIT_OK, run_command
from tests.command_io import recording_io
from tests.harness.nats_server import identity_fixture

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer

ALICE = identity_fixture("operator/alice.creds")
ERIN = identity_fixture("operator/erin.creds")
REF = "sp-r1:rwxmJU9MR2qrq6urq6urq6urq6urq6urAAAAAAAAAAkQb4WlVJM_S1l6lm-1"
ROOT_LINE = re.compile(r"^root ([0-9a-f]{32})$", re.MULTILINE)

pytestmark = pytest.mark.asyncio(loop_scope="module")


class World:
    def __init__(self, server: RunningServer, alice: Any, svc: AgentService) -> None:
        self.server = server
        self.alice = alice
        self.svc = svc
        self.answers: list[str] = []
        self.env = {"NATS_CREDS": str(ERIN), "NATS_URL": server.url}

    @property
    def address(self) -> str:
        return self.svc.subject.prompt


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def world(nats_server_operator: RunningServer) -> AsyncIterator[World]:
    alice = await nats.connect(nats_server_operator.url, user_credentials=str(ALICE))
    svc = AgentService(
        nc=alice,
        agent="writer",
        owner="fabric",
        session_name="s",
        description="writes",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=[fabric_tracing().request_interceptor],
    )
    w = World(nats_server_operator, alice, svc)

    async def handler(envelope: Any, stream: Any) -> None:
        if envelope.prompt.startswith("fail:"):
            raise RuntimeError("refused")
        if envelope.prompt.startswith("ask:"):
            answer = await stream.ask("which colour?", timeout=3.0)
            w.answers.append(answer.prompt)
            await stream.send(f"got {answer.prompt}")
        else:
            await stream.send(f"echo: {envelope.prompt}. ")
            await stream.send(f"kept at {REF}")

    svc.on_prompt(handler)
    await svc.start()
    try:
        yield w
    finally:
        await svc.stop()
        await alice.close()


async def test_lists_the_agents(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["agents"], io) == EXIT_OK
    # The host registers no identity of its own.
    assert rec.out == f"{world.address}\twriter\tno identity\n"
    assert rec.err == f"url {world.server.url}\n"


async def test_lists_the_agents_as_json(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert json.loads(rec.out) == [
        {
            "address": world.address,
            "kind": "writer",
            "identity": None,
            "verified": False,
            "description": "writes",
        }
    ]


async def test_streams_the_reply_and_the_root_and_reference_on_stderr(world: World) -> None:
    edges: list[Msg] = []

    async def on_edge(msg: Msg) -> None:
        edges.append(msg)

    sub = await world.alice.subscribe("TRACE.edges", cb=on_edge)
    await world.alice.flush()
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "hello", "there"], io) == EXIT_OK
    await asyncio.sleep(0.2)
    await sub.unsubscribe()
    assert rec.out == f"echo: hello there. kept at {REF}\n"
    found = ROOT_LINE.search(rec.err)
    assert found is not None
    root = found.group(1)
    assert f"→ {world.address} (" in rec.err
    assert f"reference: {REF}\n" in rec.err
    record = json.loads(edges[0].data)
    assert record["parent_id"] is None
    assert record["root_id"] == record["thread_id"] == root


async def test_prints_one_json_object(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "hi", "--json"], io) == EXIT_OK
    out = json.loads(rec.out)
    assert list(out) == ["root", "text", "references"]
    found = ROOT_LINE.search(rec.err)
    assert found is not None
    assert out == {"root": found.group(1), "text": f"echo: hi. kept at {REF}", "references": [REF]}


async def test_answers_a_question_from_stdin(world: World) -> None:
    io, rec = recording_io(world.env, ["green"])
    assert await run_command(["prompt", "writer", "ask: colour"], io) == EXIT_OK
    assert "? which colour?\n" in rec.err
    assert rec.out == "got green\n"
    assert world.answers[-1] == "green"


async def test_tells_the_agent_it_cannot_answer_when_stdin_has_nothing(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "ask: colour"], io) == EXIT_OK
    assert rec.out == f"got {CANNOT_ANSWER}\n"


async def test_exits_1_for_no_such_agent(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "nobody", "hi"], io) == EXIT_FAILED
    assert f'agent-fabric: no agent "nobody"; there: {world.address}' in rec.err


async def test_exits_1_for_a_refused_prompt(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "fail: now"], io) == EXIT_FAILED
    assert "agent-fabric: no reply:" in rec.err


async def test_exits_1_for_creds_the_server_will_not_describe(world: World) -> None:
    env = {**world.env, "NATS_CREDS": str(identity_fixture("operator/erin-no-user-info.creds"))}
    io, rec = recording_io(env)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_FAILED
    assert "would not tell this creds file's identity" in rec.err


async def test_exits_1_when_it_cannot_connect(world: World) -> None:
    io, rec = recording_io({**world.env, "NATS_URL": "nats://127.0.0.1:1"})
    assert await run_command(["agents"], io) == EXIT_FAILED
    assert "url nats://127.0.0.1:1\n" in rec.err
    assert "could not connect to nats://127.0.0.1:1" in rec.err
