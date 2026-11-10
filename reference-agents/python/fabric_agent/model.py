"""model.py — one model client pointed at the fabric's proxy, and the loop
that runs the model's tool calls.

The agent never talks to a model provider. It talks to the proxy with its
virtual key, and the proxy resolves the key to a provider (Ollama on a laptop,
OpenRouter, OpenAI, Anthropic) and records the call on the agent's thread.
The agent holds four things: the proxy's URL, its virtual key, a model name,
and the provider behind the key. Two headers on every call,
``X-Synadia-Thread-ID`` and ``X-Synadia-Root-ID`` from the fabric package's
``trace_headers()``, tell the proxy which thread the call belongs to; the
proxy sees no NATS traffic, so nothing else about the tree has to reach it.

Two APIs, picked by the provider. Anthropic is called on its own Messages API
(``/v1/messages``), because that is where the proxy reads an Anthropic call's
tokens and content; every other provider on the OpenAI chat-completions API
(``/v1/chat/completions``). The loop below speaks the chat-completions shape
either way: the Anthropic client translates on the way out and back.

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
#: ``tool_call_id`` on a ``tool`` message that answers one. An assistant
#: message from Anthropic's Messages API also carries ``anthropic_content``:
#: the reply's content blocks as the API returned them, its thinking blocks
#: included. They go back unchanged while the turn's tool loop runs, because
#: the API checks a replayed thinking block against the conversation that
#: produced it. The chat-completions client never sets it.
ChatMessage = dict[str, Any]

#: The provider whose own API the client speaks; every other provider gets chat completions.
ANTHROPIC_PROVIDER = "anthropic"

#: The Messages API version the Anthropic client asks for.
ANTHROPIC_VERSION = "2026-10-21"

#: Anthropic's ``max_tokens``, which its API requires, when ``MODEL_MAX_TOKENS``
#: sets none: room for a long answer without streaming. Thinking counts toward it.
DEFAULT_MAX_TOKENS = 16_000


def api_of(provider: str | None) -> str:
    """Which API the client speaks for a provider, as the startup line says it."""
    return "Anthropic's Messages API" if provider == ANTHROPIC_PROVIDER else "the OpenAI chat-completions API"


@dataclass(frozen=True)
class Completion:
    message: ChatMessage
    usage: Mapping[str, Any] | None


class ModelClient:
    """One model endpoint behind the proxy.

    ``proxy_url`` is the proxy's root; ``/v1/chat/completions`` is appended, or
    ``/v1/messages`` for Anthropic; for OpenRouter the root ends in ``/api``.
    ``virtual_key`` was issued through the console and names the provider the
    proxy forwards to; it lives in no file this repository tracks. ``model`` is
    what that provider understands, for example ``llama3.1:8b``,
    ``openai/gpt-4o-mini`` or ``claude-sonnet-5-5``. ``provider`` is the
    provider the key names (``MODEL_PROVIDER``): ``anthropic`` selects
    Anthropic's Messages API, any other value or none the OpenAI
    chat-completions API. ``max_tokens`` is Anthropic's ``max_tokens``; a
    chat-completions call sends none. ``timeout_s`` is per call; a local model
    on a laptop can take a while: two minutes by default. A durable run's work
    between two waits must end within the engine's max work (five minutes by
    default): the step in flight when it passes is run again, and a call
    longer than it never ends.
    """

    def __init__(
        self,
        *,
        proxy_url: str,
        virtual_key: str,
        model: str,
        provider: str | None = None,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        timeout_s: float = 120.0,
    ) -> None:
        root = proxy_url if proxy_url.endswith("/") else proxy_url + "/"
        self._anthropic = provider == ANTHROPIC_PROVIDER
        self._endpoint = urljoin(root, "v1/messages" if self._anthropic else "v1/chat/completions")
        self._virtual_key = virtual_key
        self.model = model
        self._max_tokens = max_tokens
        self._timeout_s = timeout_s
        host = httpx.URL(self._endpoint).host
        self.label = f"{model} through {host}, on Anthropic's Messages API" if self._anthropic else f"{model} through {host}"

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[Mapping[str, Any]],
        headers: Mapping[str, str],
        tool_choice: str = "auto",
    ) -> Completion:
        """One model call; ``headers`` (the trace headers) are merged in.

        ``tool_choice`` is ``auto``, the model may call the tools, or ``none``,
        it has to answer in words. With ``none`` a chat-completions call sends
        no tools at all; an Anthropic call sends the same tools with
        ``tool_choice`` ``none``, since a change to the tools would invalidate
        the thinking blocks already in the conversation.
        """
        extra: dict[str, str] = {}
        if self._anthropic:
            body = anthropic_request(
                model=self.model, max_tokens=self._max_tokens, messages=messages, tools=tools, tool_choice=tool_choice
            )
            # The virtual key as the bearer token, as on chat completions: the
            # proxy reads it there first, whatever the provider, and puts the
            # provider's own key in the header Anthropic reads.
            extra["anthropic-version"] = ANTHROPIC_VERSION
        else:
            body = {"model": self.model, "messages": list(messages), "stream": False}
            # No ``tools`` key at all when there are none: some providers reject an empty list.
            if tools and tool_choice != "none":
                body["tools"] = list(tools)
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            res = await client.post(
                self._endpoint,
                json=body,
                headers={"Authorization": f"Bearer {self._virtual_key}", **extra, **headers},
            )
        if res.status_code >= 400:
            raise RuntimeError(f"model call failed: {res.status_code} {res.text[:300]}".strip())
        if self._anthropic:
            return anthropic_completion(res.json())
        reply = res.json()
        choices = reply.get("choices") or []
        message = choices[0].get("message") if choices else None
        if not isinstance(message, dict):
            raise RuntimeError("model reply carries no choices[0].message")
        return Completion(message=message, usage=reply.get("usage"))


def anthropic_request(
    *,
    model: str,
    max_tokens: int,
    messages: Sequence[ChatMessage],
    tools: Sequence[Mapping[str, Any]],
    tool_choice: str,
) -> dict[str, Any]:
    """The Messages API request for a conversation in the chat-completions shape.

    System messages become the top-level ``system``. An assistant message goes
    back as the content blocks Anthropic returned for it, when it carries them,
    else as its text and its tool calls as ``tool_use`` blocks. A ``tool``
    message becomes a ``tool_result`` block in a user turn. Consecutive
    messages of one role join one turn, so a round's tool results arrive
    together, in one user turn, ahead of any text that follows them. Text that
    is empty or only whitespace is left out, among the returned blocks too: the
    API refuses such a block, and the check on replayed thinking ignores it.
    """
    system: list[str] = []
    turns: list[dict[str, Any]] = []

    def add(role: str, blocks: Sequence[Any]) -> None:
        if not blocks:
            return
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"].extend(blocks)
        else:
            turns.append({"role": role, "content": list(blocks)})

    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role == "system":
            if isinstance(content, str) and content.strip():
                system.append(content)
        elif role == "user":
            add("user", _text_blocks(content))
        elif role == "assistant":
            own = message.get("anthropic_content")
            if isinstance(own, list):
                add("assistant", [b for b in own if not _blank_text(b)])
            else:
                add("assistant", _text_blocks(content) + [_tool_use_block(c) for c in message.get("tool_calls") or []])
        elif role == "tool":
            result: dict[str, Any] = {"type": "tool_result", "tool_use_id": message.get("tool_call_id") or ""}
            if isinstance(content, str) and content != "":
                result["content"] = content
            add("user", [result])

    body: dict[str, Any] = {"model": model, "max_tokens": max_tokens}
    if system:
        body["system"] = "\n\n".join(system)
    body["messages"] = turns
    # No ``tools`` key when there are none; with tools, the call's choice.
    if tools:
        body["tools"] = [_anthropic_tool(t) for t in tools]
        body["tool_choice"] = {"type": tool_choice}
    return body


def _blank_text(block: Any) -> bool:
    """A text block whose text is empty or only whitespace."""
    return (
        isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
        and not block["text"].strip()
    )


def _text_blocks(content: Any) -> list[dict[str, Any]]:
    return [{"type": "text", "text": content}] if isinstance(content, str) and content.strip() else []


def _tool_use_block(call: Mapping[str, Any]) -> dict[str, Any]:
    function = call.get("function") or {}
    return {
        "type": "tool_use",
        "id": call.get("id") or "",
        "name": function.get("name", ""),
        "input": _tool_input(function.get("arguments", "{}")),
    }


def _tool_input(args: Any) -> dict[str, Any]:
    """A tool call's arguments as the object ``tool_use`` carries: ``{}`` when they are not a JSON object."""
    if isinstance(args, dict):
        return args
    try:
        parsed = json.loads(args) if isinstance(args, str) else None
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _anthropic_tool(tool: Mapping[str, Any]) -> dict[str, Any]:
    function = tool.get("function") or {}
    out: dict[str, Any] = {"name": function.get("name", "")}
    if function.get("description") is not None:
        out["description"] = function["description"]
    out["input_schema"] = function.get("parameters") or {"type": "object", "properties": {}}
    return out


def anthropic_completion(reply: Any) -> Completion:
    """The completion in the chat-completions shape for a Messages API reply.

    Its text blocks joined as the content, its ``tool_use`` blocks as tool
    calls, and all its blocks kept as ``anthropic_content`` for the next call
    of the turn. A refusal fails the call with its category; it is not an
    empty answer to ask again. A reply cut off at ``max_tokens`` fails too,
    naming ``MODEL_MAX_TOKENS``: half an answer is no reply, and a tool call
    cut off has arguments that never arrived whole. So does a conversation that
    outgrew the model's context window.
    """
    r = reply if isinstance(reply, dict) else {}
    if r.get("stop_reason") == "refusal":
        details = r.get("stop_details")
        category = details.get("category") if isinstance(details, dict) else None
        suffix = f": {category}" if isinstance(category, str) else ""
        raise RuntimeError(f"the model declined the request (refusal{suffix})")
    if r.get("stop_reason") == "max_tokens":
        raise RuntimeError("the model's reply was cut off at its token limit: raise MODEL_MAX_TOKENS, which counts thinking too")
    if r.get("stop_reason") == "model_context_window_exceeded":
        raise RuntimeError("the conversation no longer fits the model's context window")
    blocks = r.get("content")
    if not isinstance(blocks, list):
        raise RuntimeError("model reply carries no content")
    texts: list[str] = []
    calls: list[dict[str, Any]] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            texts.append(block["text"])
        if block.get("type") == "tool_use" and isinstance(block.get("id"), str) and isinstance(block.get("name"), str):
            calls.append(
                {
                    "id": block["id"],
                    "type": "function",
                    "function": {"name": block["name"], "arguments": json.dumps(block.get("input") or {})},
                }
            )
    text = "".join(texts)
    message: ChatMessage = {"role": "assistant", "content": text or None}
    if calls:
        message["tool_calls"] = calls
    message["anthropic_content"] = blocks
    return Completion(message=message, usage=_chat_usage(r.get("usage")))


def _chat_usage(usage: Any) -> dict[str, int] | None:
    """Anthropic's usage counted the chat-completions way: every input token, cached or not, as a prompt token."""
    if not isinstance(usage, dict):
        return None
    prompt = sum(int(usage.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    completion = int(usage.get("output_tokens") or 0)
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


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
        # The same tools every round; on the last permitted one the model may
        # not call them and has to answer.
        answer_only = round_ >= max_tool_rounds
        completion = await model.complete(
            messages, tools.definitions, trace_headers(), tool_choice="none" if answer_only else "auto"
        )
        model_calls += 1
        message = completion.message
        messages.append(message)
        # No tool runs on the answer-only round, nor for an agent shown none.
        calls = [] if answer_only or not tools.definitions else (message.get("tool_calls") or [])
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
