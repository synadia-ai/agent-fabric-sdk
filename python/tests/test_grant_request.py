"""The grant request without a server.

The creator's rule, one test per condition, and the requester's reading of
an answer. ``typescript/test/unit/grant-request.test.ts`` is the twin; the
signature and replay checks, which need a signed message, are in the
integration tests.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    Grantee,
    GrantKind,
    TraceIds,
    answer_grant_request,
    encode_grant_request,
    request_grant,
)
from tests.scratchpad_fake import MemoryScratchPad, RecordedGrant, StubAgents, make_reference

SELF = "agents.prompt.creator.fabric.r1"
REQUESTER = "APP.bob"
GRANTEE = "ACME.carol"
THREAD, ROOT = "a" * 32, "b" * 32
BOB = Grantee("APP", "bob")


def _creator() -> tuple[MemoryScratchPad, str]:
    pad = MemoryScratchPad("vol-creator", SELF)
    ref = pad.commit("/findings.md")
    # Handed to the requester first-hand: the verified caller of a reply.
    pad.grant_read(ref, BOB, None)
    pad.grants.clear()
    return pad, ref


def _ask(ref: str, **extra: Any) -> str:
    return json.dumps({"reference": ref, "grantee": GRANTEE, **extra})


async def test_it_grants_on_request_with_the_requesters_labels() -> None:
    pad, ref = _creator()
    payload = encode_grant_request(
        {
            "reference": ref,
            "grantee": GRANTEE,
            "trace": {"thread_id": THREAD, "root_id": ROOT, "tool_call_id": "toolu_9"},
        }
    )
    assert await answer_grant_request(REQUESTER, payload, pad) == {"granted": True}
    assert pad.grants == [
        RecordedGrant(ref, GRANTEE, TraceIds(THREAD, ROOT), "toolu_9", "on-request")
    ]
    assert pad.granted(ref, Grantee("ACME", "carol")) == "on-request"


async def test_it_grants_without_labels_a_request_that_has_none_or_malformed_ones() -> None:
    pad, ref = _creator()
    await answer_grant_request(REQUESTER, _ask(ref), pad)
    await answer_grant_request(
        REQUESTER,
        _ask(ref, trace={"thread_id": "not-hex", "root_id": ROOT, "tool_call_id": "t"}),
        pad,
    )
    await answer_grant_request(
        REQUESTER, _ask(ref, trace={"thread_id": THREAD, "root_id": ROOT, "tool_call_id": ""}), pad
    )
    assert [(g.trace, g.tool_call_id) for g in pad.grants] == [
        (None, None),
        (None, None),
        (TraceIds(THREAD, ROOT), None),
    ]


@pytest.mark.parametrize(
    "payload",
    [
        "{",
        "[1]",
        json.dumps({"grantee": GRANTEE}),
        json.dumps({"reference": "sp-ref:x"}),
        json.dumps({"reference": "sp-ref:x", "grantee": 7}),
    ],
    ids=["not JSON", "not an object", "no reference", "no grantee", "a number for the grantee"],
)
async def test_it_refuses_what_is_not_a_grant_request(payload: str) -> None:
    pad, _ = _creator()
    assert await answer_grant_request(REQUESTER, payload, pad) == {
        "granted": False,
        "reason": "not a grant request",
    }
    assert pad.grants == []


async def test_it_refuses_a_grantee_that_is_not_an_agent_identity() -> None:
    pad, ref = _creator()
    payload = json.dumps({"reference": ref, "grantee": "carol"})
    assert await answer_grant_request(REQUESTER, payload, pad) == {
        "granted": False,
        "reason": "grantee is not an agent identity",
    }


@pytest.mark.parametrize("reference", [make_reference("vol-else", "/x.md", SELF), "sp-ref:garbage"])
async def test_it_refuses_a_reference_into_another_volume_or_one_that_does_not_decode(
    reference: str,
) -> None:
    pad, _ = _creator()
    assert await answer_grant_request(REQUESTER, _ask(reference), pad) == {
        "granted": False,
        "reason": "the reference does not point into this agent's volume",
    }


async def test_a_port_whose_owns_raises_owns_nothing() -> None:
    class Throwing(MemoryScratchPad):
        def owns(self, reference: str) -> bool:
            raise ValueError("decode")

    reply = await answer_grant_request(REQUESTER, _ask("sp-ref:x"), Throwing("vol-creator"))
    assert reply["reason"] == "the reference does not point into this agent's volume"


async def test_it_refuses_a_requester_it_never_granted_read_on_that_reference() -> None:
    pad, _ = _creator()
    assert await answer_grant_request(REQUESTER, _ask(pad.commit("/other.md")), pad) == {
        "granted": False,
        "reason": "this agent holds no live read grant it made to the requester on that reference",
    }
    assert pad.grants == []


async def test_it_refuses_a_requester_whose_grant_has_expired() -> None:
    pad, ref = _creator()
    pad.now += 601
    reply = await answer_grant_request(REQUESTER, _ask(ref), pad)
    assert reply["reason"] == (
        "this agent holds no live read grant it made to the requester on that reference"
    )


async def test_it_refuses_a_requester_whose_own_grant_was_made_on_request() -> None:
    pad = MemoryScratchPad("vol-creator", SELF)
    ref = pad.commit()
    pad.grant_read(ref, BOB, None, None, "on-request")
    assert await answer_grant_request(REQUESTER, _ask(ref), pad) == {
        "granted": False,
        "reason": "the requester's own grant was made at another agent's request; "
        "only an agent this agent handed the reference itself may ask for another",
    }


async def test_a_live_first_hand_grant_stands_when_a_later_one_was_made_on_request() -> None:
    pad, ref = _creator()
    pad.grant_read(ref, BOB, None, None, "on-request")
    assert await answer_grant_request(REQUESTER, _ask(ref), pad) == {"granted": True}


async def test_it_refuses_a_request_for_the_requester_itself() -> None:
    pad, ref = _creator()
    payload = json.dumps({"reference": ref, "grantee": REQUESTER})
    assert await answer_grant_request(REQUESTER, payload, pad) == {
        "granted": False,
        "reason": "a grant request is for another agent, not for the requester",
    }
    assert pad.grants == []


async def test_a_failing_grant_or_ledger_is_a_refusal() -> None:
    pad, ref = _creator()
    pad.fail_grants = "permission_denied"
    assert await answer_grant_request(REQUESTER, _ask(ref), pad) == {
        "granted": False,
        "reason": "the grant could not be made",
    }

    class Ledgerless(MemoryScratchPad):
        def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
            raise RuntimeError("ledger")

    reply = await answer_grant_request(REQUESTER, _ask(ref), Ledgerless("vol-creator", SELF))
    assert reply["reason"] == "the grant could not be made"


async def test_it_takes_a_port_whose_methods_are_coroutines() -> None:
    pad, ref = _creator()

    class Async:
        async def owns(self, reference: str) -> bool:
            return pad.owns(reference)

        async def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
            return pad.granted(reference, grantee)

        async def grant_read(
            self,
            reference: str,
            grantee: Grantee,
            trace: TraceIds | None,
            tool_call_id: str | None = None,
            kind: GrantKind = "first-hand",
        ) -> None:
            pad.grant_read(reference, grantee, trace, tool_call_id, kind)

    assert await answer_grant_request(REQUESTER, _ask(ref), Async()) == {"granted": True}


# --- the requester -----------------------------------------------------------

REQUEST = {"reference": "sp-ref:x", "grantee": GRANTEE}


async def test_the_request_goes_signed_to_the_creators_grant_subject() -> None:
    stub = StubAgents()
    assert await request_grant(stub.as_agents(), SELF, REQUEST) == {"granted": True}
    assert stub.requests == [("agents.sp-grant.creator.fabric.r1", encode_grant_request(REQUEST))]


async def test_a_refusals_reason_is_passed_on() -> None:
    stub = StubAgents(answer='{"granted":false,"reason":"not yours"}')
    assert await request_grant(stub.as_agents(), SELF, REQUEST) == {
        "granted": False,
        "reason": "not yours",
    }


@pytest.mark.parametrize("answer", ['{"granted":false}', '{"granted":"yes"}', "[true]", "null"])
async def test_an_answer_that_is_not_a_grant_is_a_refusal(answer: str) -> None:
    stub = StubAgents(answer=answer)
    assert await request_grant(stub.as_agents(), SELF, REQUEST) == {
        "granted": False,
        "reason": "refused without a reason",
    }


async def test_no_answer_or_no_json_is_a_refusal_naming_the_creator() -> None:
    stub = StubAgents(answer=TimeoutError("timeout"))
    assert await request_grant(stub.as_agents(), SELF, REQUEST) == {
        "granted": False,
        "reason": f"no answer from {SELF}: timeout",
    }
    stub.answer = ""
    reply = await request_grant(stub.as_agents(), SELF, REQUEST)
    assert reply["granted"] is False
    assert reply["reason"].startswith(f"no answer from {SELF}: ")


async def test_nothing_goes_to_an_address_that_is_not_a_prompt_address() -> None:
    stub = StubAgents()
    assert await request_grant(stub.as_agents(), "agents.status.x.y.z", REQUEST) == {
        "granted": False,
        "reason": "no answer from agents.status.x.y.z: not a prompt address: agents.status.x.y.z",
    }
    assert stub.requests == []
