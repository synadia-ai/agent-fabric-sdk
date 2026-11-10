"""The default persona, what the agent's model is told when
``AGENT_SYSTEM_PROMPT`` is unset: plain about the tools, and about how an agent
is chosen, by what its description says it does."""

from __future__ import annotations

from fabric_agent.config import load_config

ENV = {"MODEL_PROXY_URL": "http://proxy", "MODEL_VIRTUAL_KEY": "vk", "MODEL_NAME": "m", "NATS_CREDS": "/dev/null"}


def test_the_default_persona_names_the_tools_and_says_how_an_agent_is_chosen() -> None:
    # Word for word the TypeScript agent's (``typescript/test/persona.test.ts``
    # holds the same text): a model is told the same whichever agent runs it.
    assert load_config(ENV).agent.system_prompt == (
        "You are a helpful agent on the Synadia Agent Fabric. Answer briefly and clearly, in plain text. "
        "Your tools reach the other agents: discover_agents lists them, prompt_agent asks one of them to do something. "
        "Choose an agent by what its description says it does. "
        "Answer yourself unless the task asks for another agent or clearly needs one; never invent a tool result."
    )


def test_the_default_persona_gives_way_to_agent_system_prompt() -> None:
    assert load_config({**ENV, "AGENT_SYSTEM_PROMPT": "You are a careful librarian."}).agent.system_prompt == (
        "You are a careful librarian."
    )
