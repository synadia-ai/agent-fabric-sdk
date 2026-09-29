"""The whole agent, with a fake model behind a fake proxy: what leaves the
agent on the model side, and what it does with what comes back.

    caller  — an SDK client with tracing on
    agent   — ``start_agent()`` as ``python -m fabric_agent`` would run it,
              pointed at the fake
    target  — an agent that answers "pong: <prompt>" and reads references
    asker   — an agent that asks its caller a question before it answers
    fake    — ``tests/harness/fake_model.py``
    pad     — a ScratchPad in memory, in place of the one over the ``sp``
              command line (that one has its own test), recording commits,
              reads and grants

Asserted: the virtual key and the two trace headers on every model call, the
served thread on those headers, the three blocking tools offered by default,
the model's tool call carried out through ``prompt_agent`` with a child edge
under the served thread, the tool result put back in front of the model, a
question from the prompted agent put in front of the model and its
``answer_agent`` carried back, the reply to the caller, and the history on the
next prompt. And ScratchPad: the reply committed and the verified caller
granted read on it before the reference reaches it, a reference of the agent's
own handed on with a grant to the prompted agent under the model's call, a
handed-over reference read in front of the model, an unsigned caller given
words only. The same test as the TypeScript agent's ``test/agent.test.ts``.

And the grant request: the caller, granted the reply, asks the agent to let the
target read it, and the agent's code does; its model is never asked.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
from pathlib import Path
from typing import Any

import nats
import pytest
from synadia_ai.agent_fabric import READS_REFERENCES_KEY, Grantee, TraceIds, fabric_tracing, request_grant
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Agents, DiscoverFilter, Envelope, Identity, ProtocolError, ResponseChunk, signer_from_seed

from fabric_agent.agent import start_agent
from fabric_agent.config import AgentConfig, AgentIdentityConfig, ModelConfig, NatsConfig
from tests.harness.fake_model import FakeModel
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user


async def reply_text(stream) -> str:
    """The response chunks of one prompt, joined; the stream's own bookkeeping ignored."""
    parts: list[str] = []
    async for m in stream:
        if isinstance(m, ResponseChunk):
            parts.append(m.text)
    return "".join(parts)


class FakePad:
    """The agent's ScratchPad, in memory."""

    def __init__(self) -> None:
        self.commits: list[tuple[str, str, TraceIds | None]] = []
        self.reads: list[tuple[str, TraceIds | None]] = []
        self.grants: list[tuple[str, Grantee, TraceIds | None, str | None]] = []
        #: How each grant came about, by reference and grantee.
        self.kinds: dict[tuple[str, str], str] = {}

    @staticmethod
    def token(path: str) -> str:
        made = {"ref": {"type": "handoff", "handoff_id": "h", "volume_id": "vol-agent", "root": "r", "path": path, "expires_at": 9_000_000_000}, "source_sequence": 1}
        return "sp-ref:" + base64.urlsafe_b64encode(json.dumps(made).encode()).decode().rstrip("=")

    async def commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        self.commits.append((text, path, trace))
        return self.token(path)

    async def read(self, reference: str, trace: TraceIds | None) -> str:
        self.reads.append((reference, trace))
        return f"the content behind {reference[:16]}"

    async def owns(self, reference: str) -> bool:
        text = reference[len("sp-ref:"):]
        return b'"vol-agent"' in base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))

    async def grant_read(
        self, reference: str, grantee: Grantee, trace: TraceIds | None, tool_call_id: str | None = None, kind: str = "first-hand"
    ) -> None:
        self.grants.append((reference, grantee, trace, tool_call_id))
        self.kinds[(reference, grantee.user)] = kind

    def granted(self, reference: str, grantee: Grantee) -> str | None:
        if any(r == reference and g.user == grantee.user for r, g, _, _ in self.grants):
            return self.kinds[(reference, grantee.user)]
        return None


def words(reply: str) -> str:
    """A reply's words, without the reference appended after them."""
    return reply.split("\n\nsp-ref:")[0]


def reference(reply: str) -> str | None:
    m = re.search(r"sp-ref:[A-Za-z0-9_-]+$", reply)
    return m.group(0) if m else None


binary = nats_server_on_path()

# Tracing for the target and the caller, wired as the agent wires its own.
TRACING = fabric_tracing()


@pytest.mark.skipif(binary is None, reason="nats-server not on PATH")
async def test_the_agent_against_a_fake_model_behind_a_fake_proxy(tmp_path: Path) -> None:
    users = {name: new_user() for name in ("caller", "agent", "target")}
    server = LocalNatsServer.start(binary, list(users.values()))  # type: ignore[arg-type]
    fake = FakeModel().start()
    edges: list[dict[str, Any]] = []
    try:
        nc_caller = await nats.connect(server.url, nkeys_seed_str=users["caller"].seed)
        nc_target = await nats.connect(server.url, nkeys_seed_str=users["target"].seed)

        async def collect(msg: Any) -> None:
            edges.append(json.loads(msg.data))

        await nc_caller.subscribe("TRACE.edges", cb=collect)
        await nc_caller.flush()

        target = AgentService(
            agent="echo", owner="test", session_name="target", nc=nc_target,
            interceptors=[TRACING.request_interceptor],
            identity=ServiceIdentity(signer=signer_from_seed(users["target"].seed)), keepalive_interval_s=None,
            extra_metadata={READS_REFERENCES_KEY: "true"},
        )

        async def pong(envelope: Envelope, stream: PromptStream) -> None:
            await stream.send(f"pong: {envelope.prompt}")

        target.on_prompt(pong)
        await target.start()

        # An agent that asks before it answers, as a harness asks for a permission.
        asker = AgentService(
            agent="asker", owner="test", session_name="target", nc=nc_target,
            interceptors=[TRACING.request_interceptor],
            identity=ServiceIdentity(signer=signer_from_seed(users["target"].seed)), keepalive_interval_s=None,
        )
        answers: list[str] = []

        async def ask_first(envelope: Envelope, stream: PromptStream) -> None:
            answer = await stream.ask("may I read the file?", timeout=5)
            answers.append(answer.prompt)
            await stream.send(f"asked, and was told: {answer.prompt}")

        asker.on_prompt(ask_first)
        await asker.start()

        ready = tmp_path / "ready.json"
        cfg = AgentConfig(
            # The agent reads its credentials from a file, as in production.
            nats=NatsConfig(url=server.url, nkey=server.write_seed_file(users["agent"], "agent")),
            agent=AgentIdentityConfig(
                kind="assistant", owner="test", name="main", description="the agent under test",
                system_prompt="You are under test.", min_sender_trust="any", tools="blocking", heartbeat_interval_s=None,
                max_history_exchanges=20, ready_file=str(ready),
            ),
            model=ModelConfig(proxy_url=fake.url, virtual_key="vk-test", model="fake-1", timeout_s=None),
            reply_timeout_s=10.0,
        )
        pad = FakePad()
        agent = await start_agent(cfg, log=lambda _line: None, scratchpad=pad)  # type: ignore[arg-type]
        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_seed(users["caller"].seed)),
            interceptors=[TRACING.prompt_interceptor],
        )

        async def prompt(text: str) -> str:
            found = await caller.discover(timeout=0.5, filter=DiscoverFilter(agent="assistant"))
            assert found
            reply = await reply_text(found[0].prompt(text))
            await nc_caller.flush()
            await asyncio.sleep(0.3)
            return reply

        try:
            # On the fabric with a signed identity, and the ready file written.
            assert agent.address == "agents.prompt.assistant.test.main"
            assert re.search(r"\.U[A-Z2-7]{55}$", agent.identity or "")
            # With ScratchPad, its registration says it reads what it is handed.
            found = await caller.discover(timeout=0.5, filter=DiscoverFilter(agent="assistant"))
            assert found[0].metadata.get(READS_REFERENCES_KEY) == "true"
            written = json.loads(ready.read_text())
            assert {k: written[k] for k in ("agent", "owner", "name", "subject", "instance_id", "agent_id")} == {
                "agent": "assistant", "owner": "test", "name": "main", "subject": agent.address,
                "instance_id": agent.instance_id, "agent_id": agent.identity,
            }

            # The model through the proxy, with the key and the served thread's two headers.
            fake.requests.clear(); edges.clear()
            assert words(await prompt("hello there")) == "plain answer to: hello there"
            assert len(fake.requests) == 1
            req = fake.requests[0]
            assert req.headers["authorization"] == "Bearer vk-test"
            assert req.body["model"] == "fake-1"
            assert [t["function"]["name"] for t in req.body["tools"]] == ["discover_agents", "prompt_agent", "answer_agent"]
            assert all(t["type"] == "function" for t in req.body["tools"])
            root = next(e for e in edges if e["parent_id"] is None)
            assert req.headers["x-synadia-thread-id"] == root["thread_id"]
            assert req.headers["x-synadia-root-id"] == root["root_id"]

            # A prompt_agent call carried out as a child thread, its result back in front of the model.
            fake.requests.clear(); edges.clear()
            assert words(await prompt(f"please delegate to {target.subject.prompt}")) == "they said: pong: ping"
            assert len(fake.requests) == 2
            first, second = fake.requests
            assert second.headers["x-synadia-thread-id"] == first.headers["x-synadia-thread-id"]
            tool_msg = second.body["messages"][-1]
            assert tool_msg["role"] == "tool"
            assert tool_msg["tool_call_id"] == "call_fake_1"
            result = json.loads(tool_msg["content"])
            assert result.pop("call_id")
            assert result == {"state": "completed", "reply": "pong: ping"}
            root = next(e for e in edges if e["parent_id"] is None)
            child = next(e for e in edges if e["tool_call_id"] == "call_fake_1")
            assert child["parent_id"] == root["thread_id"]
            assert child["root_id"] == root["root_id"]
            assert child["turn_count_hint"] == 1
            assert first.headers["x-synadia-thread-id"] == root["thread_id"]

            # The conversation remembered as words, not tool traffic, and the
            # exchange that delegated says so, in one line: whom, not what.
            fake.requests.clear()
            await prompt("and one more")
            msgs = fake.requests[0].body["messages"]
            assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user", "assistant", "user"]
            assert not any(m["role"] == "tool" or m.get("tool_calls") for m in msgs)
            assert msgs[2]["content"] == "plain answer to: hello there"
            assert msgs[4]["content"] == f"[tools used: prompt_agent to {target.subject.prompt}]\nthey said: pong: ping"
            assert "call_" not in msgs[4]["content"]

            # A history per verified caller: another caller's exchanges are not shown.
            fake.requests.clear()
            other = Agents(
                nc=nc_target,
                identity=Identity(signer=signer_from_seed(users["target"].seed)),
                interceptors=[TRACING.prompt_interceptor],
            )
            try:
                for text in ("first from the other caller", "second from the other caller"):
                    found = await other.discover(timeout=0.5, filter=DiscoverFilter(agent="assistant"))
                    await reply_text(found[0].prompt(text))
            finally:
                await other.close()
            first, second = fake.requests
            assert [m["role"] for m in first.body["messages"]] == ["system", "user"]
            assert [m["content"] for m in second.body["messages"]] == [
                "You are under test.",
                "first from the other caller",
                "plain answer to: first from the other caller",
                "second from the other caller",
            ]

            # A question from the prompted agent goes in front of the model, and its answer_agent goes back.
            fake.requests.clear(); edges.clear()
            assert words(await prompt(f"please delegate to {asker.subject.prompt}")) == "they said: asked, and was told: yes"
            assert len(fake.requests) == 3
            _, second, third = fake.requests
            # The question came back as the result of prompt_agent, with the
            # call's id; while it waits for the answer the call is open, and the
            # result says so.
            asked = json.loads(second.body["messages"][-1]["content"])
            assert {k: asked[k] for k in ("state", "question", "open_calls")} == {
                "state": "input_required", "question": "may I read the file?", "open_calls": 1,
            }
            assert "Calls end with the prompt you are answering" in asked["open_calls_note"]
            # The model's answer went to the asking agent, and the reply came
            # back as the result of answer_agent, for the same call.
            assert answers == ["yes"]
            assert third.body["messages"][-1]["tool_call_id"] == "call_fake_2"
            assert json.loads(third.body["messages"][-1]["content"]) == {
                "call_id": asked["call_id"], "state": "completed", "reply": "asked, and was told: yes",
            }
            # One child thread, named after the call that started it.
            assert [e["tool_call_id"] for e in edges if e["tool_call_id"] is not None] == ["call_fake_1"]

            # An empty answer while that call waits is not the reply: the model is
            # told what waits and asked again, and its answer_agent goes through.
            fake.requests.clear(); answers.clear()
            assert words(await prompt(f"hush delegate to {asker.subject.prompt}: read it")) == "they said: asked, and was told: yes"
            assert answers == ["yes"]
            # prompt_agent, the empty answer, the word about the waiting call, answer_agent, the reply.
            assert len(fake.requests) == 4
            told = fake.requests[2].body["messages"][-1]
            assert told["role"] == "user"
            assert f'to {asker.subject.prompt} waits for an answer to "may I read the file?"' in told["content"]
            assert "answer it with answer_agent" in told["content"]

            # A model that keeps answering with nothing fails the prompt, saying why.
            fake.requests.clear(); pad.commits.clear()
            with pytest.raises(ProtocolError) as failed:
                await prompt(f"mute delegate to {asker.subject.prompt}: read it")
            assert "service error 500" in str(failed.value)
            assert "the model returned an empty reply 3 times while 1 call it started was still open" in str(failed.value)
            assert len(fake.requests) == 4
            assert pad.commits == []

            # Nothing open, and the model answers with nothing twice: the prompt fails, saying it gave no reply.
            fake.requests.clear(); pad.commits.clear()
            with pytest.raises(ProtocolError) as failed:
                await prompt("blank say something")
            assert "service error 500" in str(failed.value)
            assert "the model returned no reply: its answer was empty 2 times" in str(failed.value)
            assert len(fake.requests) == 2
            assert fake.requests[1].body["messages"][-1]["content"] == "Your last answer was empty. Answer the prompt you are serving in words."
            assert pad.commits == []

            # The reply committed, the verified caller granted read on it, and only then the reference appended.
            edges.clear(); pad.commits.clear(); pad.grants.clear()
            reply = await prompt("a plain question")
            root = next(e for e in edges if e["parent_id"] is None)
            assert pad.commits == [("plain answer to: a plain question", f"/replies/{root['thread_id']}.md", TraceIds(root["thread_id"], root["root_id"]))]
            assert len(pad.grants) == 1
            granted_ref, grantee, trace, _ = pad.grants[0]
            assert granted_ref == pad.token(f"/replies/{root['thread_id']}.md")
            assert grantee.user == users["caller"].public_key
            assert trace == TraceIds(root["thread_id"], root["root_id"])
            assert pad.kinds[(granted_ref, users["caller"].public_key)] == "first-hand"
            assert reference(reply) == granted_ref  # the reference the caller got is the one the grant is on

            # It answers a grant request about its reply in code: the caller it granted asks for the target.
            model_calls = len(fake.requests)
            answer = await request_grant(caller, agent.address, {"reference": granted_ref, "grantee": str(target.identity)})
            assert answer == {"granted": True}
            # The agent made the grant itself, to the target; its model was not asked.
            assert [g[1].user for g in pad.grants] == [users["caller"].public_key, str(target.identity).split(".")[1]]
            assert pad.grants[1][0] == granted_ref
            # Its record says which grant it made of its own accord and which on request.
            assert pad.kinds[(granted_ref, users["caller"].public_key)] == "first-hand"
            assert pad.kinds[(granted_ref, str(target.identity).split(".")[1])] == "on-request"
            assert len(fake.requests) == model_calls
            # Someone it never granted that reference to is refused.
            del pad.grants[1]
            other = Agents(nc=nc_target, identity=Identity(signer=signer_from_seed(users["target"].seed)))
            try:
                answer = await request_grant(other, agent.address, {"reference": granted_ref, "grantee": f"$G.{users['caller'].public_key}"})
            finally:
                await other.close()
            assert answer["granted"] is False and "no live read grant" in answer["reason"]
            assert len(pad.grants) == 1

            # A reference of its own, handed back by the caller, goes on to the
            # prompted agent with a read grant: first-hand, on the served
            # thread, under the model's call; then the caller's grant on the
            # new reply.
            edges.clear(); pad.grants.clear()
            own = pad.token("/replies/earlier.md")
            reply2 = await prompt(f"please delegate to {target.subject.prompt}: read {own}")
            assert words(reply2) == f"they said: pong: read {own}"
            root = next(e for e in edges if e["parent_id"] is None)
            assert len(pad.grants) == 2
            handed_ref, handed_to, handed_trace, handed_call = pad.grants[0]
            assert (handed_ref, handed_call) == (own, "call_fake_1")
            assert f"{handed_to.account}.{handed_to.user}" == str(target.identity)
            assert handed_trace == TraceIds(root["thread_id"], root["root_id"])
            assert pad.kinds[(own, handed_to.user)] == "first-hand"
            assert pad.grants[1][1].user == users["caller"].public_key

            # What it was handed by reference is read and put in front of the model.
            fake.requests.clear(); pad.reads.clear()
            token = pad.token("/replies/theirs.md")
            await prompt(f"summarise {token}")
            assert [r[0] for r in pad.reads] == [token]
            # The latest user message: the history holds the earlier prompts too.
            user = next(m for m in reversed(fake.requests[0].body["messages"]) if m["role"] == "user")
            assert f"summarise {token}" in user["content"]
            assert f"--- content handed over as {token} ---\nthe content behind sp-ref:" in user["content"]

            # An unsigned caller gets the reply in words only: no grant, no reference.
            pad.commits.clear(); pad.grants.clear(); fake.requests.clear()
            unsigned = Agents(nc=nc_caller, interceptors=[TRACING.prompt_interceptor])
            try:
                found = await unsigned.discover(timeout=0.5, filter=DiscoverFilter(agent="assistant"))
                assert await reply_text(found[0].prompt("hello, anonymously")) == "plain answer to: hello, anonymously"
            finally:
                await unsigned.close()
            assert len(pad.commits) == 1 and pad.grants == []
            # And no history: an unsigned claim names no caller to keep one for.
            assert [m["role"] for m in fake.requests[0].body["messages"]] == ["system", "user"]
        finally:
            await caller.close()
            await agent.stop()
            await target.stop()
            await asker.stop()
            await asyncio.gather(nc_caller.close(), nc_target.close())
    finally:
        fake.stop()
        server.stop()
