"""A ``CommandIO`` for the command's tests: stdout and stderr collected, stdin a list of lines.

Neither output is a terminal, and stdout writes UTF-8, unless the test says
otherwise.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from synadia_ai.agent_fabric.cli import CommandIO


@dataclass
class Recording:
    stdout: list[str] = field(default_factory=list)
    stderr: list[str] = field(default_factory=list)

    @property
    def out(self) -> str:
        return "".join(self.stdout)

    @property
    def err(self) -> str:
        return "".join(self.stderr)


def recording_io(
    env: Mapping[str, str] | None = None,
    stdin: Sequence[str] = (),
    *,
    out_is_terminal: bool = False,
    err_is_terminal: bool = False,
    out_is_utf8: bool = True,
) -> tuple[CommandIO, Recording]:
    rec = Recording()
    lines = list(stdin)

    async def read_line() -> str | None:
        return lines.pop(0) if lines else None

    io = CommandIO(
        out=rec.stdout.append,
        err=rec.stderr.append,
        read_line=read_line,
        env=dict(env or {}),
        out_is_terminal=out_is_terminal,
        err_is_terminal=err_is_terminal,
        out_is_utf8=out_is_utf8,
    )
    return io, rec
