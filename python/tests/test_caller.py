"""The caller's rules without a server.

Which agent ``find`` picks, and what the options and the environment must
give before anything connects. The TypeScript suite's ``caller.test.ts``.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, cast

import pytest
from synadia_ai.agents import PromptExtras, PromptInterceptor, PromptInterceptorContext

from synadia_ai.agent_fabric import (
    FabricCallerError,
    fabric_caller,
    fabric_caller_from_env,
    pick_agent,
)
from synadia_ai.agent_fabric.caller import _RootCapturing
from tests.harness.nats_server import identity_fixture

if TYPE_CHECKING:
    from synadia_ai.agents import Agent

ERIN = identity_fixture("operator/erin.creds")


@dataclass(frozen=True)
class _Fake:
    agent: str
    prompt_subject: str


def agent(kind: str, name: str) -> Agent:
    return cast("Agent", _Fake(kind, f"agents.prompt.{kind}.acme.{name}"))


WRITER = agent("writer", "w1")
REVIEWER_A = agent("reviewer", "r1")
REVIEWER_B = agent("reviewer", "r2")
FOUND = [WRITER, REVIEWER_A, REVIEWER_B]


def test_takes_the_agent_at_that_address() -> None:
    assert pick_agent(FOUND, "agents.prompt.reviewer.acme.r2") is REVIEWER_B


def test_takes_the_one_agent_of_a_kind() -> None:
    assert pick_agent(FOUND, "writer") is WRITER


def test_counts_two_instances_behind_one_address_as_one_agent() -> None:
    assert pick_agent([WRITER, agent("writer", "w1")], "writer") is WRITER


def test_refuses_a_kind_two_agents_have_naming_both() -> None:
    with pytest.raises(FabricCallerError) as caught:
        pick_agent(FOUND, "reviewer")
    assert str(caught.value) == (
        '2 agents of kind "reviewer": agents.prompt.reviewer.acme.r1, '
        "agents.prompt.reviewer.acme.r2; name one by its address"
    )
    assert caught.value.reason == "ambiguous"


def test_names_what_is_there_when_nothing_matches() -> None:
    with pytest.raises(
        FabricCallerError, match=re.escape('no agent "nobody"; there: agents.prompt.writer')
    ):
        pick_agent([WRITER], "nobody")
    with pytest.raises(FabricCallerError) as caught:
        pick_agent([], "nobody")
    assert str(caught.value) == 'no agent "nobody"; there: nobody'
    assert caught.value.reason == "not-found"


async def test_needs_a_url_and_says_where_it_comes_from(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NATS_URL", raising=False)
    with pytest.raises(FabricCallerError) as caught:
        await fabric_caller(creds=ERIN)
    assert caught.value.reason == "config"
    assert "the URL the console showed next to your creds file" in str(caught.value)


async def test_needs_a_creds_file() -> None:
    with pytest.raises(FabricCallerError, match="NATS_CREDS") as caught:
        await fabric_caller(creds="", url="nats://127.0.0.1:1")
    assert caught.value.reason == "config"


async def test_takes_the_url_from_nats_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NATS_URL", "nats://127.0.0.1:1")
    with pytest.raises(
        FabricCallerError, match=re.escape("could not connect to nats://127.0.0.1:1")
    ) as c:
        await fabric_caller(creds=ERIN)
    assert c.value.reason == "connect"


async def test_prefers_the_option_to_nats_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NATS_URL", "nats://127.0.0.1:1")
    with pytest.raises(
        FabricCallerError, match=re.escape("could not connect to nats://127.0.0.1:2")
    ):
        await fabric_caller(creds=ERIN, url="nats://127.0.0.1:2")


async def test_reads_nats_creds_and_nats_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("NATS_CREDS", raising=False)
    monkeypatch.setenv("NATS_URL", "nats://127.0.0.1:1")
    with pytest.raises(FabricCallerError) as caught:
        await fabric_caller_from_env()
    assert caught.value.reason == "config"
    monkeypatch.setenv("NATS_CREDS", str(ERIN))
    with pytest.raises(FabricCallerError, match=re.escape("nats://127.0.0.1:1")) as caught:
        await fabric_caller_from_env()
    assert caught.value.reason == "connect"


async def test_refuses_a_name_the_identity_would_refuse_before_connecting() -> None:
    # The URL has no server: a connect would fail with reason "connect".
    with pytest.raises(FabricCallerError, match=r"^name: ") as caught:
        await fabric_caller(creds=ERIN, url="nats://127.0.0.1:1", name="n" * 65)
    assert caught.value.reason == "config"


class _Ctx:
    def __init__(self, root: asyncio.Future[str]) -> None:
        self.context = {"agent_fabric_caller_root_sink": root}


async def test_settles_the_root_when_tracings_interceptor_raises() -> None:
    class Failing:
        async def before_prompt(self, _ctx: object) -> PromptExtras | None:
            raise RuntimeError("tracing failed")

    root: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    wrapper = _RootCapturing(cast("PromptInterceptor", Failing()))
    with pytest.raises(RuntimeError, match="tracing failed"):
        await wrapper.before_prompt(cast("PromptInterceptorContext", _Ctx(root)))
    with pytest.raises(RuntimeError, match="tracing failed"):
        await root


async def test_resolves_the_root_tracing_minted() -> None:
    class Minting:
        async def before_prompt(self, _ctx: object) -> PromptExtras | None:
            return PromptExtras(fields={"root_id": "r" * 32})

    root: asyncio.Future[str] = asyncio.get_running_loop().create_future()
    await _RootCapturing(cast("PromptInterceptor", Minting())).before_prompt(
        cast("PromptInterceptorContext", _Ctx(root))
    )
    assert await root == "r" * 32


async def test_refuses_a_bad_edge_subject_before_connecting() -> None:
    with pytest.raises(ValueError, match="edge_subject"):
        await fabric_caller(creds=ERIN, url="nats://127.0.0.1:1", edge_subject="a..b")
