"""The agent's description: the rule (``fabric_agent/description.py``) against
the vectors both reference agents share, ``AGENT_DESCRIPTION`` as
``load_config`` reads it, and the agent as ``python -m fabric_agent`` runs it,
on a throwaway nats-server: what it registers and what its startup lines say.

The vectors file holds two lists. ``clean`` is the rule the agents apply: it
makes any text fit and never refuses. ``entry`` is for the places a person
types a description, which refuse rather than change it (the ``fabric`` command
and the console's form); the agents do not use it.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import nats
import pytest
from synadia_ai.agents import Agents, DiscoverFilter

from fabric_agent.config import load_config
from fabric_agent.description import DESCRIPTION_LIMIT, clean_description
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user

AGENT_DIR = Path(__file__).resolve().parents[1]
binary = nats_server_on_path()

VECTORS = json.loads((Path(__file__).parents[2] / "test-fixtures/description-vectors.json").read_text(encoding="utf-8"))


def test_the_limit_is_the_vectors() -> None:
    assert DESCRIPTION_LIMIT == VECTORS["limit"]
    assert VECTORS["clean"]


@pytest.mark.parametrize("vector", VECTORS["clean"], ids=lambda v: v["name"])
def test_clean_description_against_the_shared_vectors(vector: dict[str, str]) -> None:
    assert clean_description(vector["in"]) == vector["out"]
    # A cleaned text is a description: cleaning it again changes nothing.
    assert clean_description(vector["out"]) == vector["out"]


ENV = {
    "MODEL_PROXY_URL": "http://proxy",
    "MODEL_VIRTUAL_KEY": "vk",
    "MODEL_NAME": "m-1",
    "NATS_CREDS": "/dev/null",
    "AGENT_KIND": "researcher",
}
# The two lines an agent logs about a description it could not use as given.
CLEANED = (
    "AGENT_DESCRIPTION was cleaned: a description is one line of plain text of at most 500 characters. "
    "A line break, a tab, a control or an invisible character becomes a space (the zero width joiner and non-joiner stay), "
    "runs of spaces become one, and a longer text is cut to its first 500 characters."
)
NO_TEXT = "AGENT_DESCRIPTION holds no text: the default description is used."


def load(value: str | None = None) -> tuple[str, list[str]]:
    """The description in use and what the agent logged about it."""
    log: list[str] = []
    cfg = load_config(ENV if value is None else {**ENV, "AGENT_DESCRIPTION": value}, log.append)
    return cfg.agent.description, log


def test_unset_or_empty_the_default_kind_agent_model() -> None:
    assert load() == ("researcher agent (m-1)", [])
    assert load("") == ("researcher agent (m-1)", [])


def test_set_it_is_used_as_it_is_and_nothing_is_logged() -> None:
    text = "Keeps the logs of the orders server. Ask it what happened in a time range. Reads only; changes nothing on the server."
    assert load(text) == (text, [])


def test_keeps_every_printable_character_the_rule_cleans_it_does_not_refuse() -> None:
    text = 'Answers "what broke?" for <orders> at $5 a `look`; the server\u2019s logs \\ 50% #1 \U0001f44d'
    assert load(text) == (text, [])


def test_keeps_the_zero_width_joiner_and_non_joiner_a_word_and_an_emoji_spelled_with_them_stay_whole() -> None:
    # A Persian word with a non-joiner in it, and a family of three emoji held by two joiners.
    word = "".join(map(chr, (0x645, 0x6CC, 0x200C, 0x62E, 0x648, 0x627, 0x647, 0x645)))
    family = "".join(map(chr, (0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467)))
    assert load(f"{word} {family}") == (f"{word} {family}", [])


def test_with_a_line_break_it_is_one_line_and_one_line_in_the_log_says_it_was_cleaned() -> None:
    assert load("Keeps the logs.\nAsk it\twhat happened.\r\n") == ("Keeps the logs. Ask it what happened.", [CLEANED])


def test_with_a_control_or_an_invisible_character_a_space_takes_its_place() -> None:
    assert load("red \u001b[31malert\u200bhere") == ("red [31malert here", [CLEANED])


def test_too_long_it_is_cut_to_its_first_500_characters_and_the_log_says_so() -> None:
    description, log = load("word " * 120 + "end")
    assert len(description) <= DESCRIPTION_LIMIT
    assert description == ("word " * 100).rstrip()
    assert log == [CLEANED]


def test_exactly_500_characters_long_it_is_used_whole() -> None:
    text = "a" * 499 + "\U0001f44d"
    assert load(text) == (text, [])


def test_with_nothing_left_once_cleaned_the_default_and_the_log_says_so() -> None:
    assert load("   ") == ("researcher agent (m-1)", [NO_TEXT])
    assert load("\t\n\u200b") == ("researcher agent (m-1)", [NO_TEXT])


def test_logs_to_stdout_unless_told_where(capsys: pytest.CaptureFixture[str]) -> None:
    assert load_config({**ENV, "AGENT_DESCRIPTION": "a\nb"}).agent.description == "a b"
    assert capsys.readouterr().out == f"{CLEANED}\n"


@pytest.mark.skipif(binary is None, reason="needs nats-server on PATH")
async def test_the_agent_as_it_is_started_registers_the_cleaned_description_and_its_startup_lines_say_it(
    tmp_path: Path,
) -> None:
    users = {name: new_user() for name in ("agent", "caller")}
    server = LocalNatsServer.start(binary, list(users.values()))  # type: ignore[arg-type]
    child: subprocess.Popen[bytes] | None = None
    try:
        # The startup lines are the agent's stdout; a warning on stderr is not one of them.
        ready, log, errors = tmp_path / "ready.json", tmp_path / "agent.log", tmp_path / "agent.err"

        def said() -> str:
            return log.read_text(encoding="utf-8", errors="replace")

        def failed() -> str:
            return f"the agent did not start:\n{said()}{errors.read_text(encoding='utf-8', errors='replace')}"

        env = {
            **os.environ,
            "NATS_URL": server.url,
            "NATS_NKEY_SEED_FILE": server.write_seed_file(users["agent"], "agent"),
            "NATS_CONTEXT": "",
            "NATS_CREDS": "",
            "AGENT_KIND": "logkeeper",
            "AGENT_OWNER": "test",
            "AGENT_NAME": "main",
            # As the environment can give it: on two lines.
            "AGENT_DESCRIPTION": "Keeps the logs of the orders server.\nAsk it what happened in a time range.",
            "AGENT_READY_FILE": str(ready),
            # Nothing prompts the agent, so no model is called.
            "MODEL_PROXY_URL": "http://127.0.0.1:9",
            "MODEL_VIRTUAL_KEY": "vk-test",
            "MODEL_NAME": "fake-1",
            "SCRATCHPAD_VOLUME": "",
            "SCRATCHPAD_BOOTSTRAP_FILE": "",
            "AGENT_DURABLE": "0",
        }
        with log.open("wb") as out, errors.open("wb") as err:
            # A file that does not exist, so no .env next to the agent is read.
            child = subprocess.Popen(
                [sys.executable, "-m", "fabric_agent", str(tmp_path / "no.env")],
                cwd=AGENT_DIR,
                env=env,
                stdout=out,
                stderr=err,
            )
        # The startup lines follow the ready file; the last of them ends the wait.
        for _ in range(300):
            if ready.exists() and "press Ctrl+C" in said():
                break
            assert child.poll() is None, failed()
            await asyncio.sleep(0.1)
        else:
            raise AssertionError(failed())

        # What the other agents are shown: the description on one line.
        nc = await nats.connect(server.url, nkeys_seed_str=users["caller"].seed)
        caller = Agents(nc=nc)
        try:
            found = await caller.discover(timeout=0.5, filter=DiscoverFilter(agent="logkeeper"))
        finally:
            await caller.close()
            await nc.close()
        assert [a.description for a in found] == [
            "Keeps the logs of the orders server. Ask it what happened in a time range."
        ]

        # And what the person who started it is shown: that the text was
        # cleaned, then the description in use, under the address.
        lines = said().split("\n")
        assert lines[0] == CLEANED
        assert lines[1] == "logkeeper agent listening on agents.prompt.logkeeper.test.main"
        assert lines[2] == "description: Keeps the logs of the orders server. Ask it what happened in a time range."
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        server.stop()
