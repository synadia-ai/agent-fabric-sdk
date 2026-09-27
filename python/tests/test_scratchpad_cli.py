"""The ScratchPad wrapper against a stand-in for the sp v2 command line
(``harness/fake_sp.py``): what the wrapper asks the CLI to do, in which order,
with which flags and input, and what it keeps in its own ledger. The stand-in
proves nothing about ScratchPad itself; the real CLI and service are tested in
their own repository and on a running fabric. The same test as the TypeScript
package's ``test/unit/scratchpad-cli.test.ts``.

The grant is the point: on a reference into the agent's own volume, one
``grant`` to one principal, on the root and path the reference names, with a
lifetime no longer than the reference's, and a line in the ledger of whom this
agent granted what; on a reference into someone else's volume, nothing: no
read, no copy, no grant. Only the creator grants (``test_grant_request.py``).
The wrapper is the ``ScratchPad`` port with a commit and a read,
:class:`SpCliScratchPad`; the vocabulary of references is tested in
``test_scratchpad_vocabulary.py``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from pathlib import Path
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    Grantee,
    ScratchPadError,
    SpCliScratchPad,
    TraceIds,
    reference_creator,
)
from synadia_ai.agent_fabric.scratchpad_cli import (
    _Connection,
    decode_describe,
    decode_reference,
)

FAKE_SP = Path(__file__).resolve().parent / "harness" / "fake_sp.py"
TRACE = TraceIds("1" * 32, "2" * 32)
CREATOR = "agents.prompt.assistant.test.main"
# The fake CLI's own account and volume incarnation. A grant goes only to a
# principal in the reference's account, as the CLI enforces.
OWN_ACCOUNT = "A" + "O" * 55
CREATION_ID = "0123456789abcdef0123456789abcdef"
GRANTEE = Grantee(account=OWN_ACCOUNT, user="U" + "C" * 55)
NATS = _Connection(url="nats://127.0.0.1:4222", creds="/nowhere/agent.creds")
UUID = re.compile(r"[0-9a-f-]{36}")


def parse(call: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The command of a call and its ``--flag value`` pairs."""
    command, *rest = call["argv"]
    flags: dict[str, Any] = {}
    i = 0
    while i < len(rest):
        if rest[i] == "--apply":
            flags["apply"] = True
        else:
            flags[rest[i][2:]] = rest[i + 1]
            i += 1
        i += 1
    return command, flags


def token(**fields: Any) -> str:
    """A token of the version 2 shape, with fields replaced."""
    ref = {
        "version": 2,
        "creator": "agents.prompt.assistant.test.other",
        "account": "A" + "X" * 55,
        "target": {"volume": "theirreplies", "creation_id": "f" * 32},
        "root": "r" * 43,
        "generation": 3,
        "path": "/replies/theirs.md",
        "retention": {"slot": 1, "generation": 4},
        "expires_at": int(time.time()) + 300,
        **fields,
    }
    return "sp-ref:" + base64.urlsafe_b64encode(json.dumps(ref).encode()).decode().rstrip("=")


def own_token(**fields: Any) -> str:
    return token(
        account=OWN_ACCOUNT, target={"volume": "testreplies", "creation_id": CREATION_ID}, **fields
    )


class Rig:
    def __init__(self, tmp_path: Path) -> None:
        self.tmp = tmp_path
        self.log = tmp_path / "calls.jsonl"
        self.faults = tmp_path / "faults.json"
        self.state = tmp_path / "state.json"
        self.log.write_text("")

    def make(self, **extra: Any) -> SpCliScratchPad:
        options: dict[str, Any] = {
            "bin": str(FAKE_SP),
            "dir": str(self.tmp / "work"),
            "volume": "testreplies",
            "nats": NATS,
            "grant_ttl_s": 60,
            "creator": CREATOR,
            **extra,
        }
        return SpCliScratchPad(**options)

    def raw(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.log.read_text().splitlines() if line]

    def calls(self) -> list[tuple[str, dict[str, Any]]]:
        return [parse(c) for c in self.raw()]

    def commands(self) -> list[str]:
        return [c for c, _ in self.calls()]

    def clear(self) -> None:
        self.log.write_text("")

    def inject(self, faults: dict[str, list[dict[str, Any]]]) -> None:
        self.faults.write_text(json.dumps(faults))

    def fake_state(self) -> dict[str, Any]:
        """The fake CLI's state of this agent's volume."""
        state: dict[str, Any] = json.loads(self.state.read_text())["volumes"]["testreplies"]
        return state

    def edit(self, **fields: Any) -> None:
        store = json.loads(self.state.read_text())
        store["volumes"]["testreplies"].update(fields)
        self.state.write_text(json.dumps(store))

    def expire(self, slot: int) -> None:
        """Moves the deadline of the pin in ``slot`` into the past."""
        store = json.loads(self.state.read_text())
        store["volumes"]["testreplies"]["retention"][slot]["pin"]["until"] = int(time.time()) - 10
        self.state.write_text(json.dumps(store))

    def creds_for(self, user: str, account: str = OWN_ACCOUNT) -> str:
        """A credentials file for one more principal: the fake CLI reads the user JWT's claims."""
        claims = json.dumps({"sub": user, "iss": account, "nats": {"type": "user"}}).encode()
        body = base64.urlsafe_b64encode(claims).decode().rstrip("=")
        path = self.tmp / f"{user[:8]}.creds"
        path.write_text(
            "-----BEGIN NATS USER JWT-----\n"
            f"eyJ0eXAiOiJKV1QifQ.{body}.sig\n"
            "------END NATS USER JWT------\n"
        )
        return str(path)

    async def fill(self, sp: SpCliScratchPad) -> list[str]:
        """Eight live handoffs: every retention slot holds a pin."""
        return [await sp.commit(f"reply {i}", f"/replies/full{i}.md", TRACE) for i in range(8)]


@pytest.fixture
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Rig:
    r = Rig(tmp_path)
    monkeypatch.setenv("FAKE_SP_LOG", str(r.log))
    monkeypatch.setenv("FAKE_SP_STATE", str(r.state))
    monkeypatch.setenv("FAKE_SP_FAULTS", str(r.faults))
    monkeypatch.setenv("FAKE_SP_LOCK", str(tmp_path / "lock"))
    return r


async def test_commit_publishes_one_file_retained_ten_minutes_and_returns_the_clis_reference(
    rig: Rig,
) -> None:
    sp = rig.make()
    reference = await sp.commit("hello", "/replies/t1.md", TRACE)
    # The first commit of a process initializes the workspace and finishes
    # anything a previous process left pending; nothing else starts.
    assert rig.commands() == ["init", "recover", "publish-file"]
    flags = rig.calls()[2][1]
    assert flags["url"] == NATS.url and flags["creds"] == NATS.creds
    assert flags["dir"] == str((rig.tmp / "work").resolve()) and flags["volume"] == "testreplies"
    assert (
        flags["source"] == "-" and flags["path"] == "/replies/t1.md" and flags["creator"] == CREATOR
    )
    assert flags["ttl-seconds"] == "600" and UUID.fullmatch(flags["operation-id"])
    assert flags["thread-id"] == TRACE.thread_id and flags["root-id"] == TRACE.root_id
    assert rig.raw()[2]["stdin"] == "hello"  # the content went in on stdin, not through a file
    # The token is the CLI's, and names this agent as its creator.
    ref = decode_reference(reference)
    assert ref["version"] == 2 and ref["account"] == OWN_ACCOUNT and ref["path"] == "/replies/t1.md"
    assert (
        ref["target"] == {"volume": "testreplies", "creation_id": CREATION_ID}
        and ref["creator"] == CREATOR
    )
    assert reference_creator(reference) == CREATOR
    assert reference == rig.fake_state()["last"]["reference"]
    # Later commits publish and nothing more.
    rig.clear()
    await sp.commit("again", "/replies/t2.md", TRACE)
    assert rig.commands() == ["publish-file"]


async def test_read_hands_the_cli_the_reference_and_returns_exactly_the_bytes(rig: Rig) -> None:
    sp = rig.make()
    text = "what was committed: ünïcödé, \U0001f600, and a newline\n"
    reference = await sp.commit(text, "/replies/t2.md", TRACE)
    rig.clear()
    assert await rig.make(volume="Reader").read(reference, TRACE) == text
    assert rig.commands() == ["read"]
    flags = rig.calls()[0][1]
    assert (
        flags["ref"] == reference
        and flags["thread-id"] == TRACE.thread_id
        and flags["root-id"] == TRACE.root_id
    )
    assert "volume" not in flags


async def test_a_read_reply_whose_data_does_not_match_its_length_is_refused(rig: Rig) -> None:
    sp = rig.make()
    reference = await sp.commit("four", "/replies/t2b.md", TRACE)
    rig.inject({"read": [{"reply": {"bytes": 5}}]})
    with pytest.raises(ScratchPadError, match="does not match its length"):
        await sp.read(reference, TRACE)


async def test_no_file_is_left_behind_per_operation(rig: Rig) -> None:
    sp = rig.make()
    for i in range(5):
        reference = await sp.commit(f"reply {i}", f"/replies/t{i}.md", TRACE)
        await sp.read(reference, TRACE)
        await sp.grant_read(reference, GRANTEE, TRACE)
    # The fake CLI writes nothing there; the wrapper wrote nothing either.
    assert list((rig.tmp / "work").iterdir()) == []


async def test_grant_read_on_its_own_reference_is_one_principal_the_reference_a_bounded_lifetime(
    rig: Rig,
) -> None:
    sp = rig.make()
    reference = await sp.commit("mine", "/replies/t3.md", TRACE)
    rig.clear()
    assert await sp.owns(reference) is True
    assert sp.granted(reference, GRANTEE) is None
    await sp.grant_read(reference, GRANTEE, TRACE, "call_7")
    assert rig.commands() == ["grant"]
    flags = rig.calls()[0][1]
    assert flags["ref"] == reference
    assert flags["grantee-account"] == GRANTEE.account and flags["grantee-user"] == GRANTEE.user
    assert flags["ttl-seconds"] == "60" and UUID.fullmatch(flags["operation-id"])
    assert (
        flags["thread-id"] == TRACE.thread_id
        and flags["root-id"] == TRACE.root_id
        and flags["tool-call-id"] == "call_7"
    )
    # The ledger: that principal, that reference, and nobody and nothing else.
    # A grant this agent makes of its own accord is first-hand.
    assert sp.granted(reference, GRANTEE) == "first-hand"
    assert sp.granted(reference, Grantee(account=GRANTEE.account, user="U" + "D" * 55)) is None
    assert sp.granted(await sp.commit("other", "/replies/t3b.md", TRACE), GRANTEE) is None


async def test_a_first_hand_grant_on_one_root_does_not_cover_a_new_root_at_the_same_path(
    rig: Rig,
) -> None:
    sp = rig.make()
    first = await sp.commit("first reply", "/replies/thread.md", TRACE)
    second = await sp.commit("second reply", "/replies/thread.md", TRACE)
    assert decode_reference(first)["root"] != decode_reference(second)["root"]
    await sp.grant_read(first, GRANTEE, TRACE)
    assert sp.granted(first, GRANTEE) == "first-hand"
    assert sp.granted(second, GRANTEE) is None


async def test_the_ledger_keeps_first_hand_grants_and_grants_on_request_apart(rig: Rig) -> None:
    sp = rig.make()
    reference = await sp.commit("mine", "/replies/t3d.md", TRACE)
    other = Grantee(account=GRANTEE.account, user="U" + "E" * 55)
    # Made because another agent asked: recorded as such, and the CLI call is the same.
    rig.clear()
    await sp.grant_read(reference, other, TRACE, "call_8", "on-request")
    assert sp.granted(reference, other) == "on-request"
    assert rig.commands() == ["grant"]
    # A first-hand grant still running is not hidden by a later one made on request.
    await sp.grant_read(reference, GRANTEE, TRACE)
    await sp.grant_read(reference, GRANTEE, TRACE, None, "on-request")
    assert sp.granted(reference, GRANTEE) == "first-hand"


async def test_the_ledger_records_the_expiry_the_cli_reports_not_a_guess(rig: Rig) -> None:
    sp = rig.make()
    reference = await sp.commit("soon gone", "/replies/t3c.md", TRACE)
    rig.inject({"grant": [{"reply": {"expires_at": int(time.time()) - 1}}]})
    await sp.grant_read(reference, GRANTEE, TRACE)
    assert sp.granted(reference, GRANTEE) is None


async def test_no_grant_outlives_its_reference_and_none_is_asked_for_an_expired_one(
    rig: Rig,
) -> None:
    sp = rig.make(grant_ttl_s=3600)
    reference = await sp.commit("mine", "/replies/t6.md", TRACE)
    rig.clear()
    await sp.grant_read(reference, GRANTEE, TRACE)
    # Short of the reference's ten minutes by a margin for the CLI's clock.
    assert 585 < int(rig.calls()[0][1]["ttl-seconds"]) <= 595

    soon = int(time.time()) + 30
    rig.clear()
    await sp.grant_read(own_token(expires_at=soon), GRANTEE, TRACE)
    assert int(rig.calls()[0][1]["ttl-seconds"]) <= 25

    gone = own_token(expires_at=soon - 60)
    rig.clear()
    with pytest.raises(ValueError, match="expired"):
        await sp.grant_read(gone, GRANTEE, TRACE)
    with pytest.raises(ValueError, match="expired"):
        await sp.read(gone, TRACE)
    assert rig.calls() == []


async def test_the_ledger_is_finite_and_refuses_a_seventeenth_live_grant_before_asking(
    rig: Rig,
) -> None:
    sp = rig.make()
    reference = await sp.commit("mine", "/replies/t7.md", TRACE)
    for i in range(16):
        await sp.grant_read(
            reference, Grantee(account=GRANTEE.account, user="U" + chr(65 + i) * 55), TRACE
        )
    rig.clear()
    with pytest.raises(RuntimeError, match="16 live grants"):
        await sp.grant_read(reference, Grantee(account=GRANTEE.account, user="U" + "Z" * 55), TRACE)
    assert rig.calls() == []


async def test_nothing_is_granted_read_or_copied_on_a_reference_into_someone_elses_volume(
    rig: Rig,
) -> None:
    sp = rig.make()
    await sp.commit("mine", "/replies/t4.md", TRACE)  # the wrapper knows its own volume
    rig.clear()
    theirs = token()
    assert await sp.owns(theirs) is False
    with pytest.raises(PermissionError, match="only its creator can grant"):
        await sp.grant_read(theirs, GRANTEE, TRACE)
    assert sp.granted(theirs, GRANTEE) is None
    # Not one call to ScratchPad: being handed content is not a right to pass it on.
    assert rig.calls() == []
    # Another incarnation of the same volume is not this agent's either.
    assert (
        await sp.owns(
            token(account=OWN_ACCOUNT, target={"volume": "testreplies", "creation_id": "e" * 32})
        )
        is False
    )


async def test_it_owns_nothing_before_it_has_a_volume_and_creates_none_to_find_out(
    rig: Rig,
) -> None:
    sp = rig.make()
    assert await sp.owns(token()) is False
    assert rig.commands() == ["describe"]


async def test_a_malformed_or_oversized_token_is_refused_before_the_cli_starts(rig: Rig) -> None:
    sp = rig.make()
    good = token()
    old = {"ref": {"volume_id": "v", "root": "r", "path": "/x"}, "source_sequence": 1}
    bad = [
        "sp-ref:",
        "sp-ref:!!!",
        "sp-ref:" + "A" * 16 * 1024,
        "sp-ref:" + base64.urlsafe_b64encode(b"not json").decode().rstrip("="),
        good + "=",
        token(version=1),
        token(extra=True),
        token(account="$G"),
        token(creator=""),
        token(generation=0),
        token(generation=True),
        token(path="replies/x.md"),
        token(path="/" + "x" * 300),
        token(retention={"slot": 8, "generation": 1}),
        token(target={"volume": "their-replies", "creation_id": "f" * 32}),
        # The token the earlier CLI made.
        "sp-ref:" + base64.urlsafe_b64encode(json.dumps(old).encode()).decode().rstrip("="),
    ]
    for t in bad:
        with pytest.raises(ValueError, match="malformed ScratchPad reference"):
            await sp.read(t, TRACE)
        assert await sp.owns(t) is False
        assert sp.granted(t, GRANTEE) is None
    assert rig.calls() == []


async def test_an_unknown_commit_stays_pending_and_the_same_command_is_finished_before_the_next(
    rig: Rig,
) -> None:
    sp = rig.make()
    await sp.commit("first", "/replies/t8.md", TRACE)
    rig.inject({"publish-file": [{"code": "unavailable", "unknown": True, "after": True}]})
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("lost reply", "/replies/t9.md", TRACE)
    assert caught.value.code == "unavailable" and caught.value.unknown is True
    rig.clear()
    await sp.commit("next", "/replies/t10.md", TRACE)
    # Recovery repeats the saved command; nothing resets the writer.
    assert rig.commands() == ["recover", "publish-file"]


async def test_an_unknown_recovery_stops_rather_than_starting_a_different_command(rig: Rig) -> None:
    sp = rig.make()
    await sp.commit("first", "/replies/t8.md", TRACE)
    rig.inject(
        {
            "publish-file": [{"code": "unavailable", "unknown": True}],
            "recover": [{"code": "unavailable", "unknown": True}],
        }
    )
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("lost", "/replies/t9.md", TRACE)
    assert caught.value.unknown
    rig.clear()
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("next", "/replies/t10.md", TRACE)
    assert caught.value.unknown
    assert rig.commands() == ["recover"]


async def test_a_reply_it_cannot_read_counts_as_an_unknown_outcome(rig: Rig) -> None:
    sp = rig.make()
    rig.inject({"publish-file": [{"reply": {"reference": 7}}]})
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("x", "/replies/t11.md", TRACE)
    assert caught.value.unknown


async def test_a_full_scratchpad_is_cleaned_up_and_the_same_commit_tried_once_more(
    rig: Rig,
) -> None:
    sp = rig.make()
    await sp.commit("first", "/replies/t12.md", TRACE)
    rig.inject({"publish-file": [{"code": "capacity", "unknown": False}]})
    rig.clear()
    reference = await sp.commit("after cleanup", "/replies/t13.md", TRACE)
    calls = rig.calls()
    # A free retention slot, and the content allowance full: cleanup can help.
    assert [c for c, _ in calls] == ["publish-file", "describe", "maintain", "publish-file"]
    assert calls[2][1]["apply"] is True
    assert calls[3][1]["operation-id"] == calls[0][1]["operation-id"]
    assert await sp.read(reference, TRACE) == "after cleanup"


async def test_no_live_handoff_is_evicted_and_nothing_is_closed_when_every_retention_slot_is_live(
    rig: Rig,
) -> None:
    sp = rig.make()
    refs = await rig.fill(sp)
    rig.clear()
    with pytest.raises(ScratchPadError, match="every retention slot holds a live pin") as caught:
        await sp.commit("one too many", "/replies/full8.md", TRACE)
    assert (caught.value.code, caught.value.unknown) == ("capacity", False)
    reader = rig.make(volume="Reader")
    for i, ref in enumerate(refs):
        assert await reader.read(ref, TRACE) == f"reply {i}"
    # The describe decided it: no maintenance, and every earlier handoff read.
    assert rig.commands() == ["publish-file", "describe", *["read"] * 8]
    assert rig.fake_state()["closed"] is False


async def test_an_expired_pin_that_can_be_released_is_collected_and_the_retry_takes_its_slot(
    rig: Rig,
) -> None:
    sp = rig.make()
    refs = await rig.fill(sp)
    rig.expire(3)
    rig.clear()
    reference = await sp.commit("after release", "/replies/full8.md", TRACE)
    assert rig.commands() == ["publish-file", "describe", "maintain", "publish-file"]
    assert decode_reference(reference)["retention"]["slot"] == 3
    assert await sp.read(reference, TRACE) == "after release"
    assert await sp.read(refs[4], TRACE) == "reply 4"
    assert rig.fake_state()["closed"] is False


async def test_an_expired_pin_a_live_grant_names_counts_as_live_and_nothing_is_closed(
    rig: Rig,
) -> None:
    sp = rig.make()
    refs = await rig.fill(sp)
    await sp.grant_read(refs[2], GRANTEE, TRACE)
    rig.expire(2)
    rig.clear()
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("one too many", "/replies/full8.md", TRACE)
    assert (caught.value.code, caught.value.unknown) == ("capacity", False)
    assert rig.commands() == ["publish-file", "describe"]


async def test_a_volume_someone_else_closed_is_never_reopened(rig: Rig) -> None:
    sp = rig.make()
    await rig.fill(sp)
    rig.expire(0)
    rig.edit(closed=True)
    rig.clear()
    with pytest.raises(ScratchPadError, match="no cleanup of this agent's is saved"):
        await sp.commit("while closed", "/replies/full8.md", TRACE)
    assert rig.commands() == ["publish-file", "describe"]
    assert rig.fake_state()["closed"] is True


async def test_an_unknown_cleanup_stays_unknown_and_is_finished_before_the_next_publication(
    rig: Rig,
) -> None:
    sp = rig.make()
    await rig.fill(sp)
    rig.expire(5)
    rig.inject({"maintain": [{"stage": "closed", "code": "unavailable", "unknown": True}]})
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("during cleanup", "/replies/full8.md", TRACE)
    assert (caught.value.code, caught.value.unknown) == ("unavailable", True)
    # The close happened; the saved apply is what remains.
    state = rig.fake_state()
    assert state["closed"] is True and state["control"]["kind"] == "apply"
    rig.clear()
    reference = await sp.commit("next", "/replies/full9.md", TRACE)
    assert rig.commands() == ["recover", "publish-file"]
    state = rig.fake_state()
    assert state["closed"] is False and state["control"] is None
    assert await sp.read(reference, TRACE) == "next"


async def test_an_unfinished_cleanup_is_finished_before_a_grant(rig: Rig) -> None:
    sp = rig.make()
    refs = await rig.fill(sp)
    rig.expire(6)
    rig.inject({"maintain": [{"stage": "closed", "code": "unavailable", "unknown": True}]})
    with pytest.raises(ScratchPadError):
        await sp.commit("during cleanup", "/replies/full8.md", TRACE)
    rig.clear()
    await sp.grant_read(refs[0], GRANTEE, TRACE)
    assert rig.commands() == ["recover", "grant"]
    assert sp.granted(refs[0], GRANTEE) == "first-hand"


async def test_a_definite_cleanup_failure_stays_a_capacity_refusal_and_is_still_recovered(
    rig: Rig,
) -> None:
    sp = rig.make()
    await rig.fill(sp)
    rig.expire(1)
    rig.inject({"maintain": [{"stage": "closed", "code": "invalid", "unknown": False}]})
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("during cleanup", "/replies/full8.md", TRACE)
    assert (caught.value.code, caught.value.unknown) == ("capacity", False)
    rig.clear()
    await sp.commit("next", "/replies/full9.md", TRACE)
    assert rig.commands() == ["recover", "publish-file"]


async def test_after_a_restart_the_cleanup_an_earlier_process_left_saved_is_finished(
    rig: Rig,
) -> None:
    sp = rig.make()
    await rig.fill(sp)
    rig.expire(7)
    rig.inject({"maintain": [{"stage": "closed", "code": "unavailable", "unknown": True}]})
    with pytest.raises(ScratchPadError):
        await sp.commit("during cleanup", "/replies/full8.md", TRACE)
    rig.clear()
    restarted = rig.make()
    await restarted.commit("after restart", "/replies/full9.md", TRACE)
    assert rig.commands() == ["init", "recover", "publish-file"]
    assert rig.fake_state()["closed"] is False


async def test_nothing_is_closed_when_the_describe_reply_is_out_of_shape(rig: Rig) -> None:
    sp = rig.make()
    await rig.fill(sp)
    rig.expire(0)
    rig.inject(
        {"describe": [{"reply": {"volume": {"closed": False, "retentions": [], "grants": []}}}]}
    )
    rig.clear()
    with pytest.raises(ScratchPadError) as caught:
        await sp.commit("x", "/replies/full8.md", TRACE)
    assert (caught.value.code, caught.value.unknown) == ("capacity", False)
    assert rig.commands() == ["publish-file", "describe"]


def test_the_describe_view_is_decoded_only_in_the_clis_exact_shape() -> None:
    slot = {"generation": 1}
    free_grant = {"generation": 0}
    good = {
        "control": None,
        "volume": {"closed": False, "retentions": [slot] * 8, "grants": [free_grant] * 16},
    }
    assert len(decode_describe(good).retentions) == 8
    bad_pin = {"generation": 1, "pin": {"root": "r", "until": -1}}
    bad_grant = {"generation": 1, "grant": {"until": 5, "retention": {"slot": 8, "generation": 1}}}
    for bad in (
        {**good, "control": {"kind": "reset"}},
        {**good, "volume": {**good["volume"], "closed": "no"}},
        {**good, "volume": {**good["volume"], "retentions": [slot] * 7}},
        {**good, "volume": {**good["volume"], "retentions": [slot] * 7 + [bad_pin]}},
        {**good, "volume": {**good["volume"], "grants": [free_grant] * 15 + [bad_grant]}},
    ):
        with pytest.raises(ScratchPadError, match="sp describe"):
            decode_describe(bad)


async def test_an_unknown_grant_stays_out_of_the_ledger_and_is_finished_before_the_next(
    rig: Rig,
) -> None:
    sp = rig.make()
    reference = await sp.commit("mine", "/replies/t14.md", TRACE)
    rig.inject({"grant": [{"code": "unavailable", "unknown": True}]})
    rig.clear()
    with pytest.raises(ScratchPadError) as caught:
        await sp.grant_read(reference, GRANTEE, TRACE, "call_1")
    assert caught.value.unknown
    assert sp.granted(reference, GRANTEE) is None
    other = Grantee(account=GRANTEE.account, user="U" + "F" * 55)
    await sp.grant_read(reference, other, TRACE, "call_2")
    calls = rig.calls()
    assert [c for c, _ in calls] == ["grant", "grant", "grant"]
    # The retry is the same grant: same operation, lifetime and labels.
    assert calls[1][1] == calls[0][1]
    assert sp.granted(reference, GRANTEE) == "first-hand"
    assert sp.granted(reference, other) == "first-hand"


async def test_one_mutation_runs_at_a_time_without_waiting_on_a_clock(rig: Rig) -> None:
    sp = rig.make()
    names = [f"c{i}" for i in range(6)]
    results = await asyncio.gather(*(sp.commit(t, f"/replies/{t}.md", TRACE) for t in names))
    await asyncio.gather(
        *(op for r in results for op in (sp.grant_read(r, GRANTEE, TRACE), sp.read(r, TRACE)))
    )
    # The fake CLI fails with ``busy`` when two mutations overlap; none did.
    assert [decode_reference(r)["path"] for r in results] == [f"/replies/{t}.md" for t in names]
    assert all(sp.granted(r, GRANTEE) == "first-hand" for r in results)


async def test_a_handoff_to_another_agent_in_its_account_opens_only_by_its_grant(rig: Rig) -> None:
    sp = rig.make()
    reader = rig.make(
        dir=str(rig.tmp / "reader"),
        volume="Reader",
        nats=_Connection(url=NATS.url, creds=rig.creds_for(GRANTEE.user)),
    )
    reference = await sp.commit("for the reader", "/replies/t15.md", TRACE)
    with pytest.raises(ScratchPadError) as caught:
        await reader.read(reference, TRACE)
    assert (caught.value.code, caught.value.unknown) == ("denied", False)
    await sp.grant_read(reference, GRANTEE, TRACE)
    assert await reader.read(reference, TRACE) == "for the reader"


async def test_a_grant_the_cli_refuses_stays_out_of_the_ledger_another_account(rig: Rig) -> None:
    sp = rig.make()
    reference = await sp.commit("mine", "/replies/t16.md", TRACE)
    elsewhere = Grantee(account="A" + "B" * 55, user=GRANTEE.user)
    with pytest.raises(ScratchPadError, match="limited to the reference's account") as caught:
        await sp.grant_read(reference, elsewhere, TRACE)
    assert (caught.value.code, caught.value.unknown) == ("denied", False)
    assert sp.granted(reference, elsewhere) is None
    # A definite refusal is settled: the next grant goes ahead on its own.
    rig.clear()
    await sp.grant_read(reference, GRANTEE, TRACE)
    assert rig.commands() == ["grant"]


async def test_a_refused_read_reports_the_cli_error_code(rig: Rig) -> None:
    sp = rig.make()
    with pytest.raises(ScratchPadError, match="sp read: denied"):
        await sp.read(token(), TRACE)


async def test_it_needs_a_url_and_credentials_file_and_a_creator_to_commit(rig: Rig) -> None:
    with pytest.raises(
        ValueError,
        match="NATS_URL and NATS_CREDS; a NATS context or an nkey seed alone is not supported",
    ):
        rig.make(nats=_Connection(context="dev"))
    anonymous = rig.make(creator=None)
    with pytest.raises(ValueError, match="names its creator"):
        await anonymous.commit("x", "/replies/x.md", TRACE)
    assert rig.calls() == []


async def test_the_cli_gets_its_directorys_real_path(rig: Rig) -> None:
    # As on macOS, where /tmp and $TMPDIR are symlinks.
    (rig.tmp / "real").mkdir()
    (rig.tmp / "link").symlink_to(rig.tmp / "real")
    linked = rig.make(dir=str(rig.tmp / "link" / "work"))
    await linked.commit("hello", "/replies/t5.md", TRACE)
    assert {f["dir"] for _, f in rig.calls()} == {str((rig.tmp / "real" / "work").resolve())}
