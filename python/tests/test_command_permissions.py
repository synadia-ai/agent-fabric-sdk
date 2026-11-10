"""The ``agent-fabric`` command with exactly a caller's permissions, in operator mode.

Run in process with ``erin.creds``: the agents listed, a reply streamed with
its root and reference on stderr, ``--json``, a question answered from
stdin, and the exit codes. The TypeScript suite's ``command.test.ts``.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import nats
import pytest
import pytest_asyncio
from synadia_ai.agent_service import AgentService

from synadia_ai.agent_fabric import CANNOT_ANSWER, fabric_tracing
from synadia_ai.agent_fabric.cli import EXIT_FAILED, EXIT_OK, run_command
from tests.command_io import recording_io
from tests.harness.nats_server import identity_fixture

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from nats.aio.msg import Msg

    from tests.harness.nats_server import RunningServer

ALICE = identity_fixture("operator/alice.creds")
ERIN = identity_fixture("operator/erin.creds")
REF = "sp-r1:rwxmJU9MR2qrq6urq6urq6urq6urq6urAAAAAAAAAAkQb4WlVJM_S1l6lm-1"
ROOT_LINE = re.compile(r"^root ([0-9a-f]{32})$", re.MULTILINE)
# What the writer asks and replies to a prompt that starts with ``paint:``: it
# colours the text, clears the screen and moves up a line.
PAINT_QUESTION = "which \x1b[31mcolour?"
PAINT_REPLY = "\x1b[2Jcleared\tthe\nscreen \x1b[1A"

pytestmark = pytest.mark.asyncio(loop_scope="module")


class World:
    def __init__(self, server: RunningServer, alice: Any, svc: AgentService) -> None:
        self.server = server
        self.alice = alice
        self.svc = svc
        self.answers: list[str] = []
        self.env = {"NATS_CREDS": str(ERIN), "NATS_URL": server.url}

    @property
    def address(self) -> str:
        return self.svc.subject.prompt


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def world(nats_server_operator: RunningServer) -> AsyncIterator[World]:
    alice = await nats.connect(nats_server_operator.url, user_credentials=str(ALICE))
    svc = AgentService(
        nc=alice,
        agent="writer",
        owner="fabric",
        session_name="s",
        description="writes",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=[fabric_tracing().request_interceptor],
    )
    w = World(nats_server_operator, alice, svc)

    async def handler(envelope: Any, stream: Any) -> None:
        if envelope.prompt.startswith("fail:"):
            raise RuntimeError("refused")
        if envelope.prompt.startswith("paint:"):
            # A question and a reply with escape sequences in them.
            await stream.ask(PAINT_QUESTION, timeout=3.0)
            await stream.send(PAINT_REPLY)
        elif envelope.prompt.startswith("cut:"):
            # A reply cut inside an emoji: each chunk holds half of it.
            await stream.send("thumbs " + chr(0xD83D))
            await stream.send(chr(0xDC4D) + " up")
        elif envelope.prompt.startswith("ask:"):
            answer = await stream.ask("which colour?", timeout=3.0)
            w.answers.append(answer.prompt)
            await stream.send(f"got {answer.prompt}")
        else:
            await stream.send(f"echo: {envelope.prompt}. ")
            await stream.send(f"kept at {REF}")

    svc.on_prompt(handler)
    await svc.start()
    try:
        yield w
    finally:
        await svc.stop()
        await alice.close()


async def test_lists_the_agents(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["agents"], io) == EXIT_OK
    # The host registers no identity of its own. Its description is under its row.
    assert rec.out == f"{world.address}\twriter\tagent identity: none\n\twrites\n"
    assert rec.err == f"url {world.server.url}\n"


async def test_lists_the_agents_as_json(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["agents", "--json"], io) == EXIT_OK
    assert json.loads(rec.out) == [
        {
            "address": world.address,
            "kind": "writer",
            "identity": None,
            "verified": False,
            "description": "writes",
        }
    ]


_REPO = Path(__file__).resolve().parents[2]
_TS_CLI = _REPO / "typescript" / "dist" / "cli.js"
# The two commands as a person runs them, and the two packaged examples that
# list the agents.
_PYTHON = (sys.executable, "-m", "synadia_ai.agent_fabric.cli")
_TYPESCRIPT = ("node", str(_TS_CLI))
_PYTHON_EXAMPLE = (sys.executable, str(_REPO / "python" / "examples" / "list_agents.py"))
_TYPESCRIPT_EXAMPLE = ("node", str(_REPO / "typescript" / "examples" / "list-agents.mjs"))
_ESC = b"\x1b"

both_commands = pytest.mark.skipif(
    shutil.which("node") is None or not _TS_CLI.exists(), reason="no node or no TypeScript build"
)

needs_a_terminal = pytest.mark.skipif(sys.platform == "win32", reason="needs a pseudo-terminal")


async def _run(
    program: tuple[str, ...], *args: str, env: dict[str, str] | None = None
) -> tuple[int | None, bytes, bytes]:
    """Run a command or an example as a program: its exit code, stdout and stderr."""
    proc = await asyncio.create_subprocess_exec(
        *program,
        *args,
        env={**os.environ, **(env or {})},
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return proc.returncode, out, err


async def _run_on_terminal(
    program: tuple[str, ...], *args: str, terminal: Literal["stdout", "stderr"]
) -> tuple[int | None, bytes, bytes]:
    """Run a command with a terminal as one of its two outputs.

    Returns its exit code, what the terminal was sent, and the other output,
    which is a pipe.
    """
    import pty  # noqa: PLC0415 - not on Windows
    import tty  # noqa: PLC0415

    master, slave = pty.openpty()
    try:
        # As the command wrote it: no line break turned into two characters.
        tty.setraw(slave)
        pipe = asyncio.subprocess.PIPE
        proc = await asyncio.create_subprocess_exec(
            *program,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=slave if terminal == "stdout" else pipe,
            stderr=slave if terminal == "stderr" else pipe,
        )
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
        out, err = await proc.communicate()
        return proc.returncode, await shown, out if terminal == "stderr" else err
    finally:
        os.close(master)


async def _registered(world: World, kind: str, address: str) -> Any:
    """An agent that registered ``kind`` and ``address`` as they are.

    A program that speaks NATS answers discovery itself, with whatever it
    likes: here an escape sequence in the kind and in the address, which the
    protocol SDK's host would not register.
    """
    info = json.dumps(
        {
            "type": "io.nats.micro.v1.info_response",
            "name": "agents",
            "id": "raw1",
            "version": "0.0.1",
            "description": "",
            "metadata": {"agent": kind, "owner": "fabric", "protocol_version": "0.3"},
            "endpoints": [
                {"name": "prompt", "subject": address, "queue_group": "agents", "metadata": {}}
            ],
        }
    ).encode()

    async def answer(msg: Msg) -> None:
        await msg.respond(info)

    sub = await world.alice.subscribe("$SRV.INFO.agents", cb=answer)
    await world.alice.flush()
    return sub


@both_commands
async def test_both_commands_and_examples_print_what_an_agent_registered_as_plain_text(
    world: World,
) -> None:
    # An agent whose kind and address hold escape sequences: one that colours
    # the text, one that clears the screen. Every line that names it, from
    # either command and either example, has a space where the escape
    # character was, so the terminal runs nothing.
    kind = "wri\x1b[31mter"
    sub = await _registered(world, kind, "agents.prompt.wri\x1b[2Jter.fabric.raw")
    address = b"agents.prompt.wri [2Jter.fabric.raw"
    creds = ("--creds", str(ERIN), "--url", world.server.url)
    try:
        missing = [await _run(p, "prompt", "nosuch", "hi", *creds) for p in (_PYTHON, _TYPESCRIPT)]
        found = [
            await _run(p, "prompt", kind, "hi", "--timeout", "5", *creds)
            for p in (_PYTHON, _TYPESCRIPT)
        ]
        examples = [await _run(p, env=world.env) for p in (_PYTHON_EXAMPLE, _TYPESCRIPT_EXAMPLE)]
    finally:
        await sub.unsubscribe()

    # No agent "nosuch": the error names every address that is there.
    for code, out, err in missing:
        assert (code, out) == (1, b"")
        assert err.startswith(
            f'url {world.server.url}\nagent-fabric: no agent "nosuch"; there: '.encode()
        )
        assert address in err and world.address.encode() in err
        assert _ESC not in err
    # The one agent of that kind: its address on the line that says who is prompted.
    for code, _out, err in found:
        assert code == 1  # nothing serves that address
        assert b"\xe2\x86\x92 " + address + b" (agent identity: none)\n" in err
        assert _ESC not in err
    # The examples print one row per agent, in the order discovery answered.
    rows = [sorted(out.splitlines()) for _code, out, _err in examples]
    assert [code for code, _out, _err in examples] == [0, 0]
    assert rows[0] == rows[1]
    assert address + b"\twri [31mter\tagent identity: none" in rows[0]
    assert all(_ESC not in out for _code, out, _err in examples)


@both_commands
@needs_a_terminal
async def test_both_commands_send_a_terminal_no_escape_sequence_and_a_pipe_the_exact_reply(
    world: World,
) -> None:
    # The writer's question and reply hold escape sequences. Where an output
    # is a terminal, both commands send it U+FFFD for each escape character,
    # the same bytes from both. Where it is a pipe, they write what came.
    prompt = ("prompt", "writer", "paint: it", "--creds", str(ERIN), "--url", world.server.url)
    fffd = chr(0xFFFD)
    question_shown = f"? which {fffd}[31mcolour?\n".encode()
    reply_shown = f"{fffd}[2Jcleared\tthe\nscreen {fffd}[1A\n".encode()
    seen = []
    for program in (_PYTHON, _TYPESCRIPT):
        # The reply on a terminal, the question on a pipe.
        code, shown, err = await _run_on_terminal(program, *prompt, terminal="stdout")
        assert (code, shown) == (0, reply_shown)
        assert f"? {PAINT_QUESTION}\n".encode() in err
        # The question on a terminal, the reply on a pipe.
        code, shown, out = await _run_on_terminal(program, *prompt, terminal="stderr")
        assert (code, out) == (0, f"{PAINT_REPLY}\n".encode())
        assert question_shown in shown
        assert _ESC not in shown
        seen.append(re.sub(rb"root [0-9a-f]{32}", b"root", shown))
    assert seen[0] == seen[1]


@both_commands
async def test_both_commands_list_every_agent_in_the_same_bytes_past_half_a_character(
    world: World,
) -> None:
    # Two more agents beside the writer, in its account. The middle one of the
    # three registered a description that ends in half a character, a text cut
    # inside an emoji. Python cannot write that to a terminal: the Python
    # command stopped there and never listed the writer. Both commands, run as
    # programs, print U+FFFD in its place and all three agents.
    async def serve(kind: str, name: str, description: str) -> AgentService:
        svc = AgentService(
            nc=world.alice,
            agent=kind,
            owner="fabric",
            session_name=name,
            description=description,
            heartbeat_interval_s=3600,
            keepalive_interval_s=None,
        )
        svc.on_prompt(lambda _envelope, _stream: asyncio.sleep(0))
        await svc.start()
        return svc

    async def listing(
        program: tuple[str, ...], *, json: bool = False
    ) -> tuple[int | None, bytes, bytes]:
        flags = ("--json",) if json else ()
        return await _run(
            program, "agents", *flags, "--creds", str(ERIN), "--url", world.server.url
        )

    extra = [
        await serve("archive", "a1", "Keeps what was written."),
        await serve("cutter", "c1", "cut in an emoji " + chr(0xD83D)),
    ]
    try:
        python = await listing(_PYTHON)
        typescript = await listing(_TYPESCRIPT)
        python_json = await listing(_PYTHON, json=True)
        typescript_json = await listing(_TYPESCRIPT, json=True)
    finally:
        for svc in extra:
            await svc.stop()

    expected = (
        "agents.prompt.archive.fabric.a1\tarchive\tagent identity: none\n"
        "\tKeeps what was written.\n"
        "agents.prompt.cutter.fabric.c1\tcutter\tagent identity: none\n"
        f"\tcut in an emoji {chr(0xFFFD)}\n"
        f"{world.address}\twriter\tagent identity: none\n"
        "\twrites\n"
    ).encode()
    url = f"url {world.server.url}\n".encode()
    assert python == (0, expected, url)
    assert typescript == (0, expected, url)
    # And ``--json``, which gives the description as it was registered: half a
    # character as its JSON escape, the same bytes from both.
    assert typescript_json[0] == 0
    assert b'"description":"cut in an emoji \\ud83d"' in typescript_json[1]
    assert python_json == typescript_json


@both_commands
@needs_a_terminal
async def test_both_commands_print_a_reply_cut_inside_an_emoji_in_the_same_bytes(
    world: World,
) -> None:
    # The writer's reply comes in two chunks, cut inside an emoji: each holds
    # half a character, which cannot be written as UTF-8. The Python command
    # exited 1 with nothing printed. Both print U+FFFD for each half.
    prompt = ("prompt", "writer", "cut: it", "--creds", str(ERIN), "--url", world.server.url)
    fffd = chr(0xFFFD)
    for program in (_PYTHON, _TYPESCRIPT):
        code, out, _err = await _run(program, *prompt)
        assert (code, out) == (0, f"thumbs {fffd}{fffd} up\n".encode())
        code, shown, _err = await _run_on_terminal(program, *prompt, terminal="stdout")
        assert (code, shown) == (0, f"thumbs {fffd}{fffd} up\n".encode())
    # In --json the reply is one text, and the two halves one character again.
    as_json = [await _run(program, *prompt, "--json") for program in (_PYTHON, _TYPESCRIPT)]
    assert [code for code, _out, _err in as_json] == [0, 0]
    texts = [re.sub(rb'"root":"[0-9a-f]{32}"', b'"root":""', out) for _code, out, _err in as_json]
    assert texts[0] == texts[1]
    assert texts[0] == f'{{"root":"","text":"thumbs {chr(0x1F44D)} up","references":[]}}\n'.encode()


@pytest.mark.parametrize(
    ("env", "exact"),
    [
        # A terminal set to Latin-1, where the system has that locale.
        ({"LC_ALL": "en_US.ISO8859-1", "PYTHONUTF8": "0", "PYTHONIOENCODING": ""}, False),
        # The same encoding on any system.
        ({"PYTHONIOENCODING": "iso8859-1"}, True),
    ],
    ids=["LC_ALL", "PYTHONIOENCODING"],
)
async def test_lists_every_agent_on_a_stdout_that_is_not_utf8(
    world: World, env: dict[str, str], exact: bool
) -> None:
    # Three agents. Two descriptions hold what Latin-1 cannot: an arrow, and
    # U+FFFD, which the list prints for half a character. Python's stdout
    # stopped at the first of them. It writes ``?`` there, and every agent.
    async def serve(kind: str, name: str, description: str) -> AgentService:
        svc = AgentService(
            nc=world.alice,
            agent=kind,
            owner="fabric",
            session_name=name,
            description=description,
            heartbeat_interval_s=3600,
            keepalive_interval_s=None,
        )
        svc.on_prompt(lambda _envelope, _stream: asyncio.sleep(0))
        await svc.start()
        return svc

    extra = [
        await serve("archive", "a1", "Keeps the caf\u00e9's orders \u2192 ask it."),
        await serve("cutter", "c1", "cut in an emoji " + chr(0xD83D)),
    ]
    try:
        code, out, err = await _run(
            _PYTHON, "agents", "--creds", str(ERIN), "--url", world.server.url, env=env
        )
    finally:
        for svc in extra:
            await svc.stop()

    assert (code, err) == (0, f"url {world.server.url}\n".encode())
    rows = [line.split(b"\t")[0] for line in out.splitlines() if not line.startswith(b"\t")]
    assert rows == [
        b"agents.prompt.archive.fabric.a1",
        b"agents.prompt.cutter.fabric.c1",
        world.address.encode(),
    ]
    if exact:
        assert out == (
            b"agents.prompt.archive.fabric.a1\tarchive\tagent identity: none\n"
            b"\tKeeps the caf\xe9's orders ? ask it.\n"
            b"agents.prompt.cutter.fabric.c1\tcutter\tagent identity: none\n"
            b"\tcut in an emoji ?\n"
            + f"{world.address}\twriter\tagent identity: none\n\twrites\n".encode()
        )


async def test_streams_the_reply_and_the_root_and_reference_on_stderr(world: World) -> None:
    edges: list[Msg] = []

    async def on_edge(msg: Msg) -> None:
        edges.append(msg)

    sub = await world.alice.subscribe("TRACE.edges", cb=on_edge)
    await world.alice.flush()
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "hello", "there"], io) == EXIT_OK
    await asyncio.sleep(0.2)
    await sub.unsubscribe()
    assert rec.out == f"echo: hello there. kept at {REF}\n"
    found = ROOT_LINE.search(rec.err)
    assert found is not None
    root = found.group(1)
    assert f"→ {world.address} (agent identity: none)\n" in rec.err
    assert f"reference: {REF}\n" in rec.err
    record = json.loads(edges[0].data)
    assert record["parent_id"] is None
    assert record["root_id"] == record["thread_id"] == root


async def test_prints_one_json_object(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "hi", "--json"], io) == EXIT_OK
    out = json.loads(rec.out)
    assert list(out) == ["root", "text", "references"]
    found = ROOT_LINE.search(rec.err)
    assert found is not None
    assert out == {"root": found.group(1), "text": f"echo: hi. kept at {REF}", "references": [REF]}


async def test_answers_a_question_from_stdin(world: World) -> None:
    io, rec = recording_io(world.env, ["green"])
    assert await run_command(["prompt", "writer", "ask: colour"], io) == EXIT_OK
    assert "? which colour?\n" in rec.err
    assert rec.out == "got green\n"
    assert world.answers[-1] == "green"


async def test_tells_the_agent_it_cannot_answer_when_stdin_has_nothing(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "ask: colour"], io) == EXIT_OK
    assert rec.out == f"got {CANNOT_ANSWER}\n"


async def test_exits_1_for_no_such_agent(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "nobody", "hi"], io) == EXIT_FAILED
    assert f'agent-fabric: no agent "nobody"; there: {world.address}' in rec.err


async def test_exits_1_for_a_refused_prompt(world: World) -> None:
    io, rec = recording_io(world.env)
    assert await run_command(["prompt", "writer", "fail: now"], io) == EXIT_FAILED
    assert "agent-fabric: no reply:" in rec.err


async def test_exits_1_for_creds_the_server_will_not_describe(world: World) -> None:
    env = {**world.env, "NATS_CREDS": str(identity_fixture("operator/erin-no-user-info.creds"))}
    io, rec = recording_io(env)
    assert await run_command(["prompt", "writer", "hi"], io) == EXIT_FAILED
    assert "would not tell this creds file's identity" in rec.err


async def test_exits_1_when_it_cannot_connect(world: World) -> None:
    io, rec = recording_io({**world.env, "NATS_URL": "nats://127.0.0.1:1"})
    assert await run_command(["agents"], io) == EXIT_FAILED
    assert "url nats://127.0.0.1:1\n" in rec.err
    assert "could not connect to nats://127.0.0.1:1" in rec.err
