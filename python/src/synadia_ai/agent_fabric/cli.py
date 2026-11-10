"""The ``agent-fabric`` command: list the agents and prompt one.

With the creds file the console gave you and nothing else. :func:`main` runs
it on the process's own streams; the tests call :func:`run_command` with
their own. Mirrors ``typescript/src/command.ts``: the same subcommands,
flags, lines and exit codes.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import re
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from synadia_ai.agents import Agent, Query, ResponseChunk

from ._description import clean_description, plain_line, terminal_text, well_formed
from .caller import (
    CANNOT_ANSWER,
    NATS_CREDS_VAR,
    NATS_URL_VAR,
    FabricCaller,
    FabricCallerError,
    fabric_caller,
)
from .scratchpad import find_references

#: Success.
EXIT_OK = 0
#: No such agent, a refused or failed prompt, or no connection.
EXIT_FAILED = 1
#: A usage error: a wrong argument, or no creds file or URL.
EXIT_USAGE = 2

#: How long ``prompt`` waits for the whole reply, by default, in seconds.
DEFAULT_TIMEOUT_S = 600.0

USAGE = f"""usage: agent-fabric agents [options]
       agent-fabric prompt <address or kind> "<text>" [options]

List the agents on the Synadia Agent Fabric, or prompt one, with the creds
file the console gave you. The list has one row per agent: its address, its
kind and its identity. Under a row, after a tab, comes the agent's
description, what it says it does, when it has one. The reply streams to
stdout; the server's URL, the agent, the task's root id and a ScratchPad
reference go to stderr. A question the agent asks is printed on stderr and
answered from stdin.

options:
  --creds <file>    the creds file (default: ${NATS_CREDS_VAR})
  --url <url>       the URL the console showed next to your creds file
                    (default: ${NATS_URL_VAR})
  --timeout <s>     how long to wait for the whole reply, in seconds
                    (default: {DEFAULT_TIMEOUT_S:g})
  --json            one JSON object on stdout instead of the stream
  -h, --help        this help
  --                the rest is the text, even what starts with -

exit codes: 0 done, 1 no such agent or a refused prompt, 2 usage"""


@dataclass(frozen=True, slots=True)
class CommandIO:
    """Where the command reads and writes: the process's own in :func:`main`."""

    out: Callable[[str], None]
    err: Callable[[str], None]
    #: One line from stdin, without its newline; ``None`` at its end.
    read_line: Callable[[], Awaitable[str | None]]
    env: Mapping[str, str] = field(default_factory=dict)
    #: Whether stdout is a terminal. A pipe or a file is not.
    out_is_terminal: bool = False
    #: Whether stderr is a terminal.
    err_is_terminal: bool = False


@dataclass(frozen=True, slots=True)
class ParsedCommand:
    """A parsed command line. ``message`` is set for ``kind == "usage"``."""

    kind: Literal["help", "usage", "agents", "prompt"]
    message: str = ""
    who: str | None = None
    text: str | None = None
    creds: str | None = None
    url: str | None = None
    timeout_s: float = DEFAULT_TIMEOUT_S
    json: bool = False


def _split_flag(arg: str) -> tuple[str, str | None]:
    if not arg.startswith("--") or "=" not in arg:
        return arg, None
    flag, value = arg.split("=", 1)
    return flag, value


def _usage(message: str) -> ParsedCommand:
    return ParsedCommand(kind="usage", message=message)


def parse_command(argv: Sequence[str]) -> ParsedCommand:  # noqa: PLR0911, PLR0912
    """Parse the arguments after the command's name."""
    positional: list[str] = []
    values: dict[str, str] = {}
    timeout_s = DEFAULT_TIMEOUT_S
    as_json = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--":
            # Everything after it is the text, even what looks like an option.
            positional.extend(argv[i + 1 :])
            break
        flag, inline = _split_flag(arg)
        if flag in ("-h", "--help"):
            return ParsedCommand(kind="help")
        if flag == "--json":
            as_json = True
        elif flag in ("--creds", "--url", "--timeout"):
            if inline is None:
                i += 1
                inline = argv[i] if i < len(argv) else None
            if not inline:
                return _usage(f"{flag} needs a value")
            if flag == "--timeout":
                try:
                    timeout_s = float(inline)
                except ValueError:
                    timeout_s = -1.0
                if not math.isfinite(timeout_s) or timeout_s <= 0:
                    return _usage(f'--timeout must be a positive number of seconds, not "{inline}"')
            else:
                values[flag] = inline
        elif arg.startswith("-") and arg != "-":
            return _usage(f"unknown option {arg}")
        else:
            positional.append(arg)
        i += 1

    common = {
        "creds": values.get("--creds"),
        "url": values.get("--url"),
        "timeout_s": timeout_s,
        "json": as_json,
    }
    if not positional:
        return _usage("name a command: agents or prompt")
    sub, rest = positional[0], positional[1:]
    if sub == "help":
        return ParsedCommand(kind="help")
    if sub == "agents":
        if rest:
            return _usage(f'agents takes no arguments, not "{" ".join(rest)}"')
        return ParsedCommand(kind="agents", **common)  # type: ignore[arg-type]
    if sub == "prompt":
        text = " ".join(rest[1:])
        if not rest or not text:
            return _usage('prompt needs an agent and a text: prompt <address or kind> "<text>"')
        return ParsedCommand(kind="prompt", who=rest[0], text=text, **common)  # type: ignore[arg-type]
    return _usage(f'unknown command "{sub}"')


async def run_command(argv: Sequence[str], io: CommandIO) -> int:  # noqa: PLR0911
    """Run the command; return its exit code."""
    parsed = parse_command(argv)
    if parsed.kind == "help":
        io.out(f"{USAGE}\n")
        return EXIT_OK
    if parsed.kind == "usage":
        io.err(f"agent-fabric: {parsed.message}\n\n{USAGE}\n")
        return EXIT_USAGE
    creds = parsed.creds or io.env.get(NATS_CREDS_VAR, "")
    url = parsed.url or io.env.get(NATS_URL_VAR, "")
    if not creds:
        io.err(f"agent-fabric: no creds file: pass --creds, or set {NATS_CREDS_VAR}\n")
        return EXIT_USAGE
    if not url:
        io.err(
            f"agent-fabric: no server URL: pass --url, or set {NATS_URL_VAR} "
            "to the URL the console showed next to your creds file\n"
        )
        return EXIT_USAGE

    io.err(f"url {url}\n")
    try:
        caller = await fabric_caller(creds=creds, url=url, name="agent-fabric")
    except FabricCallerError as err:
        io.err(f"agent-fabric: {err}\n")
        return EXIT_USAGE if err.reason == "config" else EXIT_FAILED
    try:
        if parsed.kind == "agents":
            return await _list_agents(caller, parsed.json, io)
        assert parsed.who is not None and parsed.text is not None
        return await _prompt(caller, parsed.who, parsed.text, parsed, io)
    except FabricCallerError as err:
        # The message names the agents that are there by their addresses,
        # text they registered: printed as plain text, on one line. The error
        # itself keeps it as it is.
        io.err(f"agent-fabric: {plain_line(str(err))}\n")
        return EXIT_FAILED
    except Exception as err:
        # The agent refused the prompt or failed while serving it. The
        # protocol carries a code and a few words; the reason is in the
        # agent's own output. The words are the agent's: plain text too.
        io.err(f"agent-fabric: no reply: {plain_line(str(err))}\n")
        return EXIT_FAILED
    finally:
        await caller.close()


def _agent_line(a: Agent) -> dict[str, object]:
    return {
        "address": a.prompt_subject,
        "kind": a.agent,
        "identity": str(a.identity) if a.identity is not None else None,
        "verified": a.id_sig_verified,
        "description": a.description,
    }


def _describe_identity(line: Mapping[str, object]) -> str:
    # The agent's own registered identity, from discovery: not the prompt's
    # signature, which every prompt carries.
    if line["identity"] is None:
        return "agent identity: none"
    if line["verified"]:
        return f"agent {line['identity']}, verified"
    return f"agent {line['identity']}"


# Half a character: a surrogate, which in a Python string is never part of a pair.
_HALF = re.compile(f"[{chr(0xD800)}-{chr(0xDFFF)}]")


def _json(value: object) -> str:
    # The TypeScript command's bytes: no spaces, non-ASCII as it is. Half a
    # character is written as its escape, as JSON.stringify writes it: the
    # reader gets the same text back, and Python cannot write it otherwise.
    text = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return _HALF.sub(lambda half: f"\\u{ord(half.group()):04x}", text)


async def _list_agents(caller: FabricCaller, as_json: bool, io: CommandIO) -> int:
    lines: dict[str, dict[str, object]] = {}
    for a in await caller.list():
        lines.setdefault(a.prompt_subject, _agent_line(a))
    ordered = [lines[k] for k in sorted(lines)]
    if as_json:
        io.out(f"{_json(ordered)}\n")
        return EXIT_OK
    if not ordered:
        io.err("no agents\n")
    for line in ordered:
        # Every field is text an agent registered, the kind as free as the
        # description: each is printed as plain text, so a control character in
        # one neither reaches the terminal nor adds a column or a row.
        row = (line["address"], line["kind"], _describe_identity(line))
        io.out("\t".join(plain_line(str(field)) for field in row) + "\n")
        # What the agent says it does, under its row: one line of plain text,
        # whatever was registered (``_description.py``). ``--json`` has it as it is.
        description = clean_description(str(line["description"]))
        if description:
            io.out(f"\t{description}\n")
    return EXIT_OK


async def _prompt(
    caller: FabricCaller, who: str, text: str, parsed: ParsedCommand, io: CommandIO
) -> int:
    target = await caller.find(who)
    # The address and the identity are text the agent registered: plain text
    # on the terminal, as in the list.
    identity = plain_line(_describe_identity(_agent_line(target)))
    io.err(f"→ {plain_line(target.prompt_subject)} ({identity})\n")
    started = await caller.prompt(target, text, max_wait_s=parsed.timeout_s)

    def print_root(f: asyncio.Future[str]) -> None:
        if not f.cancelled() and f.exception() is None:
            io.err(f"root {f.result()}\n")

    started.root_id.add_done_callback(print_root)

    # The reply and a question are the agent's own text. A terminal is sent
    # them as text it only shows (``terminal_text``), so no escape sequence in
    # them clears the screen or writes over a line. A pipe or a file gets them
    # as they came: a script reads the exact reply. Half a character, which a
    # reply cut inside an emoji ends in, cannot be written as UTF-8 either
    # way: U+FFFD is written in its place.
    def to_out(text: str) -> str:
        return terminal_text(text) if io.out_is_terminal else well_formed(text)

    def to_err(text: str) -> str:
        return terminal_text(text) if io.err_is_terminal else well_formed(text)

    reply: list[str] = []
    async for msg in started.stream:
        if isinstance(msg, ResponseChunk):
            reply.append(msg.text)
            if not parsed.json:
                io.out(to_out(msg.text))
        elif isinstance(msg, Query):
            io.err(f"? {to_err(msg.prompt)}\n")
            answer = await io.read_line()
            await msg.reply(answer if answer and answer.strip() else CANNOT_ANSWER)
    root = await started.root_id
    # The whole reply as one text. Two halves of a character that came in two
    # chunks are that character again, as a JavaScript string joins them.
    whole = "".join(reply).encode("utf-16", "surrogatepass").decode("utf-16", "surrogatepass")
    references = find_references(whole)
    if parsed.json:
        io.out(f"{_json({'root': root, 'text': whole, 'references': references})}\n")
    else:
        io.out("\n")
    if references:
        io.err(f"reference: {references[-1]}\n")
    return EXIT_OK


async def _read_stdin_line() -> str | None:
    line = await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline)
    return line.rstrip("\r\n") if line else None


def _write(stream: object) -> Callable[[str], None]:
    def write(text: str) -> None:
        stream.write(text)  # type: ignore[attr-defined]
        stream.flush()  # type: ignore[attr-defined]

    return write


# The error handlers under which a stream writes something in the place of a
# character its encoding cannot hold. Under any other it stops with an error.
_NEVER_STOPS = frozenset(
    {"replace", "backslashreplace", "xmlcharrefreplace", "namereplace", "ignore"}
)


def _never_stopping(stream: object) -> None:
    """Have ``stream`` replace what its encoding cannot hold instead of raising.

    A terminal that is not UTF-8 cannot show every character an agent
    registered or replied, and Python's stdout stops at the first one. It
    writes ``?`` there now, and the rest of the output with it. A stream that
    cannot be told (it is not a text file) is left as it is.
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if callable(reconfigure) and getattr(stream, "errors", None) not in _NEVER_STOPS:
        reconfigure(errors="replace")


def main(argv: Sequence[str] | None = None) -> int:
    """The console script: run the command on the process's own streams."""
    _never_stopping(sys.stdout)
    _never_stopping(sys.stderr)
    io = CommandIO(
        out=_write(sys.stdout),
        err=_write(sys.stderr),
        read_line=_read_stdin_line,
        env=os.environ,
        out_is_terminal=sys.stdout.isatty(),
        err_is_terminal=sys.stderr.isatty(),
    )
    return asyncio.run(run_command(sys.argv[1:] if argv is None else argv, io))


if __name__ == "__main__":
    raise SystemExit(main())
