"""The agent's ``.env`` reader, ``load_env_file`` (``fabric_agent/config.py``).

A value in quotes is taken whole: inside the quotes nothing starts a comment.
The reader does for this agent what Node's ``--env-file`` does for the
TypeScript one, so one ``.env`` line must give both agents the same value:
the lines below are read by both and compared.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from fabric_agent.config import load_config, load_env_file

# A description with a ``#`` in it, after two spaces: in double quotes, as the
# README and ``env.example`` say to write one.
RANKS = 'AGENT_DESCRIPTION="Ranks issues.  #1 comes first."'


def read(tmp_path: Path, *lines: str) -> dict[str, str]:
    env_file = tmp_path / "agent.env"
    env_file.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
    return load_env_file(env_file)


def test_inside_quotes_nothing_starts_a_comment(tmp_path: Path) -> None:
    # The reader took two spaces and a ``#`` for an inline comment, inside the
    # quotes too: the agent registered ``Ranks issues.`` and logged nothing.
    assert read(tmp_path, RANKS) == {"AGENT_DESCRIPTION": "Ranks issues.  #1 comes first."}


def test_the_agent_registers_the_whole_quoted_description(tmp_path: Path) -> None:
    env = {
        "MODEL_PROXY_URL": "http://proxy",
        "MODEL_VIRTUAL_KEY": "vk",
        "MODEL_NAME": "m-1",
        "NATS_CREDS": "/dev/null",
        **read(tmp_path, RANKS),
    }
    log: list[str] = []
    # One line of plain text: the two spaces are one, and the log says the text was cleaned.
    assert load_config(env, log.append).agent.description == "Ranks issues. #1 comes first."
    assert len(log) == 1 and log[0].startswith("AGENT_DESCRIPTION was cleaned")


def test_a_comment_after_the_closing_quote_is_not_part_of_the_value(tmp_path: Path) -> None:
    assert read(tmp_path, "A=\"Ranks #1 first.\"  # the queue's order", "B='one'  # two") == {
        "A": "Ranks #1 first.",
        "B": "one",
    }


def test_a_value_without_quotes_ends_at_an_inline_comment_as_before(tmp_path: Path) -> None:
    assert read(
        tmp_path,
        "# a comment",
        "",
        "AGENT_KIND=assistant              # the kind of agent",
        "AGENT_DESCRIPTION=Keeps the logs. Ask it what happened.",
        "MODEL_PROXY_URL = http://proxy/v1 ",
    ) == {
        "AGENT_KIND": "assistant",
        "AGENT_DESCRIPTION": "Keeps the logs. Ask it what happened.",
        "MODEL_PROXY_URL": "http://proxy/v1",
    }


# What follows ``KEY=`` on a line of ``.env``, as a person writes a value:
# plain, in double or single quotes, with a comment after it, with a ``#``, an
# apostrophe or the other kind of quote inside the quotes.
VALUES = [
    '"Ranks issues.  #1 comes first."',
    "'Ranks issues.  #1 comes first.'",
    '"Ranks issues. #1 comes first."  # the queue\'s order',
    "'Ranks issues. #1 comes first.'  # the queue's order",
    '"Ranks issues #1 to #9"',
    '"#1 comes first."',
    "\"It's the orders server's log keeper.\"",
    "'Says \"no\" to #2.'",
    '""',
    "Keeps the logs of the orders server. Ask it what happened in a time range.",
    "Keeps the logs.  # what the other agents read",
    "assistant              # the kind of agent",
    "nats://127.0.0.1:4222",
    "  spaces around  ",
]


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node on PATH")
def test_one_line_gives_both_agents_the_same_value(tmp_path: Path) -> None:
    # Node reads the TypeScript agent's ``.env`` (``--env-file``, or the same
    # reader when the agent finds a ``.env`` itself).
    lines = [f"LINE_{i}={value}" for i, value in enumerate(VALUES)]
    python = read(tmp_path, *lines)
    keys = [f"LINE_{i}" for i in range(len(VALUES))]
    show = f"process.stdout.write(JSON.stringify(Object.fromEntries({json.dumps(keys)}.map((k) => [k, process.env[k]]))))"
    # The file's values only: a variable already in the environment would win.
    env = {k: v for k, v in os.environ.items() if not k.startswith("LINE_")}
    node = subprocess.run(
        ["node", f"--env-file={tmp_path / 'agent.env'}", "-e", show],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    )
    assert python == json.loads(node.stdout)
    assert python["LINE_0"] == "Ranks issues.  #1 comes first."
