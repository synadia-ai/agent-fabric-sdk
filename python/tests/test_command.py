"""The command's arguments, help and usage errors, without a server.

And the command over a replaced caller: what it prints of the text the agents
registered or sent. The TypeScript suite's ``command.test.ts`` and
``command-root.test.ts``.
"""

from __future__ import annotations

import asyncio
import contextlib
import io as stdio
import json
import logging
import re
import shutil
import subprocess
from collections.abc import AsyncIterator, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from synadia_ai.agents import Agent, Query, ResponseChunk

from synadia_ai.agent_fabric import FabricCallerError, cli, pick_agent
from synadia_ai.agent_fabric.cli import (
    DEFAULT_TIMEOUT_S,
    EXIT_FAILED,
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
    identity: str | None = None
    id_sig_verified: bool = False


@dataclass
class _Ask:
    """A question the agent asks in the middle of its reply."""

    question: str


def _listing(
    monkeypatch: pytest.MonkeyPatch,
    agents: list[_A],
    *,
    target: _A | None = None,
    refusal: str = "refused before it went out",
    served: Sequence[str | _Ask] | None = None,
) -> list[str]:
    """Replace the caller with one that lists ``agents``.

    Its ``find`` returns ``target``, or picks from ``agents`` by the caller's
    own rule and fails as the caller does. Its prompt is refused with
    ``refusal`` at the stream's first step, before any root; or, with
    ``served``, answered with those chunks of a reply, and a question where
    an entry is an ``_Ask``. Returns what the questions were answered.
    """
    answers: list[str] = []

    class _Question(Query):
        async def reply(self, answer: object) -> None:
            answers.append(str(answer))

    class _Caller:
        async def list(self) -> list[_A]:
            return agents

        async def find(self, who: str) -> object:
            return target or pick_agent(cast("Sequence[Agent]", agents), who)

        async def prompt(self, _target: object, _text: str, **_options: object) -> object:
            async def stream() -> AsyncIterator[object]:
                if served is None:
                    raise RuntimeError(refusal)
                for part in served:
                    if isinstance(part, _Ask):
                        yield _Question("q", "r", part.question, None, cast("Any", None))
                    else:
                        yield ResponseChunk(text=part)

            root_id: asyncio.Future[str] = asyncio.get_running_loop().create_future()
            if served is None:
                root_id.cancel()
            else:
                root_id.set_result("0" * 32)
            return SimpleNamespace(stream=stream(), root_id=root_id)

        async def close(self) -> None:
            pass

    async def fake(**_kwargs: object) -> _Caller:
        return _Caller()

    monkeypatch.setattr(cli, "fabric_caller", fake)
    return answers


# Three emoji held together by two zero width joiners, which stay.
_FAMILY = "".join(map(chr, (0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467)))
# What each listed agent registered as its description; one registered none.
_AGENTS = [
    _A("agents.prompt.b", f"Writes two\tlines.\n\u001b[31mNever more. {_FAMILY}"),
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
        # The joiners inside the emoji stay, so it stays one emoji.
        f"\tWrites two lines. [31mNever more. {_FAMILY}\n"
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
        f"Writes two\tlines.\n\u001b[31mNever more. {_FAMILY}",
    ]


async def test_lists_every_agent_when_a_description_holds_half_a_character(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Half a character: a text cut inside an emoji ends in one. Python cannot
    # print it, and the command stopped the list there. Both commands print
    # U+FFFD in its place, and every agent.
    _listing(
        monkeypatch,
        [
            _A("agents.prompt.a", "First."),
            _A("agents.prompt.b", "cut in an emoji " + chr(0xD83D)),
            _A("agents.prompt.c", "Third."),
        ],
    )
    io, rec = recording_io(_ENV)
    assert await run_command(["agents"], io) == EXIT_OK
    assert rec.out == (
        "agents.prompt.a\tk\tagent identity: none\n"
        "\tFirst.\n"
        "agents.prompt.b\tk\tagent identity: none\n"
        f"\tcut in an emoji {chr(0xFFFD)}\n"
        "agents.prompt.c\tk\tagent identity: none\n"
        "\tThird.\n"
    )
    # What a terminal takes: the whole output can be written as UTF-8.
    assert rec.out.encode()


async def test_json_writes_half_a_character_as_its_escape_the_typescript_commands_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # ``--json`` gives the description as it was registered. Half a character
    # cannot be written as UTF-8, so it is written as its JSON escape, which is
    # what JSON.stringify writes: a reader gets the same text back.
    _listing(monkeypatch, [_A("agents.prompt.b", "cut in an emoji " + chr(0xD83D))])
    io, rec = recording_io(_ENV)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert rec.out.encode() == (
        b'[{"address":"agents.prompt.b","kind":"k","identity":null,"verified":false,'
        b'"description":"cut in an emoji \\ud83d"}]\n'
    )
    assert json.loads(rec.out)[0]["description"] == "cut in an emoji " + chr(0xD83D)


# The kind, the address and the identity are text an agent registered too:
# ``metadata.agent`` is as free as the description.
_ESC = chr(0x1B)
_OVERRIDE = chr(0x202E)  # right-to-left override
_HALF = chr(0xDC80)  # half a character
_KIND = f"wri{_ESC}[31mter\tk2"
_RAW_FIELDS = [
    _A(
        "agents.prompt.w\nx",
        "Writes.",
        agent=_KIND,
        identity=f"ACCOUNT{_OVERRIDE}.USER",
        id_sig_verified=True,
    ),
    _A("agents.prompt.z", "Last.", agent=f"half{_HALF}"),
]


async def test_the_rows_own_fields_are_printed_as_plain_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _RAW_FIELDS)
    io, rec = recording_io(_ENV)
    assert await run_command(["agents"], io) == EXIT_OK
    assert rec.out == (
        # The escape character and the tab in the kind, the line break in the
        # address, the override in the identity: a space each, nothing cut.
        "agents.prompt.w x\twri [31mter k2\tagent ACCOUNT .USER, verified\n"
        "\tWrites.\n"
        f"agents.prompt.z\thalf{chr(0xFFFD)}\tagent identity: none\n"
        "\tLast.\n"
    )
    # What a terminal takes: the whole output can be written as UTF-8.
    assert rec.out.encode()


async def test_the_rows_own_fields_are_left_as_they_were_registered_in_json(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _RAW_FIELDS)
    io, rec = recording_io(_ENV)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert json.loads(rec.out) == [
        {
            "address": "agents.prompt.w\nx",
            "kind": _KIND,
            "identity": f"ACCOUNT{_OVERRIDE}.USER",
            "verified": True,
            "description": "Writes.",
        },
        {
            "address": "agents.prompt.z",
            "kind": f"half{_HALF}",
            "identity": None,
            "verified": False,
            "description": "Last.",
        },
    ]


# An address, a kind and an identity are text the agents registered, and a
# refusal's few words are the agent's own. ``prompt`` prints them on stderr,
# which is a terminal more often than not.
_CLEAR = f"{_ESC}[2J"  # the escape sequence that clears the screen
_WRITER = _A("agents.prompt.writer.demo.s", agent="writer")
_THERE = [
    _A(f"agents.prompt.a{_CLEAR}.demo.s"),
    _A("agents.prompt.b\t.demo.s"),
]


async def test_prompt_prints_the_agents_address_and_identity_as_plain_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _A(
        f"agents.prompt.w{_CLEAR}.demo\n.s{_HALF}",
        agent="writer",
        identity=f"ACCOUNT{_OVERRIDE}.USER",
        id_sig_verified=True,
    )
    _listing(monkeypatch, [], target=target)
    io, rec = recording_io(_ENV)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_FAILED
    assert (
        f"→ agents.prompt.w [2J.demo .s{chr(0xFFFD)} (agent ACCOUNT .USER, verified)\n" in rec.err
    )
    assert _ESC not in rec.err


async def test_prompt_prints_a_refusals_words_as_plain_text_on_one_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, [], target=_WRITER, refusal=f"service error 500: no{_CLEAR}\nroot 0123")
    io, rec = recording_io(_ENV)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_FAILED
    assert rec.err == (
        "url nats://127.0.0.1:1\n"
        "→ agents.prompt.writer.demo.s (agent identity: none)\n"
        "agent-fabric: no reply: service error 500: no [2J root 0123\n"
    )


async def test_prompt_prints_every_address_as_plain_text_when_no_agent_is_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _THERE)
    io, rec = recording_io(_ENV)
    assert await run_command(["prompt", "nosuch", "hi"], io) == EXIT_FAILED
    assert rec.err == (
        "url nats://127.0.0.1:1\n"
        'agent-fabric: no agent "nosuch"; there: '
        "agents.prompt.a [2J.demo.s, agents.prompt.b .demo.s\n"
    )


async def test_prompt_prints_every_address_as_plain_text_when_a_kind_names_several(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, _THERE)
    io, rec = recording_io(_ENV)
    assert await run_command(["prompt", "k", "hi"], io) == EXIT_FAILED
    assert rec.err == (
        "url nats://127.0.0.1:1\n"
        'agent-fabric: 2 agents of kind "k": '
        "agents.prompt.a [2J.demo.s, agents.prompt.b .demo.s; name one by its address\n"
    )


def test_the_error_a_program_catches_keeps_the_addresses_as_they_were_registered() -> None:
    with pytest.raises(FabricCallerError) as caught:
        pick_agent(cast("Sequence[Agent]", _THERE), "nosuch")
    assert str(caught.value) == (
        f'no agent "nosuch"; there: agents.prompt.a{_CLEAR}.demo.s, agents.prompt.b\t.demo.s'
    )


# The reply and a question are the agent's own text, over as many lines as it
# wrote. A terminal is sent them as text it only shows; a pipe or a file gets
# them as they came.
_BEL = chr(0x07)
_CSI = chr(0x9B)  # the one-character form of ESC [
_FFFD = chr(0xFFFD)
# Clears the screen, sets the window's title, moves up a line and writes over
# it: what a reply must not do to the terminal it is printed on.
_REPLY = [
    f"one\ttab\nline two {_ESC}[2J{_ESC}]0;title{_BEL}",
    f"{_CSI}1A\rroot 0123 {_OVERRIDE}{_FAMILY}\n",
]
_SHOWN = (
    f"one\ttab\nline two {_FFFD}[2J{_FFFD}]0;title{_FFFD}"
    f"{_FFFD}1A{_FFFD}root 0123 {_FFFD}{_FAMILY}\n"
)
_QUESTION = f"which {_ESC}[31mcolour?\n{_ESC}[1Aroot 0123"
_SERVED = [_REPLY[0], _Ask(_QUESTION), _REPLY[1]]


async def test_on_a_terminal_the_reply_and_a_question_show_u_fffd_for_a_control_or_format_character(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Line breaks, tabs and the joiners stay.
    answers = _listing(monkeypatch, [], target=_WRITER, served=_SERVED)
    io, rec = recording_io(_ENV, ["green"], out_is_terminal=True, err_is_terminal=True)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_OK
    assert rec.out == f"{_SHOWN}\n"
    assert f"? which {_FFFD}[31mcolour?\n{_FFFD}[1Aroot 0123\n" in rec.err
    assert _ESC not in rec.out + rec.err
    # The answer goes to the agent as it was typed.
    assert answers == ["green"]


async def test_the_reply_and_a_question_are_written_as_they_came_when_the_output_is_not_a_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, [], target=_WRITER, served=_SERVED)
    io, rec = recording_io(_ENV, ["green"])
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_OK
    assert rec.out == f"{''.join(_REPLY)}\n"
    assert f"? {_QUESTION}\n" in rec.err


async def test_each_output_is_decided_alone_a_reply_piped_from_a_terminal_is_the_exact_reply(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, [], target=_WRITER, served=_SERVED)
    io, rec = recording_io(_ENV, ["green"], err_is_terminal=True)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_OK
    assert rec.out == f"{''.join(_REPLY)}\n"
    assert f"? which {_FFFD}[31mcolour?\n{_FFFD}[1Aroot 0123\n" in rec.err


async def test_json_is_left_as_it_is_on_a_terminal_too_the_text_as_it_came(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, [], target=_WRITER, served=_SERVED)
    io, rec = recording_io(_ENV, ["green"], out_is_terminal=True, err_is_terminal=True)
    assert await run_command(["prompt", "writer", "hi", "--json"], io) == EXIT_OK
    assert json.loads(rec.out) == {"root": "0" * 32, "text": "".join(_REPLY), "references": []}


# A reply cut inside an emoji: its two chunks each hold half a character, which
# cannot be written as UTF-8. The command stopped there with nothing printed.
# Both commands write U+FFFD for each half, and the whole reply in --json,
# where the halves are one character again.
_CUT = [f"thumbs {chr(0xD83D)}", f"{chr(0xDC4D)} up", _Ask(f"which {chr(0xD83D)}?")]


@pytest.mark.parametrize("terminal", [False, True], ids=["a pipe or a file", "a terminal"])
async def test_a_reply_that_arrives_cut_inside_an_emoji_is_printed_with_u_fffd_for_each_half(
    monkeypatch: pytest.MonkeyPatch, terminal: bool
) -> None:
    _listing(monkeypatch, [], target=_WRITER, served=_CUT)
    io, rec = recording_io(_ENV, [], out_is_terminal=terminal, err_is_terminal=terminal)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_OK
    assert rec.out == f"thumbs {_FFFD}{_FFFD} up\n"
    assert f"? which {_FFFD}?\n" in rec.err
    # What a stream that writes UTF-8 takes.
    assert (rec.out + rec.err).encode()


async def test_json_gives_a_reply_cut_inside_an_emoji_whole_the_typescript_commands_bytes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, [], target=_WRITER, served=_CUT)
    io, rec = recording_io(_ENV)
    assert await run_command(["prompt", "writer", "hi", "--json"], io) == EXIT_OK
    assert rec.out.encode() == (
        f'{{"root":"{"0" * 32}","text":"thumbs {chr(0x1F44D)} up","references":[]}}\n'.encode()
    )


# A stdout that is not UTF-8, a terminal set to Latin-1, cannot hold every
# character an agent registered or replied: U+FFFD among them, which the list
# prints for half a character. Python's stdout stops at the first such
# character. ``main`` has both outputs write ``?`` in its place.
def _latin_1(errors: str) -> tuple[stdio.TextIOWrapper, stdio.BytesIO]:
    raw = stdio.BytesIO()
    return stdio.TextIOWrapper(raw, encoding="iso8859-1", errors=errors), raw


def test_main_has_a_stream_that_would_stop_replace_what_it_cannot_encode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    out, raw_out = _latin_1("strict")
    err, raw_err = _latin_1("backslashreplace")
    monkeypatch.setattr(cli.sys, "stdout", out)
    monkeypatch.setattr(cli.sys, "stderr", err)
    assert cli.main(["--help"]) == EXIT_OK
    # A stream that stopped replaces; one that already wrote something in the
    # character's place, as stderr does, is left as it is.
    assert (out.errors, err.errors) == ("replace", "backslashreplace")
    out.write(f"caf\u00e9 \u2192 {_FFFD}\n")
    out.flush()
    assert raw_out.getvalue().endswith(b"caf\xe9 ? ?\n")
    assert raw_err.getvalue() == b""


def test_main_leaves_a_stream_it_cannot_tell_as_it_is(monkeypatch: pytest.MonkeyPatch) -> None:
    out = stdio.StringIO()  # not a text file over bytes: nothing to encode
    monkeypatch.setattr(cli.sys, "stdout", out)
    assert cli.main(["--help"]) == EXIT_OK
    assert out.getvalue() == f"{USAGE}\n"


# Under ``replace`` such a stdout writes ``?`` for a character it cannot hold,
# in ``--json`` too: valid JSON that is not the text. So ``--json`` is written
# in ASCII for it, every other character as its JSON escape.
_ACCENTS = f"caf\u00e9 \u2192 {chr(0x1F44D)}"


async def test_json_lists_in_ascii_for_a_stdout_that_is_not_utf8(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    description = f"{_ACCENTS} cut {chr(0xD83D)}"
    _listing(monkeypatch, [_A("agents.prompt.b", description, agent="caf\u00e9")])
    io, rec = recording_io(_ENV, out_is_utf8=False)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert rec.out == (
        '[{"address":"agents.prompt.b","kind":"caf\\u00e9","identity":null,"verified":false,'
        '"description":"caf\\u00e9 \\u2192 \\ud83d\\udc4d cut \\ud83d"}]\n'
    )
    # What any encoding can hold, and the text as it was registered.
    assert rec.out.isascii()
    assert json.loads(rec.out)[0]["description"] == description


async def test_json_gives_the_reply_in_ascii_for_a_stdout_that_is_not_utf8(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _listing(monkeypatch, [], target=_WRITER, served=[_ACCENTS[:5], _ACCENTS[5:]])
    io, rec = recording_io(_ENV, out_is_utf8=False)
    assert await run_command(["prompt", "writer", "hi", "--json"], io) == EXIT_OK
    assert rec.out == (
        f'{{"root":"{"0" * 32}","text":"caf\\u00e9 \\u2192 \\ud83d\\udc4d","references":[]}}\n'
    )
    assert json.loads(rec.out)["text"] == _ACCENTS


async def test_without_json_the_reply_is_written_as_it_came_for_a_stdout_that_is_not_utf8(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The stream itself writes ``?`` where its encoding cannot hold a character.
    _listing(monkeypatch, [], target=_WRITER, served=[_ACCENTS])
    io, rec = recording_io(_ENV, out_is_utf8=False)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_OK
    assert rec.out == f"{_ACCENTS}\n"


@pytest.mark.parametrize(
    ("encoding", "utf8"),
    [("utf-8", True), ("UTF8", True), ("iso8859-1", False), ("ascii", False), ("cp1252", False)],
)
def test_main_tells_the_command_whether_stdout_writes_utf8(
    monkeypatch: pytest.MonkeyPatch, encoding: str, utf8: bool
) -> None:
    told: list[bool] = []

    async def run(_argv: Sequence[str], io: cli.CommandIO) -> int:
        told.append(io.out_is_utf8)
        return EXIT_OK

    monkeypatch.setattr(cli, "run_command", run)
    monkeypatch.setattr(cli.sys, "stdout", stdio.TextIOWrapper(stdio.BytesIO(), encoding=encoding))
    assert cli.main(["agents"]) == EXIT_OK
    # A stream that is not a text file over bytes has nothing to encode.
    monkeypatch.setattr(cli.sys, "stdout", stdio.StringIO())
    assert cli.main(["agents"]) == EXIT_OK
    assert told == [utf8, True]


# A program that calls ``main`` may have replaced a stream with one that can
# only be written to. It cannot say whether it is a terminal, so it is none:
# the TypeScript command's ``isTTY === true``.
class _Bare:
    def __init__(self) -> None:
        self.written: list[str] = []

    def write(self, text: str) -> None:
        self.written.append(text)

    def flush(self) -> None:
        pass


class _Terminal(_Bare):
    def isatty(self) -> bool:
        return True


@pytest.mark.parametrize(
    ("out", "err", "terminals"),
    [
        (_Bare(), _Bare(), (False, False)),
        (_Terminal(), _Bare(), (True, False)),
        (_Bare(), _Terminal(), (False, True)),
    ],
    ids=["neither can say", "stdout a terminal", "stderr a terminal"],
)
def test_main_takes_a_stream_that_cannot_say_whether_it_is_a_terminal_for_none(
    monkeypatch: pytest.MonkeyPatch, out: _Bare, err: _Bare, terminals: tuple[bool, bool]
) -> None:
    told: list[tuple[bool, bool]] = []

    async def run(_argv: Sequence[str], io: cli.CommandIO) -> int:
        told.append((io.out_is_terminal, io.err_is_terminal))
        io.out("written\n")
        return EXIT_OK

    monkeypatch.setattr(cli, "run_command", run)
    monkeypatch.setattr(cli.sys, "stdout", out)
    monkeypatch.setattr(cli.sys, "stderr", err)
    assert cli.main(["agents"]) == EXIT_OK
    assert told == [terminals]
    assert out.written[-1] == "written\n"


# A program that set up no logging has Python write a log record to stderr as
# it is. The protocol SDK's client logs what an agent sent, the words of a
# refusal among it. ``main`` has every record written as one line of plain
# text, and leaves the protocol SDK's warnings out, as the TypeScript command
# does.
@contextlib.contextmanager
def _no_logging_set_up() -> Iterator[logging.Logger]:
    """The root logger without a handler, as a program that set up no logging
    has it. pytest hangs its own on it while a test runs: they are put back."""
    root = logging.getLogger()
    theirs = root.handlers[:]
    for handler in theirs:
        root.removeHandler(handler)
    try:
        yield root
    finally:
        for handler in root.handlers[:]:
            root.removeHandler(handler)
        for handler in theirs:
            root.addHandler(handler)


async def _logs(_argv: Sequence[str], _io: cli.CommandIO) -> int:
    """In the command's place: what a library and the two SDKs may log while it runs."""
    logging.getLogger("some.library").warning("a\x1b[2J\n%s", "b")
    logging.getLogger("synadia_ai.agent_fabric").warning("nats: %s", "no\x1b[31m route")
    sdk = logging.getLogger("synadia_ai.agents.agent")
    sdk.warning("service error on %s: code=%s desc=%s", "_INBOX.x", "500", "no\x1b[2J way")
    sdk.error("mux: route message hook failed (subject=%s)", "agents.\x1b[2J")
    logging.getLogger("synadia_ai.agents").warning("the same family")
    logging.getLogger("synadia_ai.agent_service").warning("another package")
    return EXIT_OK


def test_main_prints_a_log_record_as_one_line_of_plain_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    err = stdio.StringIO()
    monkeypatch.setattr(cli.sys, "stderr", err)
    monkeypatch.setattr(cli, "run_command", _logs)
    with _no_logging_set_up():
        assert cli.main(["agents"]) == EXIT_OK
    # No escape character and no line break of a record's own. The protocol
    # SDK's two warnings are not there; its error is.
    assert err.getvalue() == (
        "a [2J b\n"
        "nats: no [31m route\n"
        "mux: route message hook failed (subject=agents. [2J)\n"
        "another package\n"
    )


def test_main_leaves_the_logging_a_program_set_up_as_it_is(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    err = stdio.StringIO()
    monkeypatch.setattr(cli.sys, "stderr", err)
    monkeypatch.setattr(cli, "run_command", _logs)
    seen: list[str] = []

    class Mine(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            seen.append(record.getMessage())

    mine = Mine()
    with _no_logging_set_up() as root:
        root.addHandler(mine)
        assert cli.main(["agents"]) == EXIT_OK
        assert root.handlers == [mine]
    # Every record went to the program's own handler, as it was logged.
    assert len(seen) == 6 and seen[0] == "a\x1b[2J\nb"
    assert err.getvalue() == ""
