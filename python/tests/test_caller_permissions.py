"""A caller with exactly a caller's permissions, in operator mode.

erin, an ACME user whose JWT carries the allow lists of
``test-fixtures/identity/operator/caller-permissions.json``, prompts an agent
alice hosts without limits. It lists, finds, prompts and asks; its edge
record lands on ``TRACE.edges`` and validates; the prompt is a root, and its
root is the one ``prompt()`` returned; the agent sees erin verified. Without
``$SYS.REQ.USER.INFO`` the signed prompt fails. The TypeScript suite's
``fabric-caller.test.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import nats
import pytest
import pytest_asyncio
from synadia_ai.agent_service import AgentService
from synadia_ai.agents import AgentId, SenderInfo, VerifiedSender

from synadia_ai.agent_fabric import (
    CANNOT_ANSWER,
    FabricCaller,
    FabricCallerError,
    fabric_caller,
    fabric_tracing,
)
from tests.harness.nats_server import identity_fixture
from tests.support import edge_schema_errors

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer

ALICE = identity_fixture("operator/alice.creds")
ERIN = identity_fixture("operator/erin.creds")
ERIN_NO_USER_INFO = identity_fixture("operator/erin-no-user-info.creds")
PERMISSIONS = json.loads(
    identity_fixture("operator/caller-permissions.json").read_text(encoding="utf-8")
)
_OP_KEYS = json.loads(identity_fixture("operator/keys.json").read_text(encoding="utf-8"))
_USER_KEYS = json.loads(identity_fixture("keys.json").read_text(encoding="utf-8"))
ERIN_ID = AgentId.new(_OP_KEYS["accounts"]["ACME"]["public"], _USER_KEYS["users"]["erin"]["public"])
USER_INFO = "$SYS.REQ.USER.INFO"

pytestmark = pytest.mark.asyncio(loop_scope="module")


def _user_claims(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    found = re.search(r"-----BEGIN NATS USER JWT-----\s*(\S+)\s*-+END NATS USER JWT", text)
    assert found is not None
    body = found.group(1).split(".")[1]
    claims: dict[str, Any] = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    return dict(claims["nats"])


async def test_erin_allows_exactly_the_list() -> None:
    claims = _user_claims(ERIN)
    assert claims["pub"] == {"allow": PERMISSIONS["pub"]}
    assert claims["sub"] == {"allow": PERMISSIONS["sub"]}
    assert USER_INFO in PERMISSIONS["pub"]


async def test_erin_without_user_info_allows_the_rest() -> None:
    claims = _user_claims(ERIN_NO_USER_INFO)
    assert claims["pub"] == {"allow": [s for s in PERMISSIONS["pub"] if s != USER_INFO]}
    assert claims["sub"] == {"allow": PERMISSIONS["sub"]}


@dataclass
class Seen:
    prompt: str
    sender: SenderInfo | None
    answer: str | None = None


@dataclass
class World:
    server: RunningServer
    alice: Any
    svc: AgentService
    caller: FabricCaller
    seen: list[Seen] = field(default_factory=list)


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def world(nats_server_operator: RunningServer) -> AsyncIterator[World]:
    alice = await nats.connect(nats_server_operator.url, user_credentials=str(ALICE))
    seen: list[Seen] = []

    async def handler(envelope: Any, stream: Any) -> None:
        entry = Seen(prompt=envelope.prompt, sender=stream.sender)
        seen.append(entry)
        if envelope.prompt.startswith("ask:"):
            answer = await stream.ask("which colour?", timeout=3.0)
            entry.answer = answer.prompt
            await stream.send(f"got {answer.prompt}")
        else:
            await stream.send(f"echo: {envelope.prompt}")

    svc = AgentService(
        nc=alice,
        agent="writer",
        owner="fabric",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=[fabric_tracing().request_interceptor],
    )
    svc.on_prompt(handler)
    await svc.start()
    caller = await fabric_caller(creds=ERIN, url=nats_server_operator.url, name="erin-cli")
    try:
        yield World(nats_server_operator, alice, svc, caller, seen)
    finally:
        await caller.close()
        await svc.stop()
        await alice.close()


async def test_lists_the_agent(world: World) -> None:
    found = await world.caller.list()
    assert [a.agent for a in found] == ["writer"]


async def test_finds_it_by_address_and_by_kind(world: World) -> None:
    by_kind = await world.caller.find("writer")
    assert (await world.caller.find(by_kind.prompt_subject)).prompt_subject == (
        by_kind.prompt_subject
    )
    with pytest.raises(
        FabricCallerError, match=re.escape(f'no agent "nobody"; there: {by_kind.prompt_subject}')
    ):
        await world.caller.find("nobody")


async def test_prompts_one_root_edge_with_the_returned_root(world: World) -> None:
    target = await world.caller.find("writer")
    edges: list[Msg] = []
    prompts: list[Msg] = []

    async def on_edge(msg: Msg) -> None:
        edges.append(msg)

    async def on_prompt(msg: Msg) -> None:
        prompts.append(msg)

    subs = [
        await world.alice.subscribe("TRACE.edges", cb=on_edge),
        await world.alice.subscribe(target.prompt_subject, cb=on_prompt),
    ]
    await world.alice.flush()
    started = await world.caller.prompt(target, "hello")
    text = ""
    async for msg in started.stream:
        text += getattr(msg, "text", "")
    root = await started.root_id
    await asyncio.sleep(0.2)
    for sub in subs:
        await sub.unsubscribe()

    assert text == "echo: hello"
    assert len(edges) == 1
    record = json.loads(edges[0].data)
    assert edge_schema_errors(record) == []
    assert record["parent_id"] is None
    assert record["thread_id"] == record["root_id"] == root
    assert record["agent"] == str(ERIN_ID)
    assert prompts[0].data.decode() == (
        f'{{"prompt":"hello","thread_id":"{root}","root_id":"{root}"}}'
    )
    sender = world.seen[-1].sender
    assert isinstance(sender, VerifiedSender)
    assert sender.id == ERIN_ID


async def test_asks_the_whole_reply_and_its_root(world: World) -> None:
    reply = await world.caller.ask("writer", "hi")
    assert reply.text == "echo: hi"
    assert re.fullmatch(r"[0-9a-f]{32}", reply.root_id)


async def test_answers_a_question_with_on_query(world: World) -> None:
    reply = await world.caller.ask("writer", "ask: colour", on_query=lambda _q: "blue")
    assert reply.text == "got blue"
    assert world.seen[-1].answer == "blue"


async def test_tells_the_agent_it_cannot_answer_without_on_query(world: World) -> None:
    reply = await world.caller.ask("writer", "ask: colour")
    assert reply.text == f"got {CANNOT_ANSWER}"


async def test_fails_the_signed_prompt_without_user_info(world: World) -> None:
    limited = await fabric_caller(creds=ERIN_NO_USER_INFO, url=world.server.url)
    try:
        with pytest.raises(Exception, match=r"USER\.INFO"):
            await limited.ask("writer", "hello")
    finally:
        await limited.close()
