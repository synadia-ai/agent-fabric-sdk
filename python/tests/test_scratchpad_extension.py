"""The extension's hooks, without a server.

Every branch of the prompt rewrite, the discovery field, the reply look, and
what the agent is taken to have been given.
``typescript/test/unit/scratchpad-extension.test.ts`` is the twin.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, cast

import pytest
from synadia_ai.agent_service import RequestInterceptorContext
from synadia_ai.agents import (
    AgentId,
    AgentSenderHeader,
    AgentToolsPromptRewrite,
    ClaimedSender,
    Envelope,
    SenderClaim,
    VerifiedSender,
)

from synadia_ai.agent_fabric import (
    ScratchPadExtension,
    TraceIds,
    TraceScope,
    bind_active_trace,
    scratch_pad_extension,
)
from tests.scratchpad_fake import (
    MemoryScratchPad,
    RecordedGrant,
    StubAgent,
    StubAgents,
    as_agent,
    make_reference,
    prompt_context,
    reply_context,
)

SELF = "agents.prompt.caller.fabric.c1"
CREATOR = "agents.prompt.creator.fabric.r1"
TARGET_ID = "ACME.carol"
CREATOR_ID = "ACME.alice"
SERVED = TraceScope("a" * 32, "b" * 32)
SERVED_IDS = TraceIds(SERVED.thread_id, SERVED.root_id)

TARGET = StubAgent("agents.prompt.target.fabric.t1", TARGET_ID)
PLAIN = StubAgent("agents.prompt.plain.fabric.p1", TARGET_ID, reads_references=False)
CREATOR_AGENT = StubAgent(CREATOR, CREATOR_ID)


@dataclass
class Setup:
    ext: ScratchPadExtension
    pad: MemoryScratchPad
    stub: StubAgents
    own: str
    theirs: str


@pytest.fixture
def s() -> Setup:
    pad = MemoryScratchPad("vol-self", SELF)
    stub = StubAgents([TARGET, PLAIN, CREATOR_AGENT])
    ext = scratch_pad_extension(scratch_pad=pad, agents=stub.as_agents())
    own = pad.commit("/own.md")
    theirs = make_reference("vol-creator", "/findings.md", CREATOR)
    ext.remember(own)
    ext.remember(f"here you go: {theirs}")
    return Setup(ext, pad, stub, own, theirs)


def _note(rewrite: AgentToolsPromptRewrite | None) -> str:
    assert rewrite is not None and rewrite.fields is not None
    return cast("str", rewrite.fields["note"])


async def test_a_prompt_without_references_is_left_alone(s: Setup) -> None:
    assert await s.ext.before_prompt(prompt_context(TARGET, "just words")) is None
    assert s.pad.grants == [] and s.stub.requests == []


async def test_a_token_it_was_not_given_is_refused_before_anything_is_granted_or_asked(
    s: Setup,
) -> None:
    made_up = make_reference("vol-self", "/other.md", SELF)
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"{s.own} and {made_up}"))
    assert rewrite == AgentToolsPromptRewrite(
        error=f"the prompt was not sent: 1 of its ScratchPad references ({made_up[:24]}…) "
        "is not one you were given. Copy each reference exactly as you received it, the whole "
        "token, or leave it out."
    )
    assert s.pad.grants == [] and s.stub.requests == []


async def test_a_token_with_one_character_wrong_is_refused(s: Setup) -> None:
    typo = s.own[:-1] + ("B" if s.own.endswith("A") else "A")
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"see {typo}"))
    assert rewrite is not None and "not one you were given" in (rewrite.error or "")


async def test_a_target_that_reads_none_gets_the_text_without_them_and_nothing_is_granted(
    s: Setup,
) -> None:
    rewrite = await s.ext.before_prompt(
        prompt_context(PLAIN, f"Summarise {s.own}\nand {s.theirs} and {s.own}.")
    )
    assert rewrite == AgentToolsPromptRewrite(
        prompt="Summarise\nand  and .",
        fields={
            "references_removed": 3,
            "note": f'"{PLAIN.prompt_subject}" does not read ScratchPad references: 3 reference(s) '
            "were removed from your prompt, it got only the text, and nothing was granted",
        },
    )
    assert s.pad.grants == [] and s.stub.requests == []


async def test_even_a_token_it_was_not_given_is_removed_for_such_a_target(s: Setup) -> None:
    made_up = make_reference("vol-x", "/x.md")
    rewrite = await s.ext.before_prompt(prompt_context(PLAIN, f"hi {made_up}"))
    assert rewrite is not None and rewrite.prompt == "hi"
    assert rewrite.fields is not None and rewrite.fields["references_removed"] == 1


async def test_a_prompt_of_nothing_but_references_for_such_a_target_is_refused(s: Setup) -> None:
    rewrite = await s.ext.before_prompt(prompt_context(PLAIN, f"  {s.own}  "))
    assert rewrite == AgentToolsPromptRewrite(
        error=f'the prompt was not sent: "{PLAIN.prompt_subject}" does not read ScratchPad '
        "references (discover_agents: reads_scratchpad_references is false), and the prompt held "
        "nothing but references; put the content they point at into the prompt itself"
    )


@pytest.mark.parametrize(
    "unverified",
    [
        StubAgent("agents.prompt.u.fabric.u1", TARGET_ID, verified=False),
        StubAgent("agents.prompt.u.fabric.u2"),
    ],
)
async def test_a_target_whose_identity_did_not_verify_is_refused(
    s: Setup, unverified: StubAgent
) -> None:
    rewrite = await s.ext.before_prompt(prompt_context(unverified, s.own))
    assert rewrite == AgentToolsPromptRewrite(
        error=f'cannot hand a ScratchPad reference to "{unverified.prompt_subject}": its identity '
        "is not verified, so no read grant can be issued; put the content in the prompt instead"
    )
    assert s.pad.grants == []


async def test_its_own_content_is_granted_first_hand_under_the_served_prompt_and_the_call(
    s: Setup,
) -> None:
    with bind_active_trace(SERVED):
        rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"read {s.own}"))
    assert rewrite is None
    assert s.pad.grants == [RecordedGrant(s.own, TARGET_ID, SERVED_IDS, "toolu_1", "first-hand")]
    assert s.stub.requests == []


async def test_a_reference_that_appears_twice_is_granted_once(s: Setup) -> None:
    await s.ext.before_prompt(prompt_context(TARGET, f"{s.own} and again {s.own}"))
    assert len(s.pad.grants) == 1


async def test_outside_a_served_prompt_and_without_a_tool_call_the_grant_has_no_labels(
    s: Setup,
) -> None:
    await s.ext.before_prompt(prompt_context(TARGET, s.own, None))
    assert (s.pad.grants[0].trace, s.pad.grants[0].tool_call_id) == (None, None)


async def test_a_tool_call_id_the_edge_record_would_drop_is_dropped(s: Setup) -> None:
    with bind_active_trace(SERVED):
        await s.ext.before_prompt(prompt_context(TARGET, s.own, "x" * 257))
    assert s.pad.grants[0].tool_call_id is None


async def test_a_failing_grant_of_its_own_refuses_the_prompt(s: Setup) -> None:
    s.pad.fail_grants = "permission_denied"
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"read {s.own}"))
    assert rewrite == AgentToolsPromptRewrite(
        error=f'could not grant "{TARGET.prompt_subject}" read on {s.own[:32]}…: '
        "permission_denied; the prompt was not sent"
    )


async def test_another_agents_content_is_asked_of_its_creator_with_the_labels_and_sent(
    s: Setup,
) -> None:
    with bind_active_trace(SERVED):
        rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"use {s.theirs}"))
    assert rewrite is None
    assert s.pad.grants == []
    assert s.stub.requests == [
        (
            "agents.sp-grant.creator.fabric.r1",
            (
                f'{{"reference":"{s.theirs}","grantee":"{TARGET_ID}","trace":'
                f'{{"thread_id":"{SERVED.thread_id}","root_id":"{SERVED.root_id}",'
                '"tool_call_id":"toolu_1"}}'
            ).encode(),
        )
    ]


async def test_outside_a_served_prompt_the_creator_is_asked_without_labels(s: Setup) -> None:
    await s.ext.before_prompt(prompt_context(TARGET, f"use {s.theirs}"))
    assert s.stub.requests[0][1] == f'{{"reference":"{s.theirs}","grantee":"{TARGET_ID}"}}'.encode()


async def test_a_reference_its_creator_refuses_is_taken_out_and_the_rest_sent(s: Setup) -> None:
    s.stub.answer = '{"granted":false,"reason":"not yours to pass on"}'
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"use {s.theirs} and {s.own}"))
    address = TARGET.prompt_subject
    assert rewrite == AgentToolsPromptRewrite(
        prompt=f"use  and {s.own}",
        fields={
            "references_removed": 1,
            "note": f'1 reference(s) were removed from your prompt, and "{address}" got only the '
            f'text: you did not create that content, and its creator did not grant "{address}" '
            "read (not yours to pass on). If it needs the content, put the content itself in a "
            "prompt",
        },
    )


async def test_every_occurrence_of_a_refused_reference_is_counted(s: Setup) -> None:
    s.stub.answer = '{"granted":false,"reason":"no"}'
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"a {s.theirs} b {s.theirs}"))
    assert len(s.stub.requests) == 1
    assert rewrite is not None and rewrite.prompt == "a  b"
    assert rewrite.fields is not None and rewrite.fields["references_removed"] == 2


async def test_a_reference_whose_creator_does_not_answer_is_taken_out(s: Setup) -> None:
    s.stub.answer = TimeoutError()
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"use {s.theirs} please"))
    assert rewrite is not None and rewrite.prompt == "use  please"
    assert f"(no answer from {CREATOR}: TimeoutError)" in _note(rewrite)


@pytest.mark.parametrize(
    "discovered",
    [[TARGET], [TARGET, StubAgent(CREATOR, CREATOR_ID, verified=False)]],
)
async def test_a_reference_whose_creator_is_not_on_the_fabric_verified_is_taken_out_unasked(
    s: Setup, discovered: list[Any]
) -> None:
    s.stub.discovered = discovered
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"use {s.theirs} please"))
    assert f"(its creator, {CREATOR}, is not on the fabric with a verified identity)" in _note(
        rewrite
    )
    assert s.stub.requests == []


async def test_a_reference_that_names_no_creator_is_taken_out_unasked(s: Setup) -> None:
    anonymous = make_reference("vol-else", "/x.md")
    s.ext.remember(anonymous)
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"use {anonymous} please"))
    assert "(the reference does not name its creator)" in _note(rewrite)
    assert s.stub.requests == []


async def test_a_creators_reference_goes_to_the_creator_itself_unasked(s: Setup) -> None:
    assert await s.ext.before_prompt(prompt_context(CREATOR_AGENT, f"revise {s.theirs}")) is None
    assert s.stub.requests == []


async def test_a_prompt_of_nothing_but_refused_references_is_refused(s: Setup) -> None:
    s.stub.answer = '{"granted":false,"reason":"no"}'
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, s.theirs))
    assert rewrite == AgentToolsPromptRewrite(
        error="the prompt was not sent: it held nothing but references, and their creator did "
        f'not grant "{TARGET.prompt_subject}" read (no); put the content they point at into the '
        "prompt itself"
    )


async def test_a_creator_it_has_not_seen_is_found_by_one_discovery_of_its_own(s: Setup) -> None:
    await s.ext.before_prompt(prompt_context(TARGET, s.theirs))
    await s.ext.before_prompt(prompt_context(TARGET, s.theirs))
    assert s.stub.discoveries == 1
    assert len(s.stub.requests) == 2


async def test_the_discovery_field_says_whether_the_agent_reads_references(s: Setup) -> None:
    assert await s.ext.discovery_fields(as_agent(TARGET)) == {"reads_scratchpad_references": True}
    assert await s.ext.discovery_fields(as_agent(PLAIN)) == {"reads_scratchpad_references": False}


async def test_a_creator_it_listed_is_asked_without_another_discovery(s: Setup) -> None:
    await s.ext.discovery_fields(as_agent(CREATOR_AGENT))
    s.stub.discovered = []
    await s.ext.before_prompt(prompt_context(TARGET, s.theirs))
    assert len(s.stub.requests) == 1
    assert s.stub.discoveries == 0


async def test_the_references_in_a_reply_and_in_a_question_are_given(s: Setup) -> None:
    in_reply = make_reference("vol-creator", "/r.md", CREATOR)
    in_question = make_reference("vol-creator", "/q.md", CREATOR)
    looked = await s.ext.after_reply(reply_context(CREATOR_AGENT, "reply", f"done: {in_reply}"))
    assert looked is None
    await s.ext.after_reply(reply_context(CREATOR_AGENT, "question", f"which? {in_question}"))
    assert await s.ext.before_prompt(prompt_context(TARGET, f"{in_reply} {in_question}")) is None
    assert len(s.stub.requests) == 2


async def test_the_references_in_the_prompts_it_serves_are_given(s: Setup) -> None:
    handed = make_reference("vol-creator", "/h.md", CREATOR)
    ran: list[int] = []

    async def call_next() -> None:
        ran.append(1)

    ctx = RequestInterceptorContext(
        envelope=Envelope(prompt=f"work from {handed}"), sender=None, subject=SELF, headers={}
    )
    await s.ext.request_interceptor.around_request(ctx, call_next)
    assert ran == [1]
    assert await s.ext.before_prompt(prompt_context(TARGET, handed)) is None
    assert len(s.stub.requests) == 1


# --- the reply side ---------------------------------------------------------

# bob in APP, from test-fixtures/identity/operator/keys.json: an agent ID wants real keys.
APP = "ADYGVCD4O7RNGXKVYEGEU6LQTJFMAWCBI66CZCGTHQ43A7LMGLQUQTME"
BOB = "UAEMGWKTUFE5UCSRZR663WR5X7Y7W7MTLFXRDRHIG7PZXGR3KKEYWIBT"
_HEADER = AgentSenderHeader(v=1, user=BOB, account=APP)
VERIFIED = VerifiedSender(id=AgentId.new(APP, BOB), header=_HEADER)
CLAIMED = ClaimedSender(claim=SenderClaim(user=BOB, account=APP), header=_HEADER)


def _alone() -> tuple[ScratchPadExtension, MemoryScratchPad]:
    pad = MemoryScratchPad("vol-self", SELF)
    return scratch_pad_extension(scratch_pad=pad, agents=StubAgents().as_agents()), pad


async def test_a_verified_caller_is_granted_its_reference_first_hand_and_it_is_remembered() -> None:
    ext, pad = _alone()
    ref = pad.commit("/reply.md")
    with bind_active_trace(SERVED):
        assert await ext.grant_caller(ref, VERIFIED) is True
    assert pad.grants == [RecordedGrant(ref, f"{APP}.{BOB}", SERVED_IDS, None, "first-hand")]
    assert await ext.before_prompt(prompt_context(TARGET, ref)) is None


async def test_a_caller_that_did_not_verify_gets_nothing_but_the_reference_is_remembered() -> None:
    ext, pad = _alone()
    ref = pad.commit("/reply.md")
    assert await ext.grant_caller(ref, CLAIMED) is False
    assert await ext.grant_caller(ref, None) is False
    assert pad.grants == []
    assert await ext.before_prompt(prompt_context(TARGET, ref)) is None
    assert len(pad.grants) == 1


async def test_a_reference_that_is_not_its_own_is_refused_on_the_reply_side() -> None:
    ext, pad = _alone()
    with pytest.raises(PermissionError, match="another agent's volume"):
        await ext.grant_caller(make_reference("vol-else", "/x.md", CREATOR), VERIFIED)
    assert pad.grants == []


async def test_a_failing_grant_on_the_reply_side_goes_to_the_agent() -> None:
    ext, pad = _alone()
    pad.fail_grants = "permission_denied"
    with pytest.raises(RuntimeError, match="permission_denied"):
        await ext.grant_caller(pad.commit(), VERIFIED)


async def test_short_creator_routes_through_port_with_original_token(s: Setup) -> None:
    short = "sp-r1:" + "A" * 60
    resolved: list[str] = []

    class ResolvingPad(MemoryScratchPad):
        async def resolve_reference(
            self, reference: str, trace: TraceIds | None = None
        ) -> dict[str, Any]:
            resolved.append(reference)
            return {"creator": CREATOR}

    pad = ResolvingPad("vol-self", SELF)
    ext = scratch_pad_extension(scratch_pad=pad, agents=s.stub.as_agents())
    ext.remember(short)
    assert await ext.before_prompt(prompt_context(TARGET, short)) is None
    assert resolved == [short]
    assert len(s.stub.requests) == 1
    assert json.loads(s.stub.requests[0][1])["reference"] == short
    refused = await ext.before_prompt(prompt_context(TARGET, short[:-1] + "B"))
    assert refused is not None and "not one you were given" in (refused.error or "")
    assert resolved == [short]


async def test_short_reference_on_old_port_is_removed_without_grants(s: Setup) -> None:
    short = "sp-r1:" + "A" * 60
    s.ext.remember(short)
    rewrite = await s.ext.before_prompt(prompt_context(TARGET, f"read {short}"))
    assert rewrite is not None and rewrite.prompt == "read"
    assert rewrite.fields is not None and rewrite.fields["references_removed"] == 1
    assert s.stub.requests == []
