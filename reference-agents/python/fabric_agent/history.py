"""history.py — what the model is shown of earlier exchanges.

Three rules, the same in the TypeScript agent (``typescript/src/history.ts``):

- A history per caller, keyed by the verified sender's agent ID. What one
  caller said is never shown to the model serving another. A caller whose
  signature did not verify gets no history: an unsigned claim names nobody
  the exchange could be kept for.
- Bounded twice: the last ``max_exchanges`` exchanges of a caller, and the
  last :data:`MAX_CALLERS` callers served; the one served longest ago is
  dropped first. ``max_exchanges`` 0 keeps nothing: the model gets the system
  prompt and the prompt alone.
- An exchange in which the model used tools says so: one short line in front
  of the reply names the tools and the agents it prompted, never arguments or
  results. Without it a model that delegated is shown only prompts answered
  at once with a finished reply, and the more such examples the history
  holds, the more it answers the next prompt that way itself, without its
  tools.
"""

from __future__ import annotations

import json
import re
from collections import OrderedDict
from collections.abc import Sequence
from typing import Any

from synadia_ai.agents import SenderInfo

from .model import ChatMessage

#: How many callers' histories one agent keeps.
MAX_CALLERS = 32


class Histories:
    def __init__(self, max_exchanges: int, max_callers: int = MAX_CALLERS) -> None:
        self._max_exchanges = max_exchanges
        self._max_callers = max_callers
        self._by_caller: OrderedDict[str, list[ChatMessage]] = OrderedDict()

    def for_sender(self, sender: SenderInfo | None) -> list[ChatMessage]:
        """The earlier exchanges to show the model serving this sender."""
        key = _key_of(sender)
        return list(self._by_caller.get(key, [])) if key is not None else []

    def record(self, sender: SenderInfo | None, prompt: str, reply: str) -> None:
        """Keep one exchange for this sender; a sender that did not verify is not kept."""
        key = _key_of(sender)
        if key is None or self._max_exchanges <= 0:
            return
        history = self._by_caller.setdefault(key, [])
        # Last served goes last: the order is the order to drop in.
        self._by_caller.move_to_end(key)
        history.append({"role": "user", "content": prompt})
        history.append({"role": "assistant", "content": reply})
        del history[: max(0, len(history) - self._max_exchanges * 2)]
        while len(self._by_caller) > self._max_callers:
            self._by_caller.popitem(last=False)

    @property
    def callers(self) -> int:
        """How many callers have a history; for tests."""
        return len(self._by_caller)


def _key_of(sender: SenderInfo | None) -> str | None:
    return str(sender.id) if sender is not None and sender.trust == "verified" else None


# Only what reads as a tool name or a subject goes into the note; anything
# else the model put in a call is left out.
_TOOL_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}")
_ADDRESS = re.compile(r"[A-Za-z0-9_$.-]{1,256}")


def tool_note(turn: Sequence[ChatMessage]) -> str | None:
    """The line that says which tools a turn used, from the messages the model
    loop added to it, or ``None`` when it used none::

        [tools used: discover_agents; prompt_agent x2 to agents.prompt.a.o.n, agents.prompt.b.o.n; answer_agent]

    Each tool once, in the order first called, with a count above one; for
    ``prompt_agent`` the addresses it named. No arguments, no results.
    """
    used: dict[str, tuple[int, list[str]]] = {}
    for message in turn:
        for call in message.get("tool_calls") or []:
            function = call.get("function") or {}
            name = function.get("name", "")
            if not isinstance(name, str) or not _TOOL_NAME.fullmatch(name):
                continue
            count, addresses = used.get(name, (0, []))
            if name == "prompt_agent":
                address = _address_of(function.get("arguments", ""))
                if address is not None and address not in addresses:
                    addresses.append(address)
            used[name] = (count + 1, addresses)
    if not used:
        return None
    parts = [
        name + (f" x{count}" if count > 1 else "") + (f" to {', '.join(addresses)}" if addresses else "")
        for name, (count, addresses) in used.items()
    ]
    return f"[tools used: {'; '.join(parts)}]"


def with_tool_note(turn: Sequence[ChatMessage], reply: str) -> str:
    """The reply as the history keeps it: the note, if any, on its own line in front."""
    note = tool_note(turn)
    return reply if note is None else f"{note}\n{reply}"


def _address_of(args: Any) -> str | None:
    try:
        parsed = json.loads(args) if isinstance(args, str) else args
    except ValueError:
        return None
    address = parsed.get("address") if isinstance(parsed, dict) else None
    return address if isinstance(address, str) and _ADDRESS.fullmatch(address) else None
