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


async def converse(
    *,
    model: ModelClient,
    tools: ToolRunner,
    messages: list[ChatMessage],
    trace_headers: Callable[[], Mapping[str, str]],
    max_tool_rounds: int = 8,
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
    """
    say = log or (lambda _line: None)
    model_calls = 0
    tool_calls = 0
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
            return ConverseResult(reply=message.get("content") or "", model_calls=model_calls, tool_calls=tool_calls)
        for call in calls:
            function = call.get("function") or {}
            name = function.get("name", "")
            arguments = function.get("arguments", "{}")
            call_id = call.get("id") or f"call_{tool_calls + 1}"
            say(f"  {name}({str(arguments)[:120]}) [{call_id}]")
            content = await tools.call(name, arguments, call_id)
            tool_calls += 1
            messages.append({"role": "tool", "tool_call_id": call_id, "content": content})
        round_ += 1


__all__ = [
    "ChatMessage",
    "Completion",
    "ConverseResult",
    "ModelClient",
    "ToolRunner",
    "converse",
]
