"""The command's arguments, help and usage errors, without a server.

The TypeScript suite's ``command.test.ts``.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

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
