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
import sys
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from synadia_ai.agents import Agent, Query, ResponseChunk

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
file the console gave you. The reply streams to stdout; the server's URL,
the agent, the task's root id and a ScratchPad reference go to stderr. A
question the agent asks is printed on stderr and answered from stdin.

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
        io.err(f"agent-fabric: {err}\n")
        return EXIT_FAILED
    except Exception as err:
        # The agent refused the prompt or failed while serving it. The
        # protocol carries a code and a few words; the reason is in the
        # agent's own output.
        io.err(f"agent-fabric: no reply: {err}\n")
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


def _json(value: object) -> str:
    # The TypeScript command's bytes: no spaces, non-ASCII as it is.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


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
        io.out(f"{line['address']}\t{line['kind']}\t{_describe_identity(line)}\n")
    return EXIT_OK


async def _prompt(
    caller: FabricCaller, who: str, text: str, parsed: ParsedCommand, io: CommandIO
) -> int:
    target = await caller.find(who)
    io.err(f"→ {target.prompt_subject} ({_describe_identity(_agent_line(target))})\n")
    started = await caller.prompt(target, text, max_wait_s=parsed.timeout_s)

    def print_root(f: asyncio.Future[str]) -> None:
        if not f.cancelled() and f.exception() is None:
            io.err(f"root {f.result()}\n")

    started.root_id.add_done_callback(print_root)
    reply: list[str] = []
    async for msg in started.stream:
        if isinstance(msg, ResponseChunk):
            reply.append(msg.text)
            if not parsed.json:
                io.out(msg.text)
        elif isinstance(msg, Query):
            io.err(f"? {msg.prompt}\n")
            answer = await io.read_line()
            await msg.reply(answer if answer and answer.strip() else CANNOT_ANSWER)
    root = await started.root_id
    whole = "".join(reply)
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


def main(argv: Sequence[str] | None = None) -> int:
    """The console script: run the command on the process's own streams."""
    io = CommandIO(
        out=_write(sys.stdout),
        err=_write(sys.stderr),
        read_line=_read_stdin_line,
        env=os.environ,
    )
    return asyncio.run(run_command(sys.argv[1:] if argv is None else argv, io))


if __name__ == "__main__":
    raise SystemExit(main())
