"""The ScratchPad extension over a real nats-server, in operator mode with real identities.

A caller (bob, in APP) runs ``AgentTools`` with the extension and
``fabric_tracing()``, and serves prompts whose handler plays the model: each
prompt names one tool call, base64url-encoded on its first line so it hands
the caller no reference, and the handler executes it and answers with the
result. It prompts a target that reads references (carol, ACME), one that
reads none (carol again, another name), and a creator (alice, ACME) that
hands out references of its own and answers grant requests on its endpoint.
Every agent's ScratchPad is an in-memory fake that records its grants.
``typescript/test/integration/scratchpad-extension.test.ts`` is the twin.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import nats
import pytest_asyncio
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import (
    Agent,
    AgentId,
    Agents,
    AgentSubject,
    AgentTools,
    DiscoverFilter,
    Envelope,
    Identity,
    ResponseChunk,
    signer_from_creds_file,
)

from synadia_ai.agent_fabric import (
    TraceIds,
    active_trace,
    encode_grant_reply,
    fabric_tracing,
    grant_request_endpoint,
    scratch_pad_extension,
)
from tests.harness.nats_server import identity_fixture
from tests.scratchpad_fake import MemoryScratchPad, RecordedGrant, make_reference
from tests.support import (
    capture,
    edge_schema_errors,
    grant_reply_schema_errors,
    grant_request_schema_errors,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer

_KEYS = json.loads(identity_fixture("operator/keys.json").read_text(encoding="utf-8"))


def _id(user: str) -> str:
    u = _KEYS["users"][user]
    return str(AgentId.new(_KEYS["accounts"][u["account"]]["public"], u["public"]))


BOB, CAROL = _id("bob"), _id("carol")
CALLER = AgentSubject.new("caller", "fabric", "c1").prompt
TARGET = AgentSubject.new("target", "fabric", "t1").prompt
PLAIN = AgentSubject.new("plain", "fabric", "p1").prompt
CREATOR = AgentSubject.new("creator", "fabric", "r1").prompt
GRANTS = "agents.sp-grant.creator.fabric.r1"
_REF = re.compile(r"sp-ref:[A-Za-z0-9_-]+")


@dataclass
class Fabric:
    """The three agents, their fakes, and what was seen on the wire."""

    caller_pad: MemoryScratchPad
    creator_pad: MemoryScratchPad
    remember: Any
    caller_handle: Agent
    bob_nc: NATSClient
    bob_agents: Agents
    seen_by_target: list[str] = field(default_factory=list)
    seen_by_plain: list[str] = field(default_factory=list)
    edges: list[Msg] = field(default_factory=list)
    grant_requests: list[Msg] = field(default_factory=list)

    async def play(
        self, tool: str, args: Any, tool_call_id: str, handed: str = ""
    ) -> tuple[dict[str, Any], TraceIds]:
        """One tool call, played by the caller inside a prompt it serves."""
        script = json.dumps({"tool": tool, "args": args, "tool_call_id": tool_call_id})
        line = base64.urlsafe_b64encode(script.encode()).decode().rstrip("=")
        text = ""
        async for m in self.caller_handle.prompt(f"{line}\n{handed}", timeout=30.0):
            if isinstance(m, ResponseChunk):
                text += m.text
        played = json.loads(text)
        served = played["served"]
        return played["result"], TraceIds(served["thread_id"], served["root_id"])


def _reader(nc: NATSClient, name: str, seen: list[str], *, reads: bool, tracing: Any) -> Any:
    agent, session = name.split(".")
    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="fabric",
        session_name=session,
        identity=ServiceIdentity(
            signer=signer_from_creds_file(identity_fixture("operator/carol.creds"))
        ),
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=[tracing.request_interceptor],
        extra_metadata={"scratchpad_refs_ok": "true"} if reads else None,
    )

    async def handle(envelope: Envelope, stream: PromptStream) -> None:
        seen.append(envelope.prompt)
        await stream.send("read")

    svc.on_prompt(handle)
    return svc


@pytest_asyncio.fixture
async def fabric(nats_server_operator: RunningServer) -> AsyncIterator[Fabric]:  # noqa: PLR0915
    url = nats_server_operator.url

    async def connect(user: str) -> NATSClient:
        creds = identity_fixture(f"operator/{user}.creds")
        return await nats.connect(url, user_credentials=str(creds), allow_reconnect=False)

    nc_bob, nc_alice, nc_carol = (
        await connect("bob"),
        await connect("alice"),
        await connect("carol"),
    )
    tracing = fabric_tracing()
    caller_pad = MemoryScratchPad("vol-bob", CALLER)
    creator_pad = MemoryScratchPad("vol-alice", CREATOR)
    seen_by_target: list[str] = []
    seen_by_plain: list[str] = []
    services = [
        _reader(nc_carol, "target.t1", seen_by_target, reads=True, tracing=tracing),
        _reader(nc_carol, "plain.p1", seen_by_plain, reads=False, tracing=tracing),
    ]

    # The creator: hands a reference of its own to its verified caller, and
    # answers grant requests about it.
    alice_signer = signer_from_creds_file(identity_fixture("operator/alice.creds"))
    alice_agents = Agents(nc=nc_alice, identity=Identity(signer=alice_signer))
    creator_ext = scratch_pad_extension(scratch_pad=creator_pad, agents=alice_agents)
    creator = AgentService(
        nc=nc_alice,
        agent="creator",
        owner="fabric",
        session_name="r1",
        identity=ServiceIdentity(signer=alice_signer),
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=[tracing.request_interceptor, creator_ext.request_interceptor],
        extra_metadata={"scratchpad_refs_ok": "true"},
    )

    async def at_creator(_envelope: Envelope, stream: PromptStream) -> None:
        ref = creator_pad.commit()
        reply = "the findings"
        if await creator_ext.grant_caller(ref, stream.sender):
            reply += f"\n\n{ref}"
        await stream.send(reply)

    creator.on_prompt(at_creator)
    services.append(creator)
    endpoint = await grant_request_endpoint(
        prompt_address=CREATOR, scratch_pad=creator_pad
    ).subscribe(nc_alice)

    # The caller: the agent tools with the extension, on a traced, signed client.
    bob_signer = signer_from_creds_file(identity_fixture("operator/bob.creds"))
    client = Agents(
        nc=nc_bob, identity=Identity(signer=bob_signer), interceptors=[tracing.prompt_interceptor]
    )
    ext = scratch_pad_extension(scratch_pad=caller_pad, agents=client)
    tools = AgentTools(client, self_address=CALLER, extensions=[ext])
    caller = AgentService(
        nc=nc_bob,
        agent="caller",
        owner="fabric",
        session_name="c1",
        identity=ServiceIdentity(signer=bob_signer),
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=[
            tracing.request_interceptor,
            tools.request_interceptor,
            ext.request_interceptor,
        ],
    )

    async def at_caller(envelope: Envelope, stream: PromptStream) -> None:
        line = envelope.prompt.split("\n")[0]
        script = json.loads(base64.urlsafe_b64decode(line + "=" * (-len(line) % 4)))
        result = await tools.execute(
            script["tool"], script["args"], tool_call_id=script["tool_call_id"]
        )
        scope = active_trace()
        assert scope is not None
        served = {"thread_id": scope.thread_id, "root_id": scope.root_id}
        await stream.send(json.dumps({"result": result, "served": served}))

    caller.on_prompt(at_caller)
    services.append(caller)
    for svc in services:
        await svc.start()

    edges = await capture(nc_bob, "TRACE.edges")
    grant_requests = await capture(nc_alice, GRANTS)
    driver = Agents(nc=nc_bob)
    [caller_handle] = await driver.discover(filter=DiscoverFilter(agent="caller"))
    f = Fabric(
        caller_pad=caller_pad,
        creator_pad=creator_pad,
        remember=ext.remember,
        caller_handle=caller_handle,
        bob_nc=nc_bob,
        bob_agents=client,
        seen_by_target=seen_by_target,
        seen_by_plain=seen_by_plain,
        edges=edges,
        grant_requests=grant_requests,
    )
    try:
        yield f
    finally:
        await tools.aclose()
        await endpoint.unsubscribe()
        for a in (driver, client, alice_agents):
            await a.close()
        for svc in services:
            await svc.stop()
        for nc in (nc_bob, nc_alice, nc_carol):
            await nc.close()


async def test_discovery_shows_which_agents_read_references(fabric: Fabric) -> None:
    result, _ = await fabric.play("discover_agents", {}, "toolu_discover")
    reads = {a["address"]: a["reads_scratchpad_references"] for a in result["agents"]}
    assert reads == {TARGET: True, PLAIN: False, CREATOR: True}
    assert next(a for a in result["agents"] if a["address"] == TARGET)["identity"] == CAROL


async def test_own_content_is_granted_first_hand_and_sent_and_the_edge_names_the_call(
    fabric: Fabric,
) -> None:
    own = fabric.caller_pad.commit("/own.md")
    fabric.remember(own)
    result, served = await fabric.play(
        "prompt_agent", {"address": TARGET, "prompt": f"read {own}"}, "toolu_own"
    )
    assert result["state"] == "completed" and result["reply"] == "read"
    assert "references_removed" not in result
    assert fabric.seen_by_target[-1] == f"read {own}"
    assert fabric.caller_pad.grants == [
        RecordedGrant(own, CAROL, served, "toolu_own", "first-hand")
    ]
    # The call is filed under the served prompt; the record still validates.
    await asyncio.sleep(0.1)
    [record] = [json.loads(m.data) for m in fabric.edges]
    assert record["tool_call_id"] == "toolu_own"
    assert record["agent"] == BOB
    assert (record["parent_id"], record["root_id"]) == (served.thread_id, served.root_id)
    assert edge_schema_errors(record) == []


async def test_a_reference_in_a_reply_is_remembered_and_passed_on_with_the_creators_grant(
    fabric: Fabric,
) -> None:
    result, _ = await fabric.play(
        "prompt_agent", {"address": CREATOR, "prompt": "your findings, please"}, "toolu_ask"
    )
    assert result["state"] == "completed"
    match = _REF.search(result["reply"])
    assert match is not None
    from_creator = match.group(0)
    assert [(g.reference, g.grantee, g.kind) for g in fabric.creator_pad.grants] == [
        (from_creator, BOB, "first-hand")
    ]

    result, served = await fabric.play(
        "prompt_agent", {"address": TARGET, "prompt": f"work from {from_creator}"}, "toolu_theirs"
    )
    assert result["state"] == "completed" and result["reply"] == "read"
    assert fabric.seen_by_target[-1] == f"work from {from_creator}"
    assert fabric.creator_pad.grants[-1] == RecordedGrant(
        from_creator, CAROL, served, "toolu_theirs", "on-request"
    )
    # The request as it went over the wire: signed, in the schema's shape.
    request = fabric.grant_requests[-1]
    assert (request.headers or {}).get("Agent-Sender")
    assert (
        request.data
        == json.dumps(
            {
                "reference": from_creator,
                "grantee": CAROL,
                "trace": {
                    "thread_id": served.thread_id,
                    "root_id": served.root_id,
                    "tool_call_id": "toolu_theirs",
                },
            },
            separators=(",", ":"),
        ).encode()
    )
    assert grant_request_schema_errors(json.loads(request.data)) == []


async def test_a_reference_its_creator_refuses_is_taken_out_with_a_note(fabric: Fabric) -> None:
    # Handed to the caller in a prompt it served, never granted to it.
    unshared = fabric.creator_pad.commit("/private.md")
    result, _ = await fabric.play(
        "prompt_agent",
        {"address": TARGET, "prompt": f"summarise {unshared} and say hi"},
        "toolu_refused",
        handed=f"here is what you need: {unshared}",
    )
    assert result["state"] == "completed" and result["references_removed"] == 1
    assert (
        "(this agent holds no live read grant it made to the requester on that reference)"
        in result["note"]
    )
    assert fabric.seen_by_target[-1] == "summarise  and say hi"


async def test_a_target_that_reads_none_gets_the_text_without_them(fabric: Fabric) -> None:
    own = fabric.caller_pad.commit("/for-plain.md")
    fabric.remember(own)
    result, _ = await fabric.play(
        "prompt_agent", {"address": PLAIN, "prompt": f"{own}\nhello"}, "toolu_plain"
    )
    assert result["state"] == "completed" and result["references_removed"] == 1
    assert "does not read ScratchPad references" in result["note"]
    assert fabric.seen_by_plain == ["hello"]
    assert fabric.caller_pad.grants == []


async def test_a_token_it_was_not_given_is_refused_and_nothing_is_sent(fabric: Fabric) -> None:
    made_up = make_reference("vol-bob", "/made-up.md", CALLER)
    result, _ = await fabric.play(
        "prompt_agent", {"address": TARGET, "prompt": f"read {made_up}"}, "toolu_madeup"
    )
    assert list(result) == ["error"]
    assert "is not one you were given" in result["error"]
    await asyncio.sleep(0.1)
    assert fabric.seen_by_target == []


async def test_unsigned_and_replayed_grant_requests_are_refused(fabric: Fabric) -> None:
    # A signed request of the caller's own, for a reference never handed to it …
    ref = fabric.creator_pad.commit("/other.md")
    body = json.dumps({"reference": ref, "grantee": CAROL}).encode()
    first = await fabric.bob_agents.request_signed(GRANTS, body, timeout_s=5.0)
    assert first.data == encode_grant_reply(
        {
            "granted": False,
            "reason": "this agent holds no live read grant it made to the requester on that "
            "reference",
        }
    )
    # … then the same bytes and headers again, and the bytes alone.
    await asyncio.sleep(0.1)
    signed = fabric.grant_requests[-1]
    replayed = await fabric.bob_nc.request(GRANTS, signed.data, timeout=5.0, headers=signed.headers)
    assert json.loads(replayed.data) == {"granted": False, "reason": "sender rejected"}
    unsigned = await fabric.bob_nc.request(GRANTS, signed.data, timeout=5.0)
    assert unsigned.data == encode_grant_reply({"granted": False, "reason": "signature required"})
    for reply in (first, replayed, unsigned):
        assert grant_reply_schema_errors(json.loads(reply.data)) == []
