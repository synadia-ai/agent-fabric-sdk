"""model.py — one chat-completions client pointed at the fabric's proxy, and
the loop that runs the model's tool calls.

The agent never talks to a model provider. It talks to the proxy with its
virtual key, and the proxy resolves the key to a provider (Ollama on a laptop,
OpenRouter, OpenAI) and records the call on the agent's thread. The agent
holds three things: the proxy's URL, its virtual key and a model name. Two
headers on every call, ``X-Synadia-Thread-ID`` and ``X-Synadia-Root-ID`` from
the fabric package's ``trace_headers()``, tell the proxy which thread the call
belongs to; the proxy sees no NATS traffic, so nothing else about the tree has
to reach it.

One request, one JSON reply, no streaming: a tool-calling loop is easiest to
read that way, and the host SDK keeps the caller's stream alive with acks
while the loop runs.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from urllib.parse import urljoin

import httpx

#: One chat message as the OpenAI shape carries it: ``role`` and ``content``,
#: plus ``tool_calls`` on an assistant message that asks for tools and
#: ``tool_call_id`` on a ``tool`` message that answers one.
ChatMessage = dict[str, Any]


@dataclass(frozen=True)
class Completion:
    message: ChatMessage
    usage: Mapping[str, Any] | None


class ModelClient:
    """One chat-completions endpoint behind the proxy.

    ``proxy_url`` is the proxy's root; ``/v1/chat/completions`` is appended.
    ``virtual_key`` was issued through the console and names the provider the
    proxy forwards to; it lives in no file this repository tracks. ``model`` is
    what that provider understands, for example ``llama3.1:8b`` or
    ``openai/gpt-4o-mini``. ``timeout_s`` is per call; a local model on a
    laptop can take a while.
    """

    def __init__(
        self,
        *,
        proxy_url: str,
        virtual_key: str,
        model: str,
        timeout_s: float = 120.0,
    ) -> None:
        root = proxy_url if proxy_url.endswith("/") else proxy_url + "/"
        self._endpoint = urljoin(root, "v1/chat/completions")
        self._virtual_key = virtual_key
        self.model = model
        self._timeout_s = timeout_s
        self.label = f"{model} through {httpx.URL(self._endpoint).host}"

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[Mapping[str, Any]],
        headers: Mapping[str, str],
    ) -> Completion:
        """One chat-completions call; ``headers`` (the trace headers) are merged in."""
        body: dict[str, Any] = {"model": self.model, "messages": list(messages), "stream": False}
        # No ``tools`` key at all when there are none: some providers reject an empty list.
        if tools:
            body["tools"] = list(tools)
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            res = await client.post(
                self._endpoint,
                json=body,
                headers={"Authorization": f"Bearer {self._virtual_key}", **headers},
            )
        if res.status_code >= 400:
            raise RuntimeError(f"model call failed: {res.status_code} {res.text[:300]}".strip())
        reply = res.json()
        choices = reply.get("choices") or []
        message = choices[0].get("message") if choices else None
        if not isinstance(message, dict):
            raise RuntimeError("model reply carries no choices[0].message")
        return Completion(message=message, usage=reply.get("usage"))


class ToolRunner(Protocol):
    """What the loop needs from the tools: their definitions and a way to run one."""

    definitions: list[dict[str, Any]]

    async def call(self, name: str, args: Any, tool_call_id: str) -> str: ...


@dataclass(frozen=True)
class ConverseResult:
    reply: str
    model_calls: int
    tool_calls: int


@dataclass(frozen=True)
class OpenCall:
    """A call the model started that has not ended, as the tools last reported it."""

    call_id: str
    state: str  # "running" or "input_required"
    #: Whom the call went to, when the model's ``prompt_agent`` said.
    address: str | None = None
    #: What the prompted agent asked, while the call is ``input_required``.
    question: str | None = None


class EmptyReplyError(Exception):
    """The model answered with nothing, again, after it was asked for a reply:
    the turn has no reply, and, when calls it started are still open, it is not
    done either. The agent fails the prompt with this message rather than
    answer it with nothing."""

    def __init__(self, empty_replies: int, open_calls: Sequence[OpenCall]) -> None:
        self.empty_replies = empty_replies
        self.open_calls = list(open_calls)
        super().__init__(
            f"the model returned an empty reply {_times(empty_replies)} while {_describe_open(open_calls)}; "
            "no reply was produced"
            if open_calls
            else f"the model returned no reply: its answer was empty {_times(empty_replies)}"
        )


async def converse(
    *,
    model: ModelClient,
    tools: ToolRunner,
    messages: list[ChatMessage],
    trace_headers: Callable[[], Mapping[str, str]],
    max_tool_rounds: int = 8,
    max_empty_replies: int = 2,
    log: Callable[[str], None] | None = None,
) -> ConverseResult:
    """Run the model until it answers in words.

    ``messages`` is the conversation so far, ending with the user's message;
    the assistant's messages and every tool result are appended in place, in
    order, so the caller can keep them. ``trace_headers`` is called once per
    model call, immediately before it: the agent passes the fabric package's
    ``trace_headers``, which also counts the call as a turn on the edge of any
    thread the model spawns afterwards. ``max_tool_rounds`` is how many
    model calls may ask for tools before the model is asked to answer in
    words, against a model that keeps calling tools.

    An empty answer is not a reply while a call the model started is still
    open, waiting on a question it has to answer or still running: the turn is
    not done. The empty answer is dropped, the model is told which calls wait
    and on what, and asked again, at most ``max_empty_replies`` times; then the
    turn fails with :class:`EmptyReplyError`. Which calls are open comes from
    the tools' own results: each carries the call's ``call_id`` and ``state``,
    and a question while it is ``input_required``.

    An empty answer with nothing open is no reply either: the model is asked
    once more for one, and a second empty answer fails the turn with
    :class:`EmptyReplyError`. A turn never ends ``ok`` with nothing. With
    calls open the model is asked again at most ``max_empty_replies`` times;
    with none, once, and at most that many.
    """
    say = log or (lambda _line: None)
    model_calls = 0
    tool_calls = 0
    empty_replies = 0
    open_calls: dict[str, OpenCall] = {}
    round_ = 0
    while True:
        tools_offered = tools.definitions if round_ < max_tool_rounds else []
        completion = await model.complete(messages, tools_offered, trace_headers())
        model_calls += 1
        message = completion.message
        messages.append(message)
        calls = (message.get("tool_calls") or []) if tools_offered else []
        usage = completion.usage or {}
        say(
            f"model call {model_calls}: {len(calls)} tool call(s), "
            f"{usage.get('prompt_tokens', '?')} in / {usage.get('completion_tokens', '?')} out tokens"
        )
        if not calls:
            reply = message.get("content") or ""
            if reply.strip():
                return ConverseResult(reply=reply, model_calls=model_calls, tool_calls=tool_calls)
            empty_replies += 1
            waiting = list(open_calls.values())
            # With calls open the model has work left; with none, one more chance.
            bound = max_empty_replies if waiting else min(1, max_empty_replies)
            if empty_replies > bound:
                raise EmptyReplyError(empty_replies, waiting)
            say(
                f"  empty reply while {_describe_open(waiting)}: asking again ({empty_replies} of {bound})"
                if waiting
                else f"  empty reply: asking again for one ({empty_replies} of {bound})"
            )
            # The empty answer is no turn of the conversation: out of the
            # history, and a word to the model in its place.
            messages.pop()
            messages.append({"role": "user", "content": _still_open(waiting) if waiting else _NO_REPLY})
            round_ += 1
            continue
        for call in calls:
            function = call.get("function") or {}
            name = function.get("name", "")
            arguments = function.get("arguments", "{}")
            call_id = call.get("id") or f"call_{tool_calls + 1}"
            say(f"  {name}({str(arguments)[:120]}) [{call_id}]")
            content = await tools.call(name, arguments, call_id)
            tool_calls += 1
            messages.append({"role": "tool", "tool_call_id": call_id, "content": content})
            _track(open_calls, name, arguments, content)
        round_ += 1


def _track(open_calls: dict[str, OpenCall], tool: str, args: Any, content: str) -> None:
    """Note what a tool result says about the calls it names: a call
    ``running`` or ``input_required`` is open, any other state has ended. A
    result that names no call (discovery, an error) changes nothing;
    ``list_agent_calls`` names every call of the prompt being served."""
    try:
        result = json.loads(content)
    except ValueError:
        return
    if not isinstance(result, dict):
        return
    address = _address_of(args) if tool == "prompt_agent" else None
    entries = result["calls"] if isinstance(result.get("calls"), list) else [result]
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        call_id, state = entry.get("call_id"), entry.get("state")
        if not isinstance(call_id, str) or not isinstance(state, str):
            continue
        if state not in ("running", "input_required"):
            open_calls.pop(call_id, None)
            continue
        known = open_calls.get(call_id)
        to = entry["address"] if isinstance(entry.get("address"), str) else (address or (known.address if known else None))
        # A question stands until the call leaves ``input_required``.
        asked = entry["question"] if isinstance(entry.get("question"), str) else (known.question if known else None)
        question = asked if state == "input_required" else None
        open_calls[call_id] = OpenCall(call_id=call_id, state=state, address=to, question=question)


def _address_of(args: Any) -> str | None:
    try:
        parsed = json.loads(args) if isinstance(args, str) else args
    except ValueError:
        return None
    address = parsed.get("address") if isinstance(parsed, dict) else None
    return address if isinstance(address, str) else None


#: What the model is told in place of an empty answer with nothing open.
_NO_REPLY = "Your last answer was empty. Answer the prompt you are serving in words."


def _times(n: int) -> str:
    return "once" if n == 1 else f"{n} times"


def _describe_call(call: OpenCall) -> str:
    to = f" to {call.address}" if call.address is not None else ""
    if call.state == "input_required":
        asked = f' to "{call.question}"' if call.question is not None else ""
        return f"{call.call_id}{to} waits for an answer{asked}"
    return f"{call.call_id}{to} is still running"


def _describe_open(calls: Sequence[OpenCall]) -> str:
    counted = "1 call it started was still open" if len(calls) == 1 else f"{len(calls)} calls it started were still open"
    return f"{counted} ({'; '.join(_describe_call(c) for c in calls)})"


def _still_open(calls: Sequence[OpenCall]) -> str:
    """What the model is told in place of its empty answer while calls are open."""
    lines = [
        f"- {_describe_call(c)}: answer it with answer_agent."
        if c.state == "input_required"
        else f"- {_describe_call(c)}: collect its result before you answer."
        for c in calls
    ]
    head = "a call you started is still open." if len(calls) == 1 else "calls you started are still open."
    return (
        "Your last answer was empty, but the prompt you are serving is not done: "
        + head
        + "\n"
        + "\n".join(lines)
        + "\nDeal with them, then answer the prompt in words."
    )


__all__ = [
    "ChatMessage",
    "Completion",
    "ConverseResult",
    "EmptyReplyError",
    "OpenCall",
    "ModelClient",
    "ToolRunner",
    "converse",
]
