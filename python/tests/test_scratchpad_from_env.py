"""``scratchpad_from_env``: ScratchPad by configuration.

An unset ``SCRATCHPAD_VOLUME`` is ScratchPad off; otherwise the four variables
and the agent's own connection become the ``sp`` calls
:class:`SpCliScratchPad` makes, seen through the stand-in CLI
(``harness/fake_sp.py``). The same test as the TypeScript package's
``test/unit/scratchpad-from-env.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from synadia_ai.agent_fabric import Grantee, TraceIds, reference_creator, scratchpad_from_env

FAKE_SP = Path(__file__).resolve().parent / "harness" / "fake_sp.py"
TRACE = TraceIds("1" * 32, "2" * 32)
# In the stand-in's own account: ``sp`` grants only within the reference's account.
GRANTEE = Grantee(account="A" + "O" * 55, user="U" + "C" * 55)


@pytest.fixture
def log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "calls.jsonl"
    path.write_text("")
    monkeypatch.setenv("FAKE_SP_LOG", str(path))
    monkeypatch.setenv("FAKE_SP_STATE", str(tmp_path / "state.json"))
    return path


def argvs(log: Path) -> list[list[str]]:
    return [json.loads(line)["argv"] for line in log.read_text().splitlines() if line]


def flag(argv: list[str], name: str) -> str | None:
    return argv[argv.index(f"--{name}") + 1] if f"--{name}" in argv else None


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
            "SCRATCHPAD_VOLUME": "EnvReplies",
            "SCRATCHPAD_BIN": str(FAKE_SP),
            "SCRATCHPAD_DIR": str(tmp_path / "work"),
            "SCRATCHPAD_GRANT_TTL_S": "42",
            "NATS_URL": "nats://10.0.0.1:4222",
            "NATS_CREDS": "/nowhere/agent.creds",
        },
        creator="agents.prompt.assistant.test.main",
    )
    assert pad is not None
    reference = await pad.commit("hello", "/replies/env.md", TRACE)
    await pad.grant_read(reference, GRANTEE, TRACE)
    calls = argvs(log)
    # SCRATCHPAD_BIN: the calls reached the stand-in. The credentials the agent
    # connects with and its workspace, on every call; the volume by name.
    assert [a[0] for a in calls] == ["init", "recover", "publish-file", "grant"]
    for argv in calls:
        assert flag(argv, "url") == "nats://10.0.0.1:4222"
        assert flag(argv, "creds") == "/nowhere/agent.creds"
        assert flag(argv, "volume") == "EnvReplies"
        # SCRATCHPAD_DIR, by its real path.
        assert flag(argv, "dir") == str((tmp_path / "work").resolve())
    # SCRATCHPAD_GRANT_TTL_S.
    assert flag(calls[3], "ttl-seconds") == "42"
    # The creator went into the token.
    assert flag(calls[2], "creator") == "agents.prompt.assistant.test.main"
    assert reference_creator(reference) == "agents.prompt.assistant.test.main"


async def test_uses_the_credentials_file_when_a_nats_context_is_named_beside_it(
    tmp_path: Path, log: Path
) -> None:
    pad = scratchpad_from_env(
        {
            "SCRATCHPAD_VOLUME": "EnvReplies",
            "SCRATCHPAD_BIN": str(FAKE_SP),
            "SCRATCHPAD_DIR": str(tmp_path / "work-context"),
            "NATS_CONTEXT": "fabric",
            "NATS_CREDS": "/nowhere/agent.creds",
        },
        creator="agents.prompt.assistant.test.main",
    )
    assert pad is not None
    await pad.commit("x", "/replies/x.md", TRACE)
    argv = argvs(log)[0]
    assert flag(argv, "url") == "nats://127.0.0.1:4222"
    assert flag(argv, "creds") == "/nowhere/agent.creds"
    assert "--context" not in argv


def test_refuses_a_connection_sp_cannot_use_and_a_ttl_that_is_not_positive() -> None:
    # sp v2 reads no NATS context, and takes no nkey seed alone.
    for env in ({"SCRATCHPAD_VOLUME": "v"}, {"SCRATCHPAD_VOLUME": "v", "NATS_CONTEXT": "fabric"}):
        with pytest.raises(
            ValueError,
            match="needs NATS_URL and NATS_CREDS; a NATS context or an nkey seed alone",
        ):
            scratchpad_from_env(env)
    with pytest.raises(ValueError, match="SCRATCHPAD_GRANT_TTL_S must be a positive number"):
        scratchpad_from_env(
            {"SCRATCHPAD_VOLUME": "v", "NATS_CREDS": "/c", "SCRATCHPAD_GRANT_TTL_S": "0"}
        )
