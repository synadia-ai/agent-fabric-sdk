"""The command's arguments, help and usage errors, without a server.

The TypeScript suite's ``command.test.ts``.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

from synadia_ai.agent_fabric import cli
from synadia_ai.agent_fabric.cli import (
    DEFAULT_TIMEOUT_S,
    EXIT_OK,
    EXIT_USAGE,
    USAGE,
    ParsedCommand,
    parse_command,
    run_command,
)
from tests.command_io import recording_io


def test_reads_agents_with_its_flags() -> None:
    assert parse_command(
        ["agents", "--creds", "a.creds", "--url=nats://x:4222", "--json"]
    ) == ParsedCommand(
        kind="agents", creds="a.creds", url="nats://x:4222", timeout_s=DEFAULT_TIMEOUT_S, json=True
    )


def test_reads_prompt_the_agent_the_text_joined_flags_anywhere() -> None:
    assert parse_command(["prompt", "--timeout", "5", "writer", "say", "hello"]) == ParsedCommand(
        kind="prompt", who="writer", text="say hello", timeout_s=5.0
    )


def test_takes_everything_after_the_double_dash_as_the_text() -> None:
    parsed = parse_command(["prompt", "writer", "--", "-5", "--json"])
    assert (parsed.who, parsed.text, parsed.json) == ("writer", "-5 --json", False)


def test_asks_for_help() -> None:
    for argv in (["--help"], ["prompt", "-h"], ["help"]):
        assert parse_command(argv).kind == "help"


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        ([], "name a command: agents or prompt"),
        (["deploy"], 'unknown command "deploy"'),
        (["agents", "extra"], 'agents takes no arguments, not "extra"'),
        (["prompt", "writer"], "prompt needs an agent and a text"),
        (["prompt", "writer", "hi", "--verbose"], "unknown option --verbose"),
        (["agents", "--creds"], "--creds needs a value"),
        (
            ["prompt", "w", "t", "--timeout", "soon"],
            '--timeout must be a positive number of seconds, not "soon"',
        ),
        (["prompt", "w", "t", "--timeout", "0"], "--timeout must be a positive number of seconds"),
    ],
)
def test_refuses(argv: list[str], message: str) -> None:
    parsed = parse_command(argv)
    assert parsed.kind == "usage"
    assert message in parsed.message


async def test_prints_the_help_on_stdout_and_exits_0() -> None:
    io, rec = recording_io()
    assert await run_command(["--help"], io) == EXIT_OK
    assert "usage: agent-fabric agents" in rec.out


async def test_exits_2_on_a_usage_error_with_the_usage_on_stderr() -> None:
    io, rec = recording_io()
    assert await run_command(["deploy"], io) == EXIT_USAGE
    assert 'agent-fabric: unknown command "deploy"' in rec.err
    assert "usage: agent-fabric agents" in rec.err


async def test_exits_2_without_a_creds_file() -> None:
    io, rec = recording_io({"NATS_URL": "nats://127.0.0.1:1"})
    assert await run_command(["agents"], io) == EXIT_USAGE
    assert "no creds file: pass --creds, or set NATS_CREDS" in rec.err


async def test_exits_2_without_a_url_naming_where_it_comes_from() -> None:
    io, rec = recording_io({"NATS_CREDS": "a.creds"})
    assert await run_command(["agents"], io) == EXIT_USAGE
    assert "the URL the console showed next to your creds file" in rec.err


_TS_CLI = Path(__file__).resolve().parents[2] / "typescript" / "dist" / "cli.js"


@pytest.mark.skipif(
    shutil.which("node") is None or not _TS_CLI.exists(), reason="no node or no TypeScript build"
)
def test_the_help_is_the_typescript_commands() -> None:
    # One command in two packages: a person reads either.
    ts = subprocess.run(
        ["node", str(_TS_CLI), "--help"], capture_output=True, text=True, check=True
    )
    assert ts.stdout == f"{USAGE}\n"


async def test_exits_2_with_one_line_for_a_creds_file_it_cannot_read() -> None:
    io, rec = recording_io({"NATS_URL": "nats://127.0.0.1:1"})
    assert await run_command(["agents", "--creds", "/no/such/typo.creds"], io) == EXIT_USAGE
    assert re.fullmatch(
        r"url nats://127\.0\.0\.1:1\nagent-fabric: creds file /no/such/typo\.creds: [^\n]+\n",
        rec.err,
    )


@dataclass
class _A:
    prompt_subject: str
    description: str = ""
    agent: str = "k"
    identity: None = None
    id_sig_verified: bool = False


def _listing(monkeypatch: pytest.MonkeyPatch, agents: list[_A]) -> None:
    """Replace the caller with one that lists ``agents``."""

    class _Caller:
        async def list(self) -> list[_A]:
            return agents

        async def close(self) -> None:
            pass

    async def fake(**_kwargs: object) -> _Caller:
        return _Caller()

    monkeypatch.setattr(cli, "fabric_caller", fake)


# What each listed agent registered as its description; one registered none.
_AGENTS = [
    _A("agents.prompt.b", "Writes two\tlines.\n\u001b[31mNever more."),
    _A(
        "agents.prompt.a_x",
        "Keeps the logs of the orders server. Ask it what happened in a time range.",
    ),
    _A("agents.prompt.B"),
    _A("agents.prompt.a-x", " \n "),
]
_ENV = {"NATS_CREDS": "a.creds", "NATS_URL": "nats://127.0.0.1:1"}


async def test_lists_agents_by_code_point_the_typescript_commands_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _AGENTS)
    io, rec = recording_io(_ENV)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert [a["address"] for a in json.loads(rec.out)] == [
        "agents.prompt.B",
        "agents.prompt.a-x",
        "agents.prompt.a_x",
        "agents.prompt.b",
    ]


async def test_prints_each_description_under_its_row_after_a_tab_as_one_line_of_plain_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _AGENTS)
    io, rec = recording_io(_ENV)
    assert await run_command(["agents"], io) == EXIT_OK
    assert rec.out == (
        "agents.prompt.B\tk\tagent identity: none\n"
        # No description, or nothing left of one: no line.
        "agents.prompt.a-x\tk\tagent identity: none\n"
        "agents.prompt.a_x\tk\tagent identity: none\n"
        "\tKeeps the logs of the orders server. Ask it what happened in a time range.\n"
        "agents.prompt.b\tk\tagent identity: none\n"
        # A line break, a tab and an escape sequence's control character: spaces.
        "\tWrites two lines. [31mNever more.\n"
    )


async def test_leaves_the_description_as_it_was_registered_in_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _AGENTS)
    io, rec = recording_io(_ENV)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert [a["description"] for a in json.loads(rec.out)] == [
        "",
        " \n ",
        "Keeps the logs of the orders server. Ask it what happened in a time range.",
        "Writes two\tlines.\n\u001b[31mNever more.",
    ]
