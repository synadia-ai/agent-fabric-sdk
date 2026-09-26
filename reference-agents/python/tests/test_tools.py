"""The agent tools as the agent wires them, tested on a real nats-server: five
parties on one server, each with its own user key, the way agents sit in one
account.

    caller  — an SDK client with tracing on; it prompts ``host`` and so
              starts a tree (a root edge, parent null)
    host    — the agent under test, wired as ``agent.py`` wires it: the SDK's
              ``AgentTools`` with the fabric package's ScratchPad extension,
              the three request interceptors in the agent's order, and the
              grant endpoint. Its prompt handler does what a model loop would:
              one model call's worth of trace headers, then the tool call the
              prompt names, through ``tool_runner()``
    target  — an agent that answers "pong: <prompt>", accepts signed prompts
              only, and says it reads ScratchPad references
    leaf    — a signed agent that does not say so, as PI does not: it gets
              the text without the references
    creator — an agent that handed the host a reference into its own volume,
              and answers grant requests about it

What is asserted is the whole point of the tools on the fabric: the edge
``prompt_agent`` writes from inside the served prompt names the served thread
as its parent, the tree root as its root and the model's tool-call id. And the
grant that goes with a handed-over reference: to the target's verified
identity, under the served thread and the tool call, before the prompt goes
out; no reference, nor a grant, for an agent that does not read references; no
reference this agent was not given, exactly as it came. And for a reference
the host did not create: the creator is asked and makes the grant itself, or
the reference comes out and the text goes alone. The rules are the fabric
package's and tested there line by line; here they are tested through the
agent's wiring. The same test as the TypeScript agent's ``test/tools.test.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
from typing import Any

import nats
import pytest
from jsonschema import Draft202012Validator
from synadia_ai.agent_fabric import (
    READS_REFERENCES_KEY,
    Grantee,
    TraceIds,
    fabric_tracing,
    grant_request_endpoint,
    grantee_from_identity,
    scratch_pad_extension,
    trace_headers,
)
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import (
    Agents,
    AgentSubject,
    AgentTools,
    DiscoverFilter,
    Envelope,
    Identity,
    ResponseChunk,
    signer_from_seed,
)

from fabric_agent.tools import BLOCKING_TOOLS, chat_tools, offered_tools, tool_runner
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user

# Tracing as every agent here wires it: the request interceptor on each
# service, the prompt interceptor on each client that prompts.
TRACING = fabric_tracing()

# The contract's own files, in the SDK checkout this repository links: the
# definitions a model reads and the shapes of what comes back.
CONTRACT_DIR = Path(__file__).resolve().parents[4] / "synadia-agents" / "test-fixtures" / "agent-tools"


def contract(name: str) -> dict[str, Any]:
    return json.loads((CONTRACT_DIR / name).read_text(encoding="utf-8"))


DISCOVER_RESULT = Draft202012Validator(contract("discover_agents.result.json"))
CALL_RESULT = Draft202012Validator(contract("prompt_agent.result.json"))
TOOL_NAMES = ["discover_agents", "prompt_agent", "wait_agent", "answer_agent", "cancel_agent", "list_agent_calls"]


async def reply_text(stream) -> str:
    """The response chunks of one prompt, joined; the stream's own bookkeeping ignored."""
    parts: list[str] = []
    async for m in stream:
        if isinstance(m, ResponseChunk):
            parts.append(m.text)
    return "".join(parts)


def assert_valid(validator: Draft202012Validator, value: Any) -> None:
    errors = [e.message for e in validator.iter_errors(value)]
    assert not errors, errors


class FakePad:
    """A ScratchPad as the extension and the grant endpoint see it: every grant
    made, which references are its own, and whom it says it granted."""

    def __init__(self, *, owns_listed: bool) -> None:
        self.grants: list[tuple[str, Grantee, TraceIds | None, str | None, str]] = []
        #: References into the creator's volume: the creator owns exactly
        #: these, the host everything else.
        self.listed: set[str] = set()
        self._owns_listed = owns_listed
        self.granted_requester = True

    def owns(self, reference: str) -> bool:
        return (reference in self.listed) == self._owns_listed

    def granted(self, reference: str, grantee: Grantee) -> str | None:
        return "first-hand" if self.granted_requester else None

    def grant_read(
        self, reference: str, grantee: Grantee, trace: TraceIds | None, tool_call_id: str | None = None, kind: str = "first-hand"
    ) -> None:
        self.grants.append((reference, grantee, trace, tool_call_id, kind))


def derived(names: list[str] | tuple[str, ...]) -> list[dict[str, Any]]:
    """The definitions a helper that offers ``names`` shows its model, derived
    from the contract's files by its rule (section 5): those tools' files, in
    the contract's order. Without ``wait_agent``, each loses its ``wait``
    parameter, and a description that mentions ``wait_agent`` is replaced by
    its words in ``blocking.json``. Nothing else changes."""
    blocking = contract("blocking.json")
    out = []
    for name in (n for n in TOOL_NAMES if n in names):
        definition = contract(f"{name}.json")
        if "wait_agent" not in names:
            definition["parameters"]["properties"].pop("wait", None)
            definition["description"] = blocking.get(name, definition["description"])
        out.append(definition)
    return out


# Definitions need no connection: the helper hands out its own copy.
def offered_by(setting: str) -> list[dict[str, Any]]:
    return chat_tools(AgentTools(None, tools=offered_tools(setting)))  # type: ignore[arg-type]


def test_definitions_are_by_default_the_sdks_three_blocking_ones_not_a_word_changed() -> None:
    offered = offered_by("blocking")
    assert [t["function"]["name"] for t in offered] == ["discover_agents", "prompt_agent", "answer_agent"]
    assert [t["function"]["name"] for t in offered] == list(BLOCKING_TOOLS)
    assert all(t["type"] == "function" for t in offered)
    # Word for word what the contract derives for the three: nothing to detach
    # with, so no ``wait``, and no word of a tool not offered.
    assert [t["function"] for t in offered] == derived(BLOCKING_TOOLS)
    text = json.dumps(offered)
    assert not any(word in text for word in ("wait_agent", "cancel_agent", "list_agent_calls", '"wait"'))
    tools = AgentTools(None, tools=offered_tools("blocking"))  # type: ignore[arg-type]
    assert tool_runner(tools).definitions == chat_tools(tools)


def test_definitions_are_the_sdks_six_with_all_word_for_word_the_contracts_files() -> None:
    offered = offered_by("all")
    assert [t["function"]["name"] for t in offered] == TOOL_NAMES
    for tool in offered:
        assert tool["type"] == "function"
        assert tool["function"] == contract(f"{tool['function']['name']}.json")
    assert [t["function"] for t in offered] == derived(TOOL_NAMES)


def test_parameter_schemas_compile_and_admit_nothing_unknown() -> None:
    detached = {"address": "agents.prompt.echo.test.target", "prompt": "hi", "wait": False}
    for setting, takes_wait in (("blocking", False), ("all", True)):
        offered = offered_by(setting)
        for tool in offered:
            params = tool["function"]["parameters"]
            Draft202012Validator.check_schema(params)
            assert params["additionalProperties"] is False
            assert not Draft202012Validator(params).is_valid({"unknown": 1})
        prompt = Draft202012Validator(next(t for t in offered if t["function"]["name"] == "prompt_agent")["function"]["parameters"])
        assert prompt.is_valid({"address": "agents.prompt.echo.test.target", "prompt": "hi"})
        assert not prompt.is_valid({"address": "agents.prompt.echo.test.target"})
        assert not prompt.is_valid({"address": "agents.prompt.echo.test.target", "prompt": ""})
        # Only the six take ``wait: false``.
        assert prompt.is_valid(detached) is takes_wait


binary = nats_server_on_path()


@pytest.mark.skipif(binary is None, reason="nats-server not on PATH")
async def test_the_agent_tools_on_a_fabric() -> None:
    users = {name: new_user() for name in ("caller", "host", "target", "creator")}
    server = LocalNatsServer.start(binary, list(users.values()))  # type: ignore[arg-type]
    edges: list[dict[str, Any]] = []
    served: dict[str, str] = {}
    try:
        nc_caller, nc_host, nc_target, nc_creator = await asyncio.gather(
            *(nats.connect(server.url, nkeys_seed_str=users[w].seed) for w in ("caller", "host", "target", "creator"))
        )

        # Watch the edges before anyone prompts. ``TRACE.edges`` is the short
        # form an agent publishes to; on a real fabric the account's import
        # carries it into the AFO account.
        async def collect(msg: Any) -> None:
            edges.append({"record": json.loads(msg.data), "headers": dict(msg.headers or {})})

        await nc_caller.subscribe("TRACE.edges", cb=collect)
        await nc_caller.flush()

        # The target: answers, accepts signed prompts only, reads references.
        target = AgentService(
            agent="echo", owner="test", session_name="target", nc=nc_target, description="Answers pong",
            interceptors=[TRACING.request_interceptor], identity=ServiceIdentity(signer=signer_from_seed(users["target"].seed)),
            min_sender_trust="signed", keepalive_interval_s=None,
            extra_metadata={READS_REFERENCES_KEY: "true"},
        )

        async def pong(envelope: Envelope, stream: PromptStream) -> None:
            trace_headers()
            # One prompt gets a reference back, as a reply committed to ScratchPad would.
            if envelope.prompt == "hand me a reference":
                await stream.send("here it is: sp-ref:GIVENBACK")
            else:
                await stream.send(f"pong: {envelope.prompt}")

        target.on_prompt(pong)
        await target.start()
        # The target's own client, for the one check where it prompts the host.
        target_client = Agents(nc=nc_target, identity=Identity(signer=signer_from_seed(users["target"].seed)))

        # A signed agent that does not say it reads references, like a harness.
        leaf = AgentService(
            agent="leaf", owner="test", session_name="target", nc=nc_target, interceptors=[TRACING.request_interceptor],
            identity=ServiceIdentity(signer=signer_from_seed(users["target"].seed)), keepalive_interval_s=None,
        )

        async def leaf_reply(envelope: Envelope, stream: PromptStream) -> None:
            await stream.send(f"leaf: {envelope.prompt}")

        leaf.on_prompt(leaf_reply)
        await leaf.start()

        # The creator: never prompted here. It is on the fabric with a verified
        # identity, and answers grant requests next to its prompt address.
        creator_pad = FakePad(owns_listed=True)
        creator_address = AgentSubject.new("creator", "test", "main").prompt
        creator = AgentService(
            agent="creator", owner="test", session_name="main", nc=nc_creator, interceptors=[TRACING.request_interceptor],
            identity=ServiceIdentity(signer=signer_from_seed(users["creator"].seed)), keepalive_interval_s=None,
            extra_metadata={READS_REFERENCES_KEY: "true"},
            extra_endpoints=[grant_request_endpoint(prompt_address=creator_address, scratch_pad=creator_pad)],  # type: ignore[arg-type]
        )

        async def creator_reply(envelope: Envelope, stream: PromptStream) -> None:
            await stream.send("the creator is not prompted in these tests")

        creator.on_prompt(creator_reply)
        await creator.start()

        # The host, wired as ``agent.py`` wires the agent.
        host_address = AgentSubject.new("host", "test", "main").prompt
        host_client = Agents(
            nc=nc_host,
            identity=Identity(signer=signer_from_seed(users["host"].seed)),
            interceptors=[TRACING.prompt_interceptor],
        )
        pad = FakePad(owns_listed=False)
        references = scratch_pad_extension(scratch_pad=pad, agents=host_client)  # type: ignore[arg-type]
        tools = AgentTools(
            host_client, tools=offered_tools("blocking"), self_address=host_address, discover_timeout=0.5, extensions=[references]
        )
        runner = tool_runner(tools)
        host = AgentService(
            agent="host", owner="test", session_name="main", nc=nc_host,
            interceptors=[TRACING.request_interceptor, tools.request_interceptor, references.request_interceptor],
            identity=ServiceIdentity(signer=signer_from_seed(users["host"].seed)), keepalive_interval_s=None,
            max_concurrent_prompts=4,
            extra_metadata={READS_REFERENCES_KEY: "true"},
            extra_endpoints=[grant_request_endpoint(prompt_address=host_address, scratch_pad=pad)],  # type: ignore[arg-type]
        )

        async def model_loop(envelope: Envelope, stream: PromptStream) -> None:
            # One model call happened here; its headers carry the served thread.
            served.update(trace_headers())
            # The model asked for one tool call, which the prompt names, its
            # arguments as the wire carries them: a JSON string, and a
            # tool-call id of the model's choosing.
            call = json.loads(envelope.prompt)
            await stream.send(await runner.call(call["name"], json.dumps(call["args"]), "call_test_1"))

        host.on_prompt(model_loop)
        await host.start()
        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_seed(users["caller"].seed)),
            interceptors=[TRACING.prompt_interceptor],
        )

        async def settle() -> None:
            # Edges go out before the prompts they announce; give the last one
            # a moment to arrive after the reply has.
            await nc_host.flush()
            await asyncio.sleep(0.3)

        async def via_host(name: str, args: Any, sender: Agents | None = None) -> dict[str, Any]:
            # A tool call made from inside a prompt the host serves, as the
            # model makes it: the tools run in that prompt's scope and trace.
            found = await (sender or caller).discover(timeout=0.5, filter=DiscoverFilter(agent="host"))
            reply = json.loads(await reply_text(found[0].prompt(json.dumps({"name": name, "args": args}))))
            await settle()
            return reply

        async def direct(name: str, args: Any) -> dict[str, Any]:
            # A tool call made outside any served prompt.
            return json.loads(await runner.call(name, args, "call_direct"))

        def handed_by(creator_address: str | None, path: str) -> str:
            """A token as the agent at ``creator_address`` would hand it over, into its own volume."""
            made: dict[str, Any] = {
                "ref": {"type": "handoff", "handoff_id": "h", "volume_id": "vol-creator", "root": "r", "path": path, "expires_at": 9_000_000_000},
                "source_sequence": 1,
            }
            if creator_address is not None:
                made["creator"] = creator_address
            token = "sp-ref:" + base64.urlsafe_b64encode(json.dumps(made).encode()).decode().rstrip("=")
            pad.listed.add(token); creator_pad.listed.add(token)
            return token

        try:
            # prompt_agent from inside a served prompt hangs the child under the served thread.
            result = await via_host("prompt_agent", {"address": target.subject.prompt, "prompt": "ping"})
            assert_valid(CALL_RESULT, result)
            assert result.pop("call_id")
            assert result == {"state": "completed", "reply": "pong: ping"}
            assert len(edges) == 2
            root = next(e for e in edges if e["record"]["parent_id"] is None)
            child = next(e for e in edges if e["record"]["tool_call_id"] == "call_test_1")
            # The caller's edge announced the tree; the host adopted its thread.
            assert root["record"]["thread_id"] == served["X-Synadia-Thread-ID"]
            assert root["record"]["root_id"] == served["X-Synadia-Root-ID"]
            assert root["record"]["turn_count_hint"] == 0
            # The host's edge: a child of the served thread, in the same tree,
            # named after the model's tool call, written by the host, after one
            # model call; signed, one id for body, header and message.
            assert child["record"]["kind"] == "edge"
            assert child["record"]["parent_id"] == root["record"]["thread_id"]
            assert child["record"]["root_id"] == root["record"]["root_id"]
            assert child["record"]["thread_id"] != root["record"]["thread_id"]
            assert child["record"]["agent"] == str(host.identity)
            assert child["record"]["turn_count_hint"] == 1
            assert child["headers"].get("Agent-Sender")
            assert child["headers"].get("Nats-Msg-Id") == child["record"]["record_id"]

            # prompt_agent grants the target read on every reference of the host's
            # own in the prompt, then sends it. The references arrive in the
            # prompt the host serves, so they were given to it.
            edges.clear(); served.clear()
            result = await via_host("prompt_agent", {"address": target.subject.prompt, "prompt": "read sp-ref:AAA and sp-ref:BBB"})
            assert {k: result[k] for k in ("state", "reply")} == {"state": "completed", "reply": "pong: read sp-ref:AAA and sp-ref:BBB"}
            assert [g[0] for g in pad.grants] == ["sp-ref:AAA", "sp-ref:BBB"]
            for _, grantee, trace, tool_call_id, kind in pad.grants:
                # To the identity discovery reported for the address, under the
                # served thread, named after the model's call, first-hand.
                assert grantee == grantee_from_identity(str(target.identity))
                assert (tool_call_id, kind) == ("call_test_1", "first-hand")
                assert trace == TraceIds(served["X-Synadia-Thread-ID"], served["X-Synadia-Root-ID"])
            assert len([e for e in edges if e["record"]["tool_call_id"] == "call_test_1"]) == 1

            # It asks the creator of a reference the host did not create, and the creator grants the target.
            pad.grants.clear(); served.clear()
            token = handed_by(creator.subject.prompt, "/replies/findings.md")
            result = await via_host("prompt_agent", {"address": target.subject.prompt, "prompt": f"write from {token}"})
            # The reference travels as it came: nothing was copied.
            assert result["reply"] == f"pong: write from {token}"
            # The host granted nothing; the creator did, on request, to the
            # target's verified identity, labelled with the host's served thread
            # and the model's call.
            assert pad.grants == []
            assert creator_pad.grants == [
                (token, grantee_from_identity(str(target.identity)), TraceIds(served["X-Synadia-Thread-ID"], served["X-Synadia-Root-ID"]), "call_test_1", "on-request")
            ]

            # It sends the text without a reference its creator will not grant on, and says so.
            creator_pad.granted_requester = False; creator_pad.grants.clear()
            references.remember(f"{token} sp-ref:AAA")
            result = await direct("prompt_agent", {"address": target.subject.prompt, "prompt": f"write from sp-ref:AAA and\n{token}"})
            assert_valid(CALL_RESULT, result)
            # The host's own reference went with its grant; the other one came out.
            assert result["reply"] == "pong: write from sp-ref:AAA and"
            assert result["references_removed"] == 1
            assert "its creator did not grant" in result["note"] and "no live read grant" in result["note"]
            assert [g[0] for g in pad.grants] == ["sp-ref:AAA"]
            assert creator_pad.grants == []
            creator_pad.granted_requester = True

            # It sends a non-reader the text without the references, grants nothing, and says so.
            pad.grants.clear()
            result = await direct("prompt_agent", {"address": leaf.subject.prompt, "prompt": "edit this: some text\n\nsp-ref:AAA"})
            assert_valid(CALL_RESULT, result)
            assert result["reply"] == "leaf: edit this: some text"
            assert result["references_removed"] == 1
            assert "does not read ScratchPad references: 1 reference" in result["note"] and "nothing was granted" in result["note"]
            assert pad.grants == []
            # A prompt that was nothing but references is not sent at all. (The
            # one above went out from outside a served prompt, so its edge is a
            # root's.)
            await settle()
            edges.clear()
            result = await direct("prompt_agent", {"address": leaf.subject.prompt, "prompt": " sp-ref:AAA \n"})
            assert list(result) == ["error"]
            assert "not sent" in result["error"] and "nothing but references" in result["error"]
            await settle()
            assert edges == [] and pad.grants == []

            # It hands over only a reference the host was given, exactly as it came.
            for prompt in ("read sp-ref:NEVERGIVEN", "read sp-ref:AAB"):
                result = await direct("prompt_agent", {"address": target.subject.prompt, "prompt": prompt})
                assert_valid(CALL_RESULT, result)
                assert list(result) == ["error"]
                assert "not sent" in result["error"] and "not one you were given" in result["error"]
                assert "Copy each reference exactly" in result["error"]
            assert pad.grants == []
            await settle()
            assert edges == []
            # Given in a reply prompt_agent brought back: it may be handed on.
            assert (await direct("prompt_agent", {"address": target.subject.prompt, "prompt": "hand me a reference"}))["reply"] == "here it is: sp-ref:GIVENBACK"
            result = await direct("prompt_agent", {"address": target.subject.prompt, "prompt": "read sp-ref:GIVENBACK"})
            assert {k: result[k] for k in ("state", "reply")} == {"state": "completed", "reply": "pong: read sp-ref:GIVENBACK"}
            assert [g[0] for g in pad.grants] == ["sp-ref:GIVENBACK"]

            # It never prompts the host's own address, nor the agent that sent the prompt it serves.
            await settle()
            edges.clear()
            result = await direct("prompt_agent", {"address": host_address, "prompt": "hi"})
            assert "your own address; answer the prompt yourself" in result["error"]
            # The target prompts the host, whose model then tries to prompt the target back.
            result = await via_host("prompt_agent", {"address": target.subject.prompt, "prompt": "please do my task"}, target_client)
            assert list(result) == ["error"]
            assert "sent the prompt you are answering; answer it rather than prompting it back" in result["error"]
            assert edges == []

            # discover_agents lists the others with the contract's fields and
            # whether each reads references, never the host itself.
            listed = await direct("discover_agents", {})
            assert_valid(DISCOVER_RESULT, listed)
            addresses = [a["address"] for a in listed["agents"]]
            assert target.subject.prompt in addresses
            assert host_address not in addresses
            echo = next(a for a in listed["agents"] if a["address"] == target.subject.prompt)
            assert echo == {
                "address": target.subject.prompt, "agent": "echo", "owner": "test", "name": "target",
                "description": "Answers pong", "identity": str(target.identity), "identity_verified": True,
                "requires_signed_prompts": True, "accepts_attachments": True, "instances": 1,
                "reads_scratchpad_references": True,
            }
            leaf_entry = next(a for a in listed["agents"] if a["address"] == leaf.subject.prompt)
            assert leaf_entry["identity_verified"] is True
            assert leaf_entry["reads_scratchpad_references"] is False
            await settle()
            assert edges == []  # discovery writes nothing to the log

            # An unknown tool, bad arguments, an address nobody answers at: told to the model in words, no edge.
            assert await direct("open_pod_bay_doors", {}) == {"error": 'unknown tool "open_pod_bay_doors"'}
            assert "not valid JSON" in (await direct("prompt_agent", "{not json"))["error"]
            assert '"address" is required' in (await direct("prompt_agent", {"prompt": "x"}))["error"]
            result = await direct("prompt_agent", {"address": "agents.prompt.nobody.test.main", "prompt": "?"})
            assert_valid(CALL_RESULT, result)
            assert "no agent answers at" in result["error"]
            # No file of this host's at the model's word: the agent names no
            # attachment root, so only files other agents sent back may be sent on.
            result = await direct("prompt_agent", {"address": target.subject.prompt, "prompt": "hi", "attachments": ["pyproject.toml"]})
            assert "outside the directories you may send files from" in result["error"]
            await settle()
            assert edges == []

            # A refusal reported, not raised: an unsigned caller on a signed-only agent.
            unsigned = Agents(nc=nc_caller)
            unsigned_tools = AgentTools(unsigned, discover_timeout=0.5)
            try:
                result = json.loads(
                    await tool_runner(unsigned_tools).call(
                        "prompt_agent", json.dumps({"address": target.subject.prompt, "prompt": "ping"}), "c3"
                    )
                )
            finally:
                await unsigned_tools.aclose()
                await unsigned.close()
            assert_valid(CALL_RESULT, result)
            assert list(result) == ["error"]
            assert "not sent" in result["error"]
        finally:
            await tools.aclose()
            await caller.close()
            await target_client.close()
            await host_client.close()
            await host.stop()
            await target.stop()
            await leaf.stop()
            await creator.stop()
            await asyncio.gather(nc_caller.close(), nc_host.close(), nc_target.close(), nc_creator.close())
    finally:
        server.stop()
