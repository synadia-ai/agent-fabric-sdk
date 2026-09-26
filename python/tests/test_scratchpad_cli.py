"""The ScratchPad wrapper against a stand-in for the ``sp`` command line
(``harness/fake_sp.py``): what the wrapper asks the CLI to do, in which order,
with which flags. The real ScratchPad was measured by hand
(``agent-fabric-examples`` ``docs/findings.md`` F6, the PLAN log); this pins
the calls down so a change in the wrapper shows up in ``pytest``. The same
test as the TypeScript package's ``test/unit/scratchpad-cli.test.ts``. Moved
here with the wrapper from ``agent-fabric-examples`` ``agents/py`` at
``1ed3c45``.

The grant is the point: on a reference into the agent's own volume, one
``grant issue`` to one principal, read only, on the one path, with an expiry,
and a line in the ledger of whom this agent granted what; on a reference into
someone else's volume, nothing: no read, no copy, no grant. Only the creator
grants (``test_grant_request.py``). The wrapper is the ``ScratchPad`` port
with a commit and a read, :class:`SpCliScratchPad`; the vocabulary of
references is tested in ``test_scratchpad_vocabulary.py``.
"""

from __future__ import annotations

import base64
import json
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    Grantee,
    ScratchPadClient,
    SpCliScratchPad,
    TraceIds,
    reference_creator,
)

FAKE_SP = Path(__file__).resolve().parent / "harness" / "fake_sp.py"
TRACE = TraceIds("1" * 32, "2" * 32)
GRANTEE = Grantee(account="A" + "B" * 55, user="U" + "C" * 55)


@dataclass(frozen=True)
class NatsConfig:
    """The agent's connection source, the shape of the examples' own config."""

    context: str | None = None
    url: str | None = None
    creds: str | None = None
    nkey: str | None = None


# The implementation satisfies the interface it is handed on as.
_: type[ScratchPadClient] = SpCliScratchPad


def parse(call: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """The verb of a call and its ``-flag value`` pairs."""
    flags: dict[str, Any] = {}
    words: list[str] = []
    argv: list[str] = call["argv"]
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-"):
            if a in ("-json", "-apply"):
                flags[a[1:]] = True
            else:
                i += 1
                flags[a[1:]] = argv[i]
        else:
            words.append(a)
        i += 1
    return " ".join(words), flags


def decode(reference: str) -> dict[str, Any]:
    text = reference[len("sp-ref:") :]
    return json.loads(base64.urlsafe_b64decode(text + "=" * (-len(text) % 4)))


def foreign_reference(path: str) -> str:
    """A token as another agent would hand it over: into a volume that is not ours."""
    made = {
        "ref": {
            "type": "handoff",
            "handoff_id": "hnd-theirs",
            "volume_id": "vol-other",
            "root": "root-x",
            "path": path,
            "expires_at": 9_000_000_000,
        },
        "source_sequence": 3,
    }
    return "sp-ref:" + base64.urlsafe_b64encode(json.dumps(made).encode()).decode().rstrip("=")


@pytest.fixture
def pad(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[SpCliScratchPad, Path]:
    log = tmp_path / "calls.jsonl"
    log.write_text("")
    monkeypatch.setenv("FAKE_SP_LOG", str(log))
    monkeypatch.setenv("FAKE_SP_STATE", str(tmp_path / "state.json"))
    monkeypatch.setenv("FAKE_SP_VOLUME", "test-replies")
    monkeypatch.delenv("FAKE_SP_DENY_VOLUME", raising=False)
    sp = SpCliScratchPad(
        bin=str(FAKE_SP),
        dir=str(tmp_path / "work"),
        volume="test-replies",
        nats=NatsConfig(url="nats://127.0.0.1:4222", creds="/nowhere/agent.creds"),
        grant_ttl_s=60,
        creator="agents.prompt.assistant.test.main",
    )
    return sp, log


def calls(log: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in log.read_text().splitlines() if line]


async def test_commit_is_a_session_a_put_a_commit_and_a_ref_on_the_served_thread(
    pad: tuple[SpCliScratchPad, Path],
) -> None:
    sp, log = pad
    reference = await sp.commit("hello", "/replies/t1.md", TRACE)
    assert reference.startswith("sp-ref:")
    made = decode(reference)
    assert made["ref"]["volume_id"] == "vol-own" and made["ref"]["path"] == "/replies/t1.md"
    assert made["source_sequence"] == 7
    # The token names the agent that made it, so whoever is handed it knows whom to ask.
    assert made["creator"] == "agents.prompt.assistant.test.main"
    assert reference_creator(reference) == "agents.prompt.assistant.test.main"

    seen = calls(log)
    parsed = [parse(c) for c in seen]
    assert [v for v, _ in parsed] == ["volume list", "session open", "put", "commit", "ref make"]
    for _, flags in parsed:
        # The agent's own credentials, the served thread, machine-readable output.
        assert flags["url"] == "nats://127.0.0.1:4222" and flags["creds"] == "/nowhere/agent.creds"
        assert (
            flags["thread-id"] == TRACE.thread_id
            and flags["root-id"] == TRACE.root_id
            and flags["json"] is True
        )
    assert (
        parsed[1][1]["volume-id"] == "vol-own"
        and parsed[1][1]["base-root"] == "root-0"
        and parsed[1][1]["write-scope"] == "/"
    )
    assert parsed[2][1]["path"] == "/replies/t1.md" and parsed[2][1]["source"] == "-"
    assert parsed[3][1]["apply"] is True
    assert parsed[4][1]["volume-id"] == "vol-own" and parsed[4][1]["path"] == "/replies/t1.md"
    assert seen[2]["stdin"] == "hello"  # the content went in on stdin


async def test_read_resolves_the_reference_then_cats(pad: tuple[SpCliScratchPad, Path]) -> None:
    sp, log = pad
    reference = await sp.commit("what was committed", "/replies/t2.md", TRACE)
    log.write_text("")
    assert await sp.read(reference, TRACE) == "what was committed"
    parsed = [parse(c) for c in calls(log)]
    assert [v for v, _ in parsed] == ["ref resolve", "cat"]
    assert parsed[1][1]["volume-id"] == "vol-own" and parsed[1][1]["path"] == "/replies/t2.md"
    # The CLI gets back what ``ref.make`` replied, without the token's ``creator``.
    assert sorted(json.loads(Path(parsed[0][1]["ref"]).read_text())) == ["ref", "source_sequence"]


async def test_grant_read_on_own_volume_is_one_principal_one_path_read_with_an_expiry(
    pad: tuple[SpCliScratchPad, Path],
) -> None:
    sp, log = pad
    reference = await sp.commit("mine", "/replies/t3.md", TRACE)
    log.write_text("")
    before = int(time.time())
    assert await sp.owns(reference) is True
    assert sp.granted(reference, GRANTEE) is None
    await sp.grant_read(reference, GRANTEE, TRACE, "call_7")
    parsed = [parse(c) for c in calls(log)]
    assert [v for v, _ in parsed] == ["grant issue"]
    flags = parsed[0][1]
    assert flags["volume-id"] == "vol-own"
    assert flags["grantee-account"] == GRANTEE.account and flags["grantee-user"] == GRANTEE.user
    assert flags["subtree"] == "/replies/t3.md" and "scope-root" not in flags
    assert flags["actions"] == "read"
    assert (
        flags["thread-id"] == TRACE.thread_id
        and flags["root-id"] == TRACE.root_id
        and flags["tool-call-id"] == "call_7"
    )
    assert before + 60 <= int(flags["expires-at"]) <= before + 62
    assert re.fullmatch(r"[0-9a-f-]{36}", flags["operation-id"])
    # The ledger: that principal, that reference, and nobody and nothing else.
    # A grant this agent makes of its own accord is first-hand.
    assert sp.granted(reference, GRANTEE) == "first-hand"
    assert sp.granted(reference, Grantee(account=GRANTEE.account, user="U" + "D" * 55)) is None
    assert sp.granted(await sp.commit("other", "/replies/t3b.md", TRACE), GRANTEE) is None


async def test_the_ledger_keeps_first_hand_grants_and_grants_on_request_apart(
    pad: tuple[SpCliScratchPad, Path],
) -> None:
    sp, log = pad
    reference = await sp.commit("mine", "/replies/t3d.md", TRACE)
    other = Grantee(account=GRANTEE.account, user="U" + "E" * 55)
    # Made because another agent asked: recorded as such, and the CLI call is the same.
    log.write_text("")
    await sp.grant_read(reference, other, TRACE, "call_8", "on-request")
    assert sp.granted(reference, other) == "on-request"
    assert [parse(c)[0] for c in calls(log)] == ["grant issue"]
    # A first-hand grant still running is not hidden by a later one made on request.
    await sp.grant_read(reference, GRANTEE, TRACE)
    await sp.grant_read(reference, GRANTEE, TRACE, None, "on-request")
    assert sp.granted(reference, GRANTEE) == "first-hand"


async def test_a_grant_is_forgotten_when_it_expires(
    tmp_path: Path, pad: tuple[SpCliScratchPad, Path]
) -> None:
    brief = SpCliScratchPad(
        bin=str(FAKE_SP),
        dir=str(tmp_path / "work-brief"),
        volume="test-replies",
        nats=NatsConfig(url="nats://127.0.0.1:4222", creds="/nowhere/agent.creds"),
        grant_ttl_s=0,
    )
    reference = await brief.commit("soon gone", "/replies/t3c.md", TRACE)
    await brief.grant_read(reference, GRANTEE, TRACE)
    assert brief.granted(reference, GRANTEE) is None


async def test_nothing_is_granted_read_or_copied_on_a_reference_into_someone_elses_volume(
    pad: tuple[SpCliScratchPad, Path],
) -> None:
    sp, log = pad
    await sp.commit("mine", "/replies/t4.md", TRACE)  # the wrapper knows its own volume
    log.write_text("")
    theirs = foreign_reference("/replies/theirs.md")
    assert await sp.owns(theirs) is False
    with pytest.raises(PermissionError, match="only its creator can grant"):
        await sp.grant_read(theirs, GRANTEE, TRACE)
    assert sp.granted(theirs, GRANTEE) is None
    # Not one call to ScratchPad: being handed content is not a right to pass it on.
    assert calls(log) == []
    assert reference_creator(theirs) is None


async def test_it_owns_nothing_before_it_has_a_volume_and_creates_none_to_find_out(
    tmp_path: Path, pad: tuple[SpCliScratchPad, Path]
) -> None:
    _, log = pad
    fresh = SpCliScratchPad(
        bin=str(FAKE_SP),
        dir=str(tmp_path / "work-fresh"),
        volume="never-committed-to",
        nats=NatsConfig(url="nats://127.0.0.1:4222", creds="/nowhere/agent.creds"),
    )
    assert await fresh.owns(foreign_reference("/replies/theirs.md")) is False
    assert [parse(c)[0] for c in calls(log)] == ["volume list"]


async def test_replies_are_saved_under_the_directorys_real_path_because_sp_refuses_a_symlink(
    tmp_path: Path, pad: tuple[SpCliScratchPad, Path]
) -> None:
    # As on macOS, where /tmp and $TMPDIR are symlinks.
    _, log = pad
    (tmp_path / "real").mkdir()
    (tmp_path / "link").symlink_to(tmp_path / "real")
    linked = SpCliScratchPad(
        bin=str(FAKE_SP),
        dir=str(tmp_path / "link" / "work"),
        volume="test-replies",
        nats=NatsConfig(url="nats://127.0.0.1:4222", creds="/nowhere/agent.creds"),
    )
    await linked.commit("hello", "/replies/t5.md", TRACE)
    saved = [
        flags["save"] for verb, flags in (parse(c) for c in calls(log)) if verb == "session open"
    ]
    assert len(saved) == 1
    assert saved[0].startswith(str((tmp_path / "real" / "work").resolve()) + "/")


async def test_a_refused_read_reports_the_cli_error_code(
    pad: tuple[SpCliScratchPad, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    sp, _ = pad
    monkeypatch.setenv("FAKE_SP_DENY_VOLUME", "vol-other")
    with pytest.raises(RuntimeError, match="permission_denied"):
        await sp.read(foreign_reference("/x.md"), TRACE)
