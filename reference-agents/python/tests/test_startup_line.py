"""The startup line's ScratchPad state: the client the agent built, never
one variable. ``fabric env`` sets SCRATCHPAD_BOOTSTRAP_FILE and
SCRATCHPAD_DIR, not SCRATCHPAD_VOLUME, so a line read from SCRATCHPAD_VOLUME
alone said "off" for an agent whose replies carried ScratchPad references."""

from __future__ import annotations

from typing import Any

import pytest
from synadia_ai.agent_fabric import native_scratchpad_from_env

from fabric_agent.agent import scratchpad_line

CREATOR = "agents.prompt.assistant.o.a"


async def test_the_bootstrap_file_alone_turns_scratchpad_on_neither_variable_leaves_it_off() -> None:
    # With a bootstrap file and no volume, the factory builds a client: it
    # gets as far as asking for the workspace directory.
    nc: Any = object()
    with pytest.raises(Exception, match="SCRATCHPAD_DIR"):
        await native_scratchpad_from_env({"SCRATCHPAD_BOOTSTRAP_FILE": "/agent/scratchpad/bootstrap.json"}, nc=nc, creator=CREATOR)
    assert await native_scratchpad_from_env({}, nc=nc, creator=CREATOR) is None


def test_on_for_an_agent_with_a_client_whichever_variable_configured_it() -> None:
    assert scratchpad_line(True, {"SCRATCHPAD_BOOTSTRAP_FILE": "/agent/scratchpad/bootstrap.json", "SCRATCHPAD_DIR": "/agent/scratchpad"}) == "on"
    assert scratchpad_line(True, {"SCRATCHPAD_VOLUME": "AssistantReplies"}) == "on (volume AssistantReplies)"


def test_off_for_an_agent_without_one_even_when_a_variable_is_set() -> None:
    assert scratchpad_line(False, {}) == "off"
    assert scratchpad_line(False, {"SCRATCHPAD_VOLUME": "AssistantReplies"}) == "off"
