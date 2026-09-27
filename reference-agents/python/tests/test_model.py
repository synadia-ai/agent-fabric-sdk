"""converse(): the model loop, with a scripted model and scripted tools.

What is asserted here is when a turn ends: an empty answer while a call the
model started is still open is not the reply; the model is told what waits and
asked again, a bounded number of times, and then the turn fails instead of
answering with nothing. The twin of ``typescript/test/model.test.ts``.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from fabric_agent.model import ChatMessage, Completion, EmptyReplyError, OpenCall, converse

ASKER = "agents.prompt.asker.test.target"


class ScriptedModel:
    """Answers with the scripted messages in order, recording what it was sent."""

    label = "scripted"

    def __init__(self, script: list[ChatMessage]) -> None:
        self.script = script
        self.seen: list[list[ChatMessage]] = []

    async def complete(
        self, messages: Sequence[ChatMessage], tools: Sequence[Mapping[str, Any]], headers: Mapping[str, str]
    ) -> Completion:
        self.seen.append([dict(m) for m in messages])
        if not self.script:
            raise AssertionError("the model was called more often than scripted")
        return Completion(message=self.script.pop(0), usage=None)


class ScriptedTools:
    """Answers each call with the next scripted result, as JSON."""

    def __init__(self, results: list[dict[str, Any]]) -> None:
        self.results = results
        self.calls: list[str] = []
        self.definitions = [{"type": "function", "function": {"name": n}} for n in ("prompt_agent", "answer_agent", "wait_agent")]

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        self.calls.append(name)
        if not self.results:
            raise AssertionError("a tool was called more often than scripted")
        return json.dumps(self.results.pop(0))


def tool_call(call_id: str, name: str, args: dict[str, Any]) -> ChatMessage:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}],
    }


EMPTY: ChatMessage = {"role": "assistant", "content": None}


def words(text: str) -> ChatMessage:
    return {"role": "assistant", "content": text}


ASKED = {
    "call_id": "call_1",
    "state": "input_required",
    "question": "may I read the file?",
    "open_calls": 1,
    "open_calls_note": "1 call you started is still open.",
}


def start() -> list[ChatMessage]:
    return [{"role": "system", "content": "You are under test."}, {"role": "user", "content": "ask the asker"}]


def no_headers() -> dict[str, str]:
    return {}


async def test_an_empty_answer_while_a_call_waits_is_not_the_reply() -> None:
    model = ScriptedModel(
        [
            tool_call("t1", "prompt_agent", {"address": ASKER, "prompt": "read it"}),
            EMPTY,
            tool_call("t2", "answer_agent", {"call_id": "call_1", "answer": "yes"}),
            words("the asker read it"),
        ]
    )
    tools = ScriptedTools([ASKED, {"call_id": "call_1", "state": "completed", "reply": "done"}])
    messages = start()
    result = await converse(model=model, tools=tools, messages=messages, trace_headers=no_headers)  # type: ignore[arg-type]

    assert (result.reply, result.model_calls, result.tool_calls) == ("the asker read it", 4, 2)
    assert tools.calls == ["prompt_agent", "answer_agent"]
    nudge = model.seen[2][-1]
    assert nudge["role"] == "user"
    assert f'call_1 to {ASKER} waits for an answer to "may I read the file?"' in nudge["content"]
    assert "answer it with answer_agent" in nudge["content"]
    assert not any(m["role"] == "assistant" and m.get("content") is None and not m.get("tool_calls") for m in messages)


async def test_the_turn_fails_after_the_bound_saying_which_calls_were_open() -> None:
    model = ScriptedModel([tool_call("t1", "prompt_agent", {"address": ASKER, "prompt": "read it"}), EMPTY, EMPTY, EMPTY])
    with pytest.raises(EmptyReplyError) as failed:
        await converse(model=model, tools=ScriptedTools([ASKED]), messages=start(), trace_headers=no_headers)  # type: ignore[arg-type]
    err = failed.value
    assert err.empty_replies == 3
    assert err.open_calls == [OpenCall(call_id="call_1", state="input_required", address=ASKER, question="may I read the file?")]
    assert str(err) == (
        "the model returned an empty reply 3 times while 1 call it started was still open "
        f'(call_1 to {ASKER} waits for an answer to "may I read the file?"); no reply was produced'
    )
    assert len(model.seen) == 4


async def test_the_bound_is_max_empty_replies_and_whitespace_is_empty() -> None:
    model = ScriptedModel([tool_call("t1", "prompt_agent", {"address": ASKER, "prompt": "x"}), words("  \n")])
    with pytest.raises(EmptyReplyError) as failed:
        await converse(
            model=model,  # type: ignore[arg-type]
            tools=ScriptedTools([ASKED]),
            messages=start(),
            trace_headers=no_headers,
            max_empty_replies=0,
        )
    assert failed.value.empty_replies == 1


async def test_a_running_call_is_open_and_the_model_is_told_to_collect_it() -> None:
    model = ScriptedModel(
        [
            tool_call("t1", "prompt_agent", {"address": ASKER, "prompt": "x", "wait": False}),
            EMPTY,
            tool_call("t2", "wait_agent", {"call_ids": ["call_1"]}),
            words("collected"),
        ]
    )
    tools = ScriptedTools(
        [{"call_id": "call_1", "state": "running"}, {"calls": [{"call_id": "call_1", "state": "completed", "reply": "r"}]}]
    )
    result = await converse(model=model, tools=tools, messages=start(), trace_headers=no_headers)  # type: ignore[arg-type]
    assert result.reply == "collected"
    assert f"call_1 to {ASKER} is still running: collect its result before you answer" in model.seen[2][-1]["content"]


NO_REPLY = "Your last answer was empty. Answer the prompt you are serving in words."


async def test_an_empty_answer_with_nothing_open_is_not_the_reply_either() -> None:
    model = ScriptedModel([EMPTY, words("here it is")])
    messages = start()
    result = await converse(model=model, tools=ScriptedTools([]), messages=messages, trace_headers=no_headers)  # type: ignore[arg-type]
    assert (result.reply, result.model_calls, result.tool_calls) == ("here it is", 2, 0)
    assert model.seen[1][-1] == {"role": "user", "content": NO_REPLY}
    assert not any(m["role"] == "assistant" and m.get("content") is None for m in messages)


async def test_a_second_empty_answer_with_nothing_open_fails_the_turn() -> None:
    model = ScriptedModel([EMPTY, words(" ")])
    with pytest.raises(EmptyReplyError) as failed:
        await converse(model=model, tools=ScriptedTools([]), messages=start(), trace_headers=no_headers)  # type: ignore[arg-type]
    assert str(failed.value) == "the model returned no reply: its answer was empty 2 times"
    assert failed.value.open_calls == []
    assert len(model.seen) == 2


async def test_with_max_empty_replies_zero_the_first_empty_answer_fails() -> None:
    with pytest.raises(EmptyReplyError) as failed:
        await converse(
            model=ScriptedModel([EMPTY]),  # type: ignore[arg-type]
            tools=ScriptedTools([]),
            messages=start(),
            trace_headers=no_headers,
            max_empty_replies=0,
        )
    assert str(failed.value) == "the model returned no reply: its answer was empty once"


async def test_the_rule_applies_once_the_call_has_ended() -> None:
    model = ScriptedModel(
        [
            tool_call("t1", "prompt_agent", {"address": ASKER, "prompt": "x"}),
            tool_call("t2", "answer_agent", {"call_id": "call_1", "answer": "yes"}),
            EMPTY,
            EMPTY,
        ]
    )
    tools = ScriptedTools([ASKED, {"call_id": "call_1", "state": "failed", "error": "gone"}])
    with pytest.raises(EmptyReplyError) as failed:
        await converse(model=model, tools=tools, messages=start(), trace_headers=no_headers)  # type: ignore[arg-type]
    assert str(failed.value) == "the model returned no reply: its answer was empty 2 times"
    assert model.seen[3][-1]["content"] == NO_REPLY
