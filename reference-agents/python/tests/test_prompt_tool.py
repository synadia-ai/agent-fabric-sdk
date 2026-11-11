"""The prompt tools as a person runs them: ``python -m fabric_agent.prompt`` and
the TypeScript agent's ``src/prompt.ts``, each as a program, on a throwaway
nats-server in operator mode.

What they print is another program's text: the address an agent registered,
the words it refuses a prompt with, its reply. Two agents hold escape
sequences in all three. Neither tool sends one to a terminal, the two print
the same lines, and a reply that goes to a pipe is written as it came. The
TypeScript tool is skipped when its dependencies are not installed.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import nats
import pytest
from synadia_ai.agent_service import AgentService

from fabric_agent.description import plain_line, terminal_text, well_formed
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path

AGENT_DIR = Path(__file__).resolve().parents[1]
TS_DIR = AGENT_DIR.parent / "typescript"
IDENTITY = Path(__file__).resolve().parents[3] / "test-fixtures" / "identity" / "operator"
binary = nats_server_on_path()
node = shutil.which("node")
ts_ready = (TS_DIR / "node_modules" / "tsx").is_dir()

ESC = b"\x1b"
FFFD = chr(0xFFFD)
# What the painter replies: it clears the screen and moves up a line.
PAINT_REPLY = "\x1b[2Jcleared\tthe\nscreen \x1b[1A"
# The refuser's address, as it registered it, and the words it refuses with.
REFUSER_ADDRESS = "agents.prompt.re\x1b[2Jfuser.fabric.raw"
REFUSAL = "no\x1b[2J way"
# A zero width space and a right-to-left override: invisible, and not kept.
INVISIBLE = chr(0x200B) + chr(0x202E)
# What stays as it is: an accented letter, the zero width non-joiner and joiner, an emoji.
KEPT = "caf" + chr(0xE9) + " " + chr(0x200C) + chr(0x200D) + " " + chr(0x1F44D)
HALF = chr(0xD83D)
# How long a tool may run, in seconds.
LIMIT_S = 60.0

needs_a_server = pytest.mark.skipif(binary is None, reason="needs nats-server on PATH")
needs_a_terminal = pytest.mark.skipif(sys.platform == "win32", reason="needs a pseudo-terminal")


def test_plain_line_is_one_line_without_a_control_character() -> None:
    assert plain_line("no\x1b[2J way\r\nat\tall " + INVISIBLE + HALF) == f"no [2J way  at all   {FFFD}"
    # The joiners stay, and so does every printable character.
    assert plain_line(KEPT) == KEPT


def test_terminal_text_keeps_the_lines_and_shows_u_fffd_for_a_control_character() -> None:
    assert terminal_text(PAINT_REPLY) == f"{FFFD}[2Jcleared\tthe\nscreen {FFFD}[1A"
    assert terminal_text("a\r\nb " + INVISIBLE + HALF) == f"a{FFFD}\nb {FFFD}{FFFD}{FFFD}"
    assert terminal_text(KEPT) == KEPT


def test_well_formed_changes_half_a_character_only() -> None:
    assert well_formed(PAINT_REPLY + HALF) == PAINT_REPLY + FFFD


@dataclass
class World:
    url: str
    env_file: Path

    def tools(self) -> list[tuple[str, ...]]:
        """The two tools as their READMEs run them; the TypeScript one when it is installed."""
        python = (sys.executable, "-m", "fabric_agent.prompt", str(self.env_file))
        typescript = (node or "node", "--import", "tsx", "src/prompt.ts")
        return [python, typescript] if node is not None and ts_ready else [python]

    def _run_in(self, tool: tuple[str, ...]) -> tuple[Path, dict[str, str]]:
        # The environment wins over an env file, in both tools: nothing of the
        # developer's own shell or `.env` reaches the run.
        env = {**os.environ, "NATS_URL": self.url, "NATS_CREDS": str(IDENTITY / "erin.creds"), "PROMPT_TIMEOUT_MS": "10000"}
        return (AGENT_DIR if tool[0] == sys.executable else TS_DIR), env

    async def run(self, tool: tuple[str, ...], *args: str) -> tuple[int | None, bytes, bytes]:
        """Run a tool with pipes for its outputs: its exit code, stdout and stderr."""
        cwd, env = self._run_in(tool)
        pipe = asyncio.subprocess.PIPE
        proc = await asyncio.create_subprocess_exec(*tool, *args, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL, stdout=pipe, stderr=pipe)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), LIMIT_S)
        except TimeoutError:
            proc.kill()
            raise
        return proc.returncode, out, err

    async def run_on_terminal(self, tool: tuple[str, ...], *args: str, terminal: Literal["stdout", "stderr"]) -> tuple[int | None, bytes]:
        """Run a tool with a terminal as one of its two outputs: its exit code
        and what the terminal was sent."""
        import pty  # noqa: PLC0415 — not on Windows
        import tty  # noqa: PLC0415

        cwd, env = self._run_in(tool)
        master, slave = pty.openpty()
        try:
            # As the tool wrote it: no line break turned into two characters.
            tty.setraw(slave)
            devnull = asyncio.subprocess.DEVNULL
            proc = await asyncio.create_subprocess_exec(
                *tool, *args, cwd=cwd, env=env, stdin=devnull,
                stdout=slave if terminal == "stdout" else devnull,
                stderr=slave if terminal == "stderr" else devnull,
            )  # fmt: skip
        finally:
            os.close(slave)

        def sent() -> bytes:
            parts: list[bytes] = []
            while True:
                try:
                    part = os.read(master, 4096)
                except OSError:  # how Linux ends a terminal's output
                    break
                if not part:
                    break
                parts.append(part)
            return b"".join(parts)

        try:
            shown = asyncio.get_running_loop().run_in_executor(None, sent)
            try:
                await asyncio.wait_for(proc.wait(), LIMIT_S)
            except TimeoutError:
                proc.kill()
                raise
            return proc.returncode, await shown
        finally:
            os.close(master)


@pytest.fixture
async def world(tmp_path: Path) -> AsyncIterator[World]:
    server = LocalNatsServer.start_with_config(binary, IDENTITY / "operator.conf")  # type: ignore[arg-type]
    alice: Any = None
    painter: AgentService | None = None
    try:
        alice = await nats.connect(server.url, user_credentials=str(IDENTITY / "alice.creds"))
        # The painter, on the protocol SDK's host: its reply holds escape sequences.
        painter = AgentService(
            nc=alice, agent="painter", owner="test", session_name="main", description="paints",
            heartbeat_interval_s=3600, keepalive_interval_s=None,
        )  # fmt: skip

        async def paint(_envelope: Any, stream: Any) -> None:
            await stream.send(PAINT_REPLY)

        painter.on_prompt(paint)
        await painter.start()

        # The refuser, a program that speaks NATS: it answers discovery itself,
        # with an address the host would not register, and refuses every
        # prompt with words of its own.
        info = json.dumps(
            {
                "type": "io.nats.micro.v1.info_response", "name": "agents", "id": "raw1", "version": "0.0.1", "description": "",
                "metadata": {"agent": "refuser", "owner": "test", "protocol_version": "0.3"},
                "endpoints": [{"name": "prompt", "subject": REFUSER_ADDRESS, "queue_group": "agents", "metadata": {}}],
            }
        ).encode()  # fmt: skip

        async def describe(msg: Any) -> None:
            await msg.respond(info)

        async def refuse(msg: Any) -> None:
            await alice.publish(msg.reply, b"", headers={"Nats-Service-Error-Code": "500", "Nats-Service-Error": REFUSAL})

        await alice.subscribe("$SRV.INFO.agents", cb=describe)
        await alice.subscribe(REFUSER_ADDRESS, cb=refuse)
        await alice.flush()

        env_file = tmp_path / "caller.env"
        env_file.write_text(f"NATS_URL={server.url}\nNATS_CREDS={IDENTITY / 'erin.creds'}\n", encoding="utf-8")
        yield World(server.url, env_file)
    finally:
        if painter is not None:
            await painter.stop()
        if alice is not None:
            await alice.close()
        server.stop()


def _lines(err: bytes) -> list[bytes]:
    """stderr's lines, without the two that differ from run to run: the root id and the time taken."""
    return [line for line in err.splitlines() if not re.fullmatch(rb"root [0-9a-f]{32}|\d+\.\d s", line)]


@needs_a_server
async def test_an_address_and_a_refusal_are_printed_as_plain_text_the_same_by_both_tools(world: World) -> None:
    for tool in world.tools():
        code, out, err = await world.run(tool, "refuser", "hi")
        assert (code, out) == (1, b"")
        assert ESC not in err
        # The address on the line that says who is prompted, and the refusal's
        # words once, after `no reply:`. Nothing else: no log line of the SDK's.
        assert _lines(err) == [
            "→ agents.prompt.re [2Jfuser.fabric.raw (agent identity: none)".encode(),
            b"",
            b"no reply: service error 500: no [2J way; the agent's own output says why",
        ]
        # No agent of that kind: the error names every address that is there.
        code, out, err = await world.run(tool, "nosuch", "hi")
        assert (code, out) == (1, b"")
        assert ESC not in err
        assert b"agents.prompt.re [2Jfuser.fabric.raw" in err and b"agents.prompt.painter.test.main" in err


@needs_a_server
async def test_a_reply_that_goes_to_a_pipe_is_written_as_it_came(world: World) -> None:
    for tool in world.tools():
        code, out, err = await world.run(tool, "painter", "paint it")
        assert (code, out) == (0, f"{PAINT_REPLY}\n".encode())
        assert _lines(err) == ["→ agents.prompt.painter.test.main (agent identity: none)".encode()]


@needs_a_server
@needs_a_terminal
async def test_a_terminal_is_sent_no_escape_sequence(world: World) -> None:
    for tool in world.tools():
        # The reply on a terminal: U+FFFD for each escape character, the lines and the tab as they came.
        code, shown = await world.run_on_terminal(tool, "painter", "paint it", terminal="stdout")
        assert (code, shown) == (0, f"{FFFD}[2Jcleared\tthe\nscreen {FFFD}[1A\n".encode())
        # The refusal on a terminal.
        code, shown = await world.run_on_terminal(tool, "refuser", "hi", terminal="stderr")
        assert code == 1
        assert ESC not in shown
        assert b"no reply: service error 500: no [2J way; the agent's own output says why" in shown
