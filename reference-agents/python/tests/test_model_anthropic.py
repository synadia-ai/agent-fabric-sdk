"""The model client on Anthropic's Messages API (MODEL_PROVIDER=anthropic).

The conversation translated from the chat-completions shape and back, the
request as it reaches the proxy, and the last round's tools. The proxy meters
an Anthropic call only on /v1/messages, so this is what puts the agent's tokens
and content on its thread. The twin of ``typescript/test/model-anthropic.test.ts``.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator, Mapping, Sequence
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import pytest

from fabric_agent.config import load_config
from fabric_agent.model import (
    ANTHROPIC_VERSION,
    DEFAULT_MAX_TOKENS,
    ChatMessage,
    Completion,
    ModelClient,
    anthropic_completion,
    anthropic_request,
    api_of,
    converse,
)

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "prompt_agent",
            "description": "Ask another agent.",
            "parameters": {"type": "object", "properties": {"address": {"type": "string"}}, "required": ["address"]},
            "strict": False,
        },
    }
]


def test_system_on_top_tool_calls_as_tool_use_and_a_rounds_results_in_one_user_turn() -> None:
    messages: list[ChatMessage] = [
        {"role": "system", "content": "You are under test."},
        {"role": "user", "content": "ask two agents"},
        {
            "role": "assistant",
            "content": "Asking both.",
            "tool_calls": [
                {"id": "toolu_1", "type": "function", "function": {"name": "prompt_agent", "arguments": '{"address":"a"}'}},
                {"id": "toolu_2", "type": "function", "function": {"name": "prompt_agent", "arguments": '{"address":"b"}'}},
            ],
        },
        {"role": "tool", "tool_call_id": "toolu_1", "content": '{"state":"completed"}'},
        {"role": "tool", "tool_call_id": "toolu_2", "content": '{"state":"completed"}'},
        {"role": "user", "content": "Your last answer was empty."},
    ]
    body = anthropic_request(model="claude-sonnet-5-5", max_tokens=100, messages=messages, tools=TOOLS, tool_choice="auto")
    assert body == {
        "model": "claude-sonnet-5-5",
        "max_tokens": 100,
        "system": "You are under test.",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "ask two agents"}]},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Asking both."},
                    {"type": "tool_use", "id": "toolu_1", "name": "prompt_agent", "input": {"address": "a"}},
                    {"type": "tool_use", "id": "toolu_2", "name": "prompt_agent", "input": {"address": "b"}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": '{"state":"completed"}'},
                    {"type": "tool_result", "tool_use_id": "toolu_2", "content": '{"state":"completed"}'},
                    {"type": "text", "text": "Your last answer was empty."},
                ],
            },
        ],
        "tools": [
            {
                "name": "prompt_agent",
                "description": "Ask another agent.",
                "input_schema": {"type": "object", "properties": {"address": {"type": "string"}}, "required": ["address"]},
            }
        ],
        "tool_choice": {"type": "auto"},
    }


def test_an_assistant_messages_own_blocks_go_back_unchanged_thinking_included() -> None:
    blocks = [
        {"type": "thinking", "thinking": "", "signature": "sig-1"},
        {"type": "tool_use", "id": "toolu_1", "name": "prompt_agent", "input": {"address": "a"}},
    ]
    messages: list[ChatMessage] = [
        {"role": "user", "content": "ask a"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [{"id": "toolu_1", "type": "function", "function": {"name": "prompt_agent", "arguments": '{"address":"a"}'}}],
            "anthropic_content": blocks,
        },
        {"role": "tool", "tool_call_id": "toolu_1", "content": "done"},
    ]
    body = anthropic_request(model="m", max_tokens=1, messages=messages, tools=TOOLS, tool_choice="auto")
    assert body["messages"][1] == {"role": "assistant", "content": blocks}


def test_an_answer_only_call_keeps_the_tools_and_says_none_and_no_tools_sends_neither_key() -> None:
    messages: list[ChatMessage] = [{"role": "user", "content": "hi"}]
    none = anthropic_request(model="m", max_tokens=1, messages=messages, tools=TOOLS, tool_choice="none")
    assert none["tool_choice"] == {"type": "none"}
    assert len(none["tools"]) == 1
    bare = anthropic_request(model="m", max_tokens=1, messages=messages, tools=[], tool_choice="none")
    assert "tools" not in bare and "tool_choice" not in bare and "system" not in bare


def test_empty_or_whitespace_text_and_an_empty_results_content_are_left_out() -> None:
    messages: list[ChatMessage] = [
        {"role": "system", "content": "  "},
        {"role": "user", "content": "hi"},
        {
            "role": "assistant",
            "content": " \n",
            "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "prompt_agent", "arguments": "not json"}}],
        },
        {"role": "tool", "tool_call_id": "t1", "content": ""},
    ]
    body = anthropic_request(model="m", max_tokens=1, messages=messages, tools=TOOLS, tool_choice="auto")
    assert "system" not in body
    assert body["messages"] == [
        {"role": "user", "content": [{"type": "text", "text": "hi"}]},
        {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "prompt_agent", "input": {}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1"}]},
    ]


def test_a_tool_without_a_schema_or_with_an_empty_one_gets_the_empty_object_schema() -> None:
    body = anthropic_request(
        model="m",
        max_tokens=1,
        messages=[{"role": "user", "content": "x"}],
        tools=[
            {"type": "function", "function": {"name": "ping"}},
            {"type": "function", "function": {"name": "pong", "parameters": {}}},
        ],
        tool_choice="auto",
    )
    assert body["tools"] == [
        {"name": "ping", "input_schema": {"type": "object", "properties": {}}},
        {"name": "pong", "input_schema": {"type": "object", "properties": {}}},
    ]


def test_a_whitespace_only_text_block_is_left_out_of_the_blocks_sent_back() -> None:
    thinking = {"type": "thinking", "thinking": "", "signature": "sig"}
    use = {"type": "tool_use", "id": "t1", "name": "prompt_agent", "input": {}}
    messages: list[ChatMessage] = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": None, "anthropic_content": [thinking, {"type": "text", "text": "\n\n"}, use]},
        {"role": "tool", "tool_call_id": "t1", "content": "done"},
    ]
    body = anthropic_request(model="m", max_tokens=1, messages=messages, tools=TOOLS, tool_choice="auto")
    assert body["messages"][1] == {"role": "assistant", "content": [thinking, use]}


def test_a_reply_joins_its_text_turns_tool_use_into_calls_keeps_every_block_and_counts_usage() -> None:
    content = [
        {"type": "thinking", "thinking": "", "signature": "sig"},
        {"type": "text", "text": "Asking "},
        {"type": "text", "text": "a."},
        {"type": "tool_use", "id": "toolu_9", "name": "prompt_agent", "input": {"address": "a"}},
    ]
    completion = anthropic_completion(
        {
            "content": content,
            "stop_reason": "tool_use",
            "usage": {"input_tokens": 10, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 20, "output_tokens": 7},
        }
    )
    assert completion.message == {
        "role": "assistant",
        "content": "Asking a.",
        "tool_calls": [{"id": "toolu_9", "type": "function", "function": {"name": "prompt_agent", "arguments": '{"address": "a"}'}}],
        "anthropic_content": content,
    }
    assert json.loads(completion.message["tool_calls"][0]["function"]["arguments"]) == {"address": "a"}
    assert completion.usage == {"prompt_tokens": 35, "completion_tokens": 7, "total_tokens": 42}


def test_a_reply_without_text_has_no_content_so_the_loop_sees_an_empty_answer() -> None:
    completion = anthropic_completion({"content": [{"type": "thinking", "thinking": "", "signature": "s"}], "stop_reason": "end_turn"})
    assert completion.message["content"] is None
    assert "tool_calls" not in completion.message


def test_a_refusal_fails_naming_its_category() -> None:
    with pytest.raises(RuntimeError, match=r"the model declined the request \(refusal: cyber\)"):
        anthropic_completion({"content": [], "stop_reason": "refusal", "stop_details": {"type": "refusal", "category": "cyber"}})
    with pytest.raises(RuntimeError, match=r"the model declined the request \(refusal\)$"):
        anthropic_completion({"content": [], "stop_reason": "refusal", "stop_details": None})


@pytest.mark.parametrize(
    "content",
    [
        [{"type": "thinking", "thinking": "", "signature": "s"}],
        [{"type": "text", "text": "Half an ans"}],
        [{"type": "tool_use", "id": "t", "name": "prompt_agent", "input": {}}],
    ],
)
def test_a_reply_cut_off_at_max_tokens_fails_naming_model_max_tokens(content: list[Any]) -> None:
    with pytest.raises(RuntimeError, match="raise MODEL_MAX_TOKENS"):
        anthropic_completion({"content": content, "stop_reason": "max_tokens"})


def test_a_conversation_past_the_context_window_fails() -> None:
    with pytest.raises(RuntimeError, match="context window"):
        anthropic_completion({"content": [], "stop_reason": "model_context_window_exceeded"})


def test_a_null_usage_is_none() -> None:
    assert anthropic_completion({"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn", "usage": None}).usage is None


def test_a_reply_without_content_fails() -> None:
    with pytest.raises(RuntimeError, match="model reply carries no content"):
        anthropic_completion({"error": {"type": "overloaded_error"}})


class _StandIn:
    """A stand-in proxy on a free port: records each request and answers with the next scripted reply."""

    def __init__(self, replies: list[Any], status: int = 200) -> None:
        self.replies = replies
        self.seen: list[dict[str, Any]] = []
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                stand_in.seen.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": json.loads(raw)})
                payload = json.dumps(stand_in.replies.pop(0) if stand_in.replies else {}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def stand_in() -> Iterator[list[_StandIn]]:
    made: list[_StandIn] = []
    yield made
    for s in made:
        s.close()


async def test_with_the_provider_anthropic_it_posts_to_v1_messages_with_key_version_and_trace_headers(
    stand_in: list[_StandIn],
) -> None:
    proxy = _StandIn([{"content": [{"type": "text", "text": "Hello."}], "stop_reason": "end_turn", "usage": {"input_tokens": 3, "output_tokens": 2}}])
    stand_in.append(proxy)
    client = ModelClient(proxy_url=proxy.url, virtual_key="sk_syn_test", model="claude-sonnet-5-5", provider="anthropic")
    assert "Anthropic's Messages API" in client.label
    completion = await client.complete(
        [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "hi"}],
        TOOLS,
        {"X-Synadia-Thread-ID": "t" * 32, "X-Synadia-Root-ID": "r" * 32},
    )
    assert completion.message["content"] == "Hello."
    assert completion.usage == {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    [call] = proxy.seen
    assert call["path"] == "/v1/messages"
    assert call["headers"]["authorization"] == "Bearer sk_syn_test"
    assert call["headers"]["anthropic-version"] == ANTHROPIC_VERSION
    assert call["headers"]["x-synadia-thread-id"] == "t" * 32
    assert call["headers"]["x-synadia-root-id"] == "r" * 32
    assert call["body"]["model"] == "claude-sonnet-5-5"
    assert call["body"]["max_tokens"] == DEFAULT_MAX_TOKENS
    assert call["body"]["system"] == "Be brief."
    assert call["body"]["messages"] == [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
    assert call["body"]["tool_choice"] == {"type": "auto"}


async def test_max_tokens_is_sent_as_max_tokens(stand_in: list[_StandIn]) -> None:
    proxy = _StandIn([{"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"}])
    stand_in.append(proxy)
    client = ModelClient(proxy_url=proxy.url + "/", virtual_key="k", model="m", provider="anthropic", max_tokens=512)
    await client.complete([{"role": "user", "content": "hi"}], [], {})
    assert proxy.seen[0]["body"]["max_tokens"] == 512


async def test_a_failed_call_fails_with_the_proxys_answer(stand_in: list[_StandIn]) -> None:
    proxy = _StandIn([{"error": "unknown virtual key"}], status=401)
    stand_in.append(proxy)
    client = ModelClient(proxy_url=proxy.url, virtual_key="k", model="m", provider="anthropic")
    with pytest.raises(RuntimeError, match="model call failed: 401"):
        await client.complete([{"role": "user", "content": "hi"}], [], {})


async def test_any_other_provider_stays_on_chat_completions_and_an_answer_only_call_sends_no_tools(
    stand_in: list[_StandIn],
) -> None:
    reply = {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}
    proxy = _StandIn([reply, reply])
    stand_in.append(proxy)
    for provider in (None, "openrouter"):
        client = ModelClient(proxy_url=proxy.url, virtual_key="k", model="m", provider=provider)
        await client.complete([{"role": "user", "content": "hi"}], TOOLS, {}, tool_choice="none")
    assert [s["path"] for s in proxy.seen] == ["/v1/chat/completions", "/v1/chat/completions"]
    for s in proxy.seen:
        assert "tools" not in s["body"] and "max_tokens" not in s["body"]
        assert "anthropic-version" not in s["headers"]


ENV = {"MODEL_PROXY_URL": "http://proxy", "MODEL_VIRTUAL_KEY": "vk", "MODEL_NAME": "m", "NATS_CREDS": "/dev/null"}


def test_model_provider_is_read_trimmed_in_lower_case_and_none_when_unset() -> None:
    assert load_config(ENV).model.provider is None
    assert load_config({**ENV, "MODEL_PROVIDER": " Anthropic "}).model.provider == "anthropic"
    assert load_config({**ENV, "MODEL_PROVIDER": "openrouter"}).model.provider == "openrouter"


def test_model_max_tokens_is_a_whole_number_above_0_and_none_when_unset() -> None:
    assert load_config(ENV).model.max_tokens is None
    assert load_config({**ENV, "MODEL_MAX_TOKENS": "512"}).model.max_tokens == 512
    assert load_config({**ENV, "MODEL_MAX_TOKENS": "16000.0"}).model.max_tokens == 16000


@pytest.mark.parametrize("value", ["0", "-1", "2.5", "abc", " "])
def test_model_max_tokens_refuses_what_is_no_whole_number_above_0(value: str) -> None:
    with pytest.raises(ValueError, match="MODEL_MAX_TOKENS must be a whole number above 0"):
        load_config({**ENV, "MODEL_MAX_TOKENS": value})


def test_the_startup_line_names_the_api() -> None:
    assert api_of("anthropic") == "Anthropic's Messages API"
    assert api_of("openrouter") == "the OpenAI chat-completions API"
    assert api_of(None) == "the OpenAI chat-completions API"


class _Once:
    label = "scripted"

    def __init__(self, message: ChatMessage) -> None:
        self.message = message

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[Mapping[str, Any]],
        headers: Mapping[str, str],
        tool_choice: str = "auto",
    ) -> Completion:
        return Completion(message=dict(self.message), usage=None)


class _Ran:
    def __init__(self, definitions: list[dict[str, Any]]) -> None:
        self.definitions = definitions
        self.ran: list[str] = []

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        self.ran.append(name)
        return "{}"


_WORDS_AND_A_CALL: ChatMessage = {
    "role": "assistant",
    "content": "Words.",
    "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "prompt_agent", "arguments": '{"address":"a"}'}}],
}


async def test_on_the_answer_only_round_a_tool_call_is_not_run_and_the_words_are_the_reply() -> None:
    tools = _Ran(TOOLS)
    result = await converse(
        model=_Once(_WORDS_AND_A_CALL),  # type: ignore[arg-type]
        tools=tools,
        messages=[{"role": "user", "content": "go"}],
        trace_headers=lambda: {},
        max_tool_rounds=0,
    )
    assert tools.ran == []
    assert (result.reply, result.model_calls, result.tool_calls) == ("Words.", 1, 0)


async def test_for_an_agent_shown_no_tools_a_tool_call_is_not_run() -> None:
    tools = _Ran([])
    result = await converse(
        model=_Once(_WORDS_AND_A_CALL),  # type: ignore[arg-type]
        tools=tools,
        messages=[{"role": "user", "content": "go"}],
        trace_headers=lambda: {},
    )
    assert tools.ran == []
    assert result.reply == "Words."


class _Recording:
    label = "scripted"

    def __init__(self, script: list[ChatMessage]) -> None:
        self.script = script
        self.choices: list[str] = []
        self.tools_seen: list[int] = []

    async def complete(
        self,
        messages: Sequence[ChatMessage],
        tools: Sequence[Mapping[str, Any]],
        headers: Mapping[str, str],
        tool_choice: str = "auto",
    ) -> Completion:
        self.choices.append(tool_choice)
        self.tools_seen.append(len(tools))
        return Completion(message=self.script.pop(0), usage=None)


class _Tools:
    definitions = TOOLS

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        return '{"state":"completed"}'


async def test_on_the_last_permitted_round_the_model_sees_the_same_tools_with_tool_choice_none() -> None:
    model = _Recording(
        [
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "prompt_agent", "arguments": '{"address":"a"}'}}],
            },
            {"role": "assistant", "content": "Done."},
        ]
    )
    result = await converse(
        model=model,  # type: ignore[arg-type]
        tools=_Tools(),
        messages=[{"role": "user", "content": "go"}],
        trace_headers=lambda: {},
        max_tool_rounds=1,
    )
    assert (result.reply, result.model_calls, result.tool_calls) == ("Done.", 2, 1)
    assert model.choices == ["auto", "none"]
    assert model.tools_seen == [1, 1]
