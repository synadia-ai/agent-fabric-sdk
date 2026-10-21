"""A ``CommandIO`` for the command's tests: stdout and stderr collected, stdin a list of lines."""

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
    env: Mapping[str, str] | None = None, stdin: Sequence[str] = ()
) -> tuple[CommandIO, Recording]:
    rec = Recording()
    lines = list(stdin)

    async def read_line() -> str | None:
        return lines.pop(0) if lines else None

    io = CommandIO(
        out=rec.stdout.append, err=rec.stderr.append, read_line=read_line, env=dict(env or {})
    )
    return io, rec
