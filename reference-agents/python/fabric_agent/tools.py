"""tools.py — the agent tools, as a chat-completions model loop sees them.

An agent on the fabric is not only reachable. It can see who else is there
and prompt them. The tools that give its model that capability are the SDK's:
``AgentTools`` from ``synadia_ai.agents``, the six of the SDK's contract (its
``docs/agent-tools.md``), with the words the model reads and what each call
does. This agent offers the first three by default (``BLOCKING_TOOLS``
below), all six with ``AGENT_TOOLS=all``:

    discover_agents   the agents on the fabric, one entry per address
    prompt_agent      a prompt to one of them; by default it waits for the
                      reply, or for a question the other agent asks
    answer_agent      the answer to such a question
    wait_agent        the result of a prompt started with ``wait: false``
    cancel_agent      stop a prompt
    list_agent_calls  the prompts started in the prompt being served

The fabric package adds its rules for ScratchPad references to them, as an
extension (``scratch_pad_extension``; ``agent.py`` wires both). What is left
for this file is the model loop's side: show the model the definitions in the
shape a chat-completions request carries, run each call the model makes, and
hand back the result as the ``tool`` message's content.

Why a child thread hangs under the right parent with no plumbing here: the
fabric package's request interceptor runs the agent's prompt handler inside a
trace scope (a ``ContextVar``, which every ``await`` in the handler's task
sees, so it is still there when the model loop calls back into this file).
The client's prompt interceptor, from the same package, reads that scope when
``prompt_agent`` sends: it mints a thread ID for the child, writes the
``edge`` record with the served thread as ``parent_id``, and puts the ids on
the envelope. The one thing this code has to do is pass the model's tool-call
id through, so the edge names the call that spawned the child.

Reference code: copy it and adapt it to your model loop. The words the model
reads are the SDK's, so every agent that offers these tools shows its model
the same ones, whatever language it is written in. The same file as the
TypeScript agent's ``src/tools.ts``.
"""

from __future__ import annotations

import json
from typing import Any

from synadia_ai.agents import AgentTools

from .config import ToolsSetting
from .model import ToolRunner

#: The three tools a model needs to delegate one step at a time: find an
#: agent, prompt it and wait for the reply, and answer a question it asks on
#: the way. Every definition the model is shown is input tokens on every model
#: call, and these three cost a little over half of the six. Without
#: ``wait_agent`` nothing can be detached, so the SDK shows ``prompt_agent``
#: and ``answer_agent`` without their ``wait`` parameter and with words that
#: name no tool it does not offer.
BLOCKING_TOOLS: tuple[str, ...] = ("discover_agents", "prompt_agent", "answer_agent")


def offered_tools(setting: ToolsSetting) -> list[str] | None:
    """``AgentTools``' ``tools`` option for an ``AGENT_TOOLS`` setting
    (``config.py``): the three above by default, the SDK's six with ``all``.
    With ``none`` the helper is built with the three as well, and the model is
    shown nothing (:data:`NO_TOOLS`)."""
    return None if setting == "all" else list(BLOCKING_TOOLS)


def chat_tools(tools: AgentTools) -> list[dict[str, Any]]:
    """The SDK's definitions in the chat-completions shape: each one wrapped
    as a ``function``, not a word changed."""
    return [
        {"type": "function", "function": {"name": d["name"], "description": d["description"], "parameters": d["parameters"]}}
        for d in tools.definitions
    ]


class _Runner:
    def __init__(self, tools: AgentTools) -> None:
        self._tools = tools
        self.definitions = chat_tools(tools)

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        return json.dumps(await self._tools.execute(name, args, tool_call_id=tool_call_id))


def tool_runner(tools: AgentTools) -> ToolRunner:
    """The tools for ``converse()``: the definitions, and a call that runs one.

    The model's tool-call id goes with each call; ``prompt_agent`` puts it in
    the prompt's context, where the fabric's tracing writes it on the edge, and
    a grant made for the call carries it too. The result, whatever the tool, is
    a JSON object; the model gets it as JSON text. Something the model got wrong
    comes back in words (``{"error": ...}``), never as an exception.
    """
    return _Runner(tools)


class _NoTools:
    definitions: list[dict[str, Any]] = []

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        return json.dumps({"error": "this agent has no tools"})


#: A role that must answer itself is offered no tools at all
#: (``AGENT_TOOLS=none`` in ``config.py``). The agent keeps the capability; the
#: model is not shown it.
NO_TOOLS: ToolRunner = _NoTools()


__all__ = ["BLOCKING_TOOLS", "NO_TOOLS", "chat_tools", "offered_tools", "tool_runner"]
