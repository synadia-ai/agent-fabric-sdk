"""``scratchpad_from_env``: ScratchPad by configuration.

An unset ``SCRATCHPAD_VOLUME`` is ScratchPad off; otherwise the four variables
and the agent's own connection become the ``sp`` calls
:class:`SpCliScratchPad` makes, seen through the stand-in CLI
(``harness/fake_sp.py``). The same test as the TypeScript package's
``test/unit/scratchpad-from-env.test.ts``.
"""

from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import pytest

from synadia_ai.agent_fabric import Grantee, TraceIds, scratchpad_from_env

FAKE_SP = Path(__file__).resolve().parent / "harness" / "fake_sp.py"
TRACE = TraceIds("1" * 32, "2" * 32)
GRANTEE = Grantee(account="A" + "B" * 55, user="U" + "C" * 55)


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "calls.jsonl"
    path.write_text("")
    monkeypatch.setenv("FAKE_SP_LOG", str(path))
    monkeypatch.setenv("FAKE_SP_STATE", str(tmp_path / "state.json"))
    monkeypatch.setenv("FAKE_SP_VOLUME", "env-replies")
    return path


def argvs(log: Path) -> list[list[str]]:
    return [json.loads(line)["argv"] for line in log.read_text().splitlines() if line]


def flag(argv: list[str], name: str) -> str | None:
    return argv[argv.index(f"-{name}") + 1] if f"-{name}" in argv else None


def test_off_when_the_volume_is_unset_or_empty() -> None:
    assert scratchpad_from_env({}) is None
    assert scratchpad_from_env({"SCRATCHPAD_VOLUME": "", "NATS_CREDS": "/nowhere/a.creds"}) is None
    # Off means nothing else is read: a bad TTL without a volume is no error.
    assert scratchpad_from_env({"SCRATCHPAD_GRANT_TTL_S": "soon"}) is None


async def test_reads_the_four_variables_and_the_agents_credentials(
    tmp_path: Path, log: Path
) -> None:
    pad = scratchpad_from_env(
        {
            "SCRATCHPAD_VOLUME": "env-replies",
            "SCRATCHPAD_BIN": str(FAKE_SP),
            "SCRATCHPAD_DIR": str(tmp_path / "work"),
            "SCRATCHPAD_GRANT_TTL_S": "42",
            "NATS_URL": "nats://10.0.0.1:4222",
            "NATS_CREDS": "/nowhere/agent.creds",
        },
        creator="agents.prompt.assistant.test.main",
    )
    assert pad is not None
    before = int(time.time())
    reference = await pad.commit("hello", "/replies/env.md", TRACE)
    await pad.grant_read(reference, GRANTEE, TRACE)
    calls = argvs(log)
    # SCRATCHPAD_BIN: the calls reached the stand-in. The volume by name, the
    # credentials the agent connects with, on every call.
    assert [a[0] for a in calls] == ["volume", "session", "put", "commit", "ref", "grant"]
    for argv in calls:
        assert flag(argv, "url") == "nats://10.0.0.1:4222"
        assert flag(argv, "creds") == "/nowhere/agent.creds"
    # SCRATCHPAD_DIR, by its real path.
    assert str(flag(calls[1], "save")).startswith(str((tmp_path / "work").resolve()) + "/")
    # SCRATCHPAD_GRANT_TTL_S.
    assert before + 42 <= int(str(flag(calls[5], "expires-at"))) <= before + 44
    # The creator went into the token.
    body = reference[len("sp-ref:") :]
    made = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    assert made["creator"] == "agents.prompt.assistant.test.main"


async def test_connects_by_nats_context_when_one_is_named(tmp_path: Path, log: Path) -> None:
    pad = scratchpad_from_env(
        {
            "SCRATCHPAD_VOLUME": "env-replies",
            "SCRATCHPAD_BIN": str(FAKE_SP),
            "SCRATCHPAD_DIR": str(tmp_path / "work-context"),
            "NATS_CONTEXT": "fabric",
            "NATS_CREDS": "/nowhere/agent.creds",
        }
    )
    assert pad is not None
    body = base64.urlsafe_b64encode(b'{"ref":{"volume_id":"v"}}').decode().rstrip("=")
    await pad.owns(f"sp-ref:{body}")
    assert argvs(log) == [["volume", "list", "-context", "fabric", "-json"]]


def test_refuses_a_connection_sp_cannot_use_and_a_ttl_that_is_not_positive() -> None:
    with pytest.raises(ValueError, match="NATS_CREDS or NATS_CONTEXT"):
        scratchpad_from_env({"SCRATCHPAD_VOLUME": "v"})
    with pytest.raises(ValueError, match="SCRATCHPAD_GRANT_TTL_S must be a positive number"):
        scratchpad_from_env(
            {"SCRATCHPAD_VOLUME": "v", "NATS_CREDS": "/c", "SCRATCHPAD_GRANT_TTL_S": "0"}
        )
