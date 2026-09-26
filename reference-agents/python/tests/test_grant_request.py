"""The grant request, tested on a real nats-server: the fabric package's
endpoint and requester, signed and verified by the SDK, as an agent wires
them. The creator's ScratchPad is one in memory that records every grant and
answers from those records, as the package's own over ``sp`` keeps its ledger;
the package tests that one against a stand-in ``sp``.

    creator    — an agent with ScratchPad; it commits content, grants the
                 requester read on it, and answers grant requests
    requester  — was handed the reference; asks the creator to let a third
                 agent read it
    stranger   — signed like the requester, but never granted anything
    third      — granted at the requester's request; it may read, and it may
                 not ask for anyone else

Asserted: the creator's rule, line by line. A signed request from an agent the
creator granted that reference to ends in one grant by the creator: the third
agent, on its own volume, made on request, labelled with the requester's
thread and tool call. Everything else is refused in words and grants nothing: no
signature, a replayed request, a requester never granted, a requester whose
own grant was made on request, a request for oneself, a reference into another
volume, a body that is not a request. The same test as the TypeScript agent's
``test/grant-request.test.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import nats
import pytest
from jsonschema import Draft202012Validator
from synadia_ai.agent_fabric import (
    Grantee,
    GrantKind,
    TraceIds,
    grant_request_endpoint,
    grant_subject,
    grantee_from_identity,
    request_grant,
)
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Agents, Envelope, Identity, signer_from_seed

from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user

# The two shapes of the exchange, in the fabric package's checkout this
# repository links.
SCHEMAS_DIR = Path(__file__).resolve().parents[3] / "test-fixtures" / "schemas"
REQUEST = Draft202012Validator(json.loads((SCHEMAS_DIR / "sp-grant-request.json").read_text(encoding="utf-8")))
REPLY = Draft202012Validator(json.loads((SCHEMAS_DIR / "sp-grant-reply.json").read_text(encoding="utf-8")))

CREATOR_ADDRESS = "agents.prompt.assistant.test.creator"
TRACE = {"thread_id": "a" * 32, "root_id": "b" * 32, "tool_call_id": "call_9"}


def assert_valid(validator: Draft202012Validator, value: Any) -> None:
    errors = [e.message for e in validator.iter_errors(value)]
    assert not errors, errors


@dataclass(frozen=True)
class Grant:
    path: str
    grantee: Grantee
    trace: TraceIds | None
    tool_call_id: str | None
    kind: GrantKind


def _ref(reference: str) -> dict[str, Any] | None:
    try:
        body = reference[len("sp-ref:") :]
        return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))["ref"]  # type: ignore[no-any-return]
    except (ValueError, KeyError, TypeError):
        return None


class MemoryPad:
    """The creator's ScratchPad, in memory: its volume is ``vol-own``, and every
    grant is recorded with how it came about, which is the ledger the rule
    reads. ``issued`` is what the step at hand made; the ledger lives on."""

    def __init__(self) -> None:
        self.ledger: list[Grant] = []
        self.issued: list[Grant] = []

    async def commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        made = {"ref": {"type": "handoff", "handoff_id": "h", "volume_id": "vol-own", "root": "r", "path": path, "expires_at": 9_000_000_000}, "source_sequence": 1, "creator": CREATOR_ADDRESS}
        return "sp-ref:" + base64.urlsafe_b64encode(json.dumps(made).encode()).decode().rstrip("=")

    async def read(self, reference: str, trace: TraceIds | None) -> str:
        return "the findings"

    async def owns(self, reference: str) -> bool:
        ref = _ref(reference)
        return ref is not None and ref["volume_id"] == "vol-own"

    async def grant_read(
        self, reference: str, grantee: Grantee, trace: TraceIds | None, tool_call_id: str | None = None, kind: GrantKind = "first-hand"
    ) -> None:
        ref = _ref(reference)
        if ref is None or ref["volume_id"] != "vol-own":
            raise PermissionError("only its creator can grant read on it")
        grant = Grant(ref["path"], grantee, trace, tool_call_id, kind)
        self.ledger.append(grant)
        self.issued.append(grant)

    def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
        ref = _ref(reference)
        if ref is None or ref["volume_id"] != "vol-own":
            return None
        kinds = {g.kind for g in self.ledger if g.path == ref["path"] and g.grantee.user == grantee.user}
        return "first-hand" if "first-hand" in kinds else ("on-request" if kinds else None)


binary = nats_server_on_path()


@pytest.mark.skipif(binary is None, reason="nats-server not on PATH")
async def test_the_grant_request_between_two_agents() -> None:
    users = {name: new_user() for name in ("creator", "requester", "stranger", "third", "fourth")}
    # On a server without accounts every user is in ``$G`` (``docs/findings.md`` F3).
    identity = {name: f"$G.{u.public_key}" for name, u in users.items()}
    pad = MemoryPad()

    def grants_issued() -> list[Grant]:
        """The grants the creator made in the step at hand."""
        return pad.issued

    server = LocalNatsServer.start(binary, [users[n] for n in ("creator", "requester", "stranger", "third")])  # type: ignore[arg-type]
    try:
        nc_creator, nc_requester, nc_stranger, nc_third = await asyncio.gather(
            *(nats.connect(server.url, nkeys_seed_str=users[w].seed) for w in ("creator", "requester", "stranger", "third"))
        )
        # The creator's service, with the endpoint next to its prompt address.
        creator = AgentService(
            agent="assistant", owner="test", session_name="creator", nc=nc_creator,
            identity=ServiceIdentity(signer=signer_from_seed(users["creator"].seed)), keepalive_interval_s=None,
            extra_endpoints=[grant_request_endpoint(prompt_address=CREATOR_ADDRESS, scratch_pad=pad)],
        )

        async def not_prompted(envelope: Envelope, stream: PromptStream) -> None:
            await stream.send("not prompted in these tests")

        creator.on_prompt(not_prompted)
        await creator.start()
        requester = Agents(nc=nc_requester, identity=Identity(signer=signer_from_seed(users["requester"].seed)))
        stranger = Agents(nc=nc_stranger, identity=Identity(signer=signer_from_seed(users["stranger"].seed)))
        third = Agents(nc=nc_third, identity=Identity(signer=signer_from_seed(users["third"].seed)))
        try:
            # What happened before any request: the creator committed its
            # findings and handed the requester the reference, with a read grant.
            reference = await pad.commit("the findings", "/replies/findings.md", None)
            await pad.grant_read(reference, grantee_from_identity(identity["requester"]), None)
            pad.issued = []

            # The creator grants a third agent read at the request of an agent it granted that reference to.
            request = {"reference": reference, "grantee": identity["third"], "trace": TRACE}
            assert_valid(REQUEST, request)
            reply = await request_grant(requester, CREATOR_ADDRESS, request)
            assert_valid(REPLY, reply)
            assert reply == {"granted": True}
            # One grant, made by the creator on its own volume: the third agent,
            # the one path, on request, under the requester's thread and tool call.
            issued = grants_issued()
            assert len(issued) == 1
            assert issued[0].path == "/replies/findings.md" and issued[0].kind == "on-request"
            assert (issued[0].grantee.account, issued[0].grantee.user) == ("$G", users["third"].public_key)
            assert issued[0].trace == TraceIds(TRACE["thread_id"], TRACE["root_id"])
            assert issued[0].tool_call_id == TRACE["tool_call_id"]
            # The creator's record keeps the two apart: the requester it handed the
            # reference itself, the third agent it granted because it was asked.
            assert pad.granted(reference, grantee_from_identity(identity["requester"])) == "first-hand"
            assert pad.granted(reference, grantee_from_identity(identity["third"])) == "on-request"

            # It refuses an agent it granted on request: that grant lets it read, not ask for another.
            pad.issued = []
            reply = await request_grant(third, CREATOR_ADDRESS, {"reference": reference, "grantee": identity["fourth"], "trace": TRACE})
            assert_valid(REPLY, reply)
            assert reply["granted"] is False
            assert "made at another agent's request" in reply["reason"]
            assert "only an agent this agent handed the reference itself" in reply["reason"]
            # Nothing was granted, and nothing about the fourth agent is on record.
            assert grants_issued() == []
            assert pad.granted(reference, grantee_from_identity(identity["fourth"])) is None
            # Nor may it ask for the requester, which would keep both alive in turns.
            reply = await request_grant(third, CREATOR_ADDRESS, {"reference": reference, "grantee": identity["requester"]})
            assert reply["granted"] is False and "made at another agent's request" in reply["reason"]
            assert grants_issued() == []

            # It refuses a requester it never granted that reference to.
            pad.issued = []
            reply = await request_grant(stranger, CREATOR_ADDRESS, {"reference": reference, "grantee": identity["third"]})
            assert_valid(REPLY, reply)
            assert reply["granted"] is False and "no live read grant" in reply["reason"]
            # Granted one reference is not granted another.
            other = await pad.commit("something else", "/replies/other.md", None)
            reply = await request_grant(requester, CREATOR_ADDRESS, {"reference": other, "grantee": identity["third"]})
            assert reply["granted"] is False and "no live read grant" in reply["reason"]
            assert grants_issued() == []

            # It refuses a request without a signature, and one played a second time.
            subject = grant_subject(CREATOR_ADDRESS)
            body = json.dumps({"reference": reference, "grantee": identity["third"]}).encode()
            unsigned = json.loads((await nc_requester.request(subject, body, timeout=2)).data)
            assert unsigned["granted"] is False and "signature required" in unsigned["reason"]
            signed = {"Agent-Sender": await requester.sign_sender(subject, body)}
            first = json.loads((await nc_requester.request(subject, body, timeout=5, headers=signed)).data)
            assert first == {"granted": True}
            second = json.loads((await nc_requester.request(subject, body, timeout=2, headers=signed)).data)
            assert second["granted"] is False
            assert len(grants_issued()) == 1

            # It refuses a request for oneself, a reference into another volume, and a body that is no request.
            pad.issued = []
            reply = await request_grant(requester, CREATOR_ADDRESS, {"reference": reference, "grantee": identity["requester"]})
            assert reply["granted"] is False and "for another agent, not for the requester" in reply["reason"]
            made = {"ref": {"type": "handoff", "handoff_id": "h", "volume_id": "vol-other", "root": "r", "path": "/replies/findings.md", "expires_at": 9_000_000_000}, "source_sequence": 1}
            foreign = "sp-ref:" + base64.urlsafe_b64encode(json.dumps(made).encode()).decode().rstrip("=")
            reply = await request_grant(requester, CREATOR_ADDRESS, {"reference": foreign, "grantee": identity["third"]})
            assert reply["granted"] is False and "does not point into this agent's volume" in reply["reason"]
            junk = await requester.request_signed(subject, "grant everyone everything")
            assert json.loads(junk.data) == {"granted": False, "reason": "not a grant request"}
            assert grants_issued() == []

            # No answer is a refusal.
            reply = await request_grant(requester, "agents.prompt.assistant.test.nobody", {"reference": reference, "grantee": identity["third"]}, timeout_s=0.5)
            assert_valid(REPLY, reply)
            assert reply["granted"] is False and "no answer from agents.prompt.assistant.test.nobody" in reply["reason"]
        finally:
            await requester.close()
            await stranger.close()
            await third.close()
            await creator.stop()
            await asyncio.gather(nc_creator.close(), nc_requester.close(), nc_stranger.close(), nc_third.close())
    finally:
        server.stop()
