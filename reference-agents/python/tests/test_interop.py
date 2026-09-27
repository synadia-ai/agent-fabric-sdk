"""Two languages, one behaviour: the TypeScript agent prompts the Python one
and back, both on one throwaway server, both with the fake model.

    ts  — ``reference-agents/typescript`` started as a subprocess, as ``npm start`` would
    py  — ``start_agent()`` in this process

The fake model asks for ``prompt_agent`` to whatever address the prompt names
after "delegate to". The caller asks the Python agent to delegate to the
TypeScript one, then the TypeScript agent to delegate to the Python one; each
time the reply carries the other's answer and the edge written by the
delegating agent has its served thread as parent.

The second test is the handoff across the two languages: both agents with
ScratchPad on, over the package's stand-in ``sp`` and one store, the
TypeScript agent commits and grants, the Python agent reads what it
committed. Both are skipped when the TypeScript agent's dependencies are not
installed.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import nats
import pytest
from synadia_ai.agent_fabric import fabric_tracing, find_references
from synadia_ai.agents import (
    Agents,
    DiscoverFilter,
    Identity,
    ResponseChunk,
    signer_from_creds_file,
    signer_from_seed,
)

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


TS_DIR = Path(__file__).resolve().parents[2] / "typescript"
binary = nats_server_on_path()
node = shutil.which("node")
ts_ready = (TS_DIR / "node_modules" / "tsx").is_dir()


@pytest.mark.skipif(binary is None or node is None or not ts_ready, reason="needs nats-server, node and reference-agents/typescript installed")
async def test_typescript_and_python_agents_prompt_each_other(tmp_path: Path) -> None:
    users = {name: new_user() for name in ("caller", "py", "ts")}
    server = LocalNatsServer.start(binary, list(users.values()))  # type: ignore[arg-type]
    fake = FakeModel().start()
    edges: list[dict[str, Any]] = []
    ts_proc: subprocess.Popen[bytes] | None = None
    try:
        # The TypeScript agent, exactly as npm start runs it, told by environment.
        ts_ready_file = tmp_path / "ts.ready.json"
        ts_env = {
            **os.environ,
            "NATS_URL": server.url,
            "NATS_NKEY_SEED_FILE": server.write_seed_file(users["ts"], "ts"),
            "AGENT_KIND": "ts-agent", "AGENT_OWNER": "test", "AGENT_NAME": "main",
            "AGENT_READY_FILE": str(ts_ready_file),
            "MODEL_PROXY_URL": fake.url, "MODEL_VIRTUAL_KEY": "vk-ts", "MODEL_NAME": "fake-ts",
        }
        ts_log = open(tmp_path / "ts.log", "wb")  # noqa: SIM115 — closed with the process
        ts_proc = subprocess.Popen(
            [node, "--import", "tsx", "src/main.ts"], cwd=TS_DIR, env=ts_env, stdout=ts_log, stderr=subprocess.STDOUT
        )
        for _ in range(100):
            if ts_ready_file.exists() or ts_proc.poll() is not None:
                break
            await asyncio.sleep(0.2)
        assert ts_ready_file.exists(), (tmp_path / "ts.log").read_text(errors="replace")
        ts_address = json.loads(ts_ready_file.read_text())["subject"]

        py = await start_agent(
            AgentConfig(
                nats=NatsConfig(url=server.url, nkey=server.write_seed_file(users["py"], "py")),
                agent=AgentIdentityConfig(
                    kind="py-agent", owner="test", name="main", description="the Python agent",
                    system_prompt="You are under test.", min_sender_trust="any", tools="blocking", heartbeat_interval_s=None,
                    max_history_exchanges=20, ready_file=None,
                ),
                model=ModelConfig(proxy_url=fake.url, virtual_key="vk-py", model="fake-py", timeout_s=None),
                reply_timeout_s=10.0,
            ),
            log=lambda _line: None,
            env={},
        )

        nc_caller = await nats.connect(server.url, nkeys_seed_str=users["caller"].seed)

        async def collect(msg: Any) -> None:
            edges.append(json.loads(msg.data))

        await nc_caller.subscribe("TRACE.edges", cb=collect)
        await nc_caller.flush()
        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_seed(users["caller"].seed)),
            interceptors=[fabric_tracing().prompt_interceptor],
        )

        async def prompt(kind: str, text: str) -> str:
            found = await caller.discover(timeout=0.5, filter=DiscoverFilter(agent=kind))
            assert found, kind
            reply = await reply_text(found[0].prompt(text))
            await nc_caller.flush()
            await asyncio.sleep(0.3)
            return reply

        try:
            # Both are on the fabric, each with a verified identity.
            listed = {a.agent: a for a in await caller.discover(timeout=0.5)}
            assert {"ts-agent", "py-agent"} <= set(listed)
            assert listed["ts-agent"].id_sig_verified and listed["py-agent"].id_sig_verified

            # Python delegates to TypeScript.
            edges.clear(); fake.requests.clear()
            assert await prompt("py-agent", f"delegate to {ts_address}") == "they said: plain answer to: ping"
            root = next(e for e in edges if e["parent_id"] is None)
            child = next(e for e in edges if e["tool_call_id"] == "call_fake_1")
            assert child["parent_id"] == root["thread_id"] and child["root_id"] == root["root_id"]
            assert child["agent"] == py.identity
            # The TypeScript agent's model call carried the child thread.
            ts_call = next(r for r in fake.requests if r.headers["authorization"] == "Bearer vk-ts")
            assert ts_call.headers["x-synadia-thread-id"] == child["thread_id"]
            assert ts_call.headers["x-synadia-root-id"] == root["root_id"]

            # TypeScript delegates to Python.
            edges.clear(); fake.requests.clear()
            assert await prompt("ts-agent", f"delegate to {py.address}") == "they said: plain answer to: ping"
            root = next(e for e in edges if e["parent_id"] is None)
            child = next(e for e in edges if e["tool_call_id"] == "call_fake_1")
            assert child["parent_id"] == root["thread_id"] and child["root_id"] == root["root_id"]
            assert child["agent"] == listed["ts-agent"].identity
            py_call = next(r for r in fake.requests if r.headers["authorization"] == "Bearer vk-py")
            assert py_call.headers["x-synadia-thread-id"] == child["thread_id"]
            assert py_call.headers["x-synadia-root-id"] == root["root_id"]
        finally:
            await caller.close()
            await nc_caller.close()
            await py.stop()
    finally:
        if ts_proc is not None and ts_proc.poll() is None:
            ts_proc.terminate()
            try:
                ts_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ts_proc.kill()
        fake.stop()
        server.stop()


# The handoff across the two languages, over ScratchPad: the package's stand-in
# for the `sp` command line, one store for both agents, each agent its own
# volume. It needs `.creds` files, which `sp` takes and an nkey seed is not, so
# the server is this repository's operator-mode fixture: alice and carol, the
# two agents, and dave, who prompts them, in one account. ScratchPad grants
# only within a reference's account, so the caller is in the agents' own, as
# on a tenant.
REPO = Path(__file__).resolve().parents[3]
IDENTITY = REPO / "test-fixtures" / "identity" / "operator"
FAKE_SP = REPO / "python" / "tests" / "harness" / "fake_sp.py"


def sp_calls(log: Path) -> list[dict[str, Any]]:
    """The stand-in's log, one call a line, each with the command and flags parsed and whose creds made it."""
    calls = []
    for line in log.read_text().splitlines():
        command, *rest = json.loads(line)["argv"]
        flags = {rest[i][2:]: rest[i + 1] for i in range(len(rest) - 1) if rest[i].startswith("--")}
        calls.append({"command": command, "flags": flags, "who": Path(flags.get("creds", "")).stem})
    return calls


def ref_fields(reference: str) -> dict[str, Any]:
    """The fields of a reference token: its volume under ``target``, its root and path."""
    body = reference[len("sp-ref:") :]
    fields: dict[str, Any] = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    return fields


@pytest.mark.skipif(binary is None or node is None or not ts_ready, reason="needs nats-server, node and reference-agents/typescript installed")
async def test_a_reference_the_typescript_agent_committed_is_read_by_the_python_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    server = LocalNatsServer.start_with_config(binary, IDENTITY / "operator.conf")  # type: ignore[arg-type]
    fake = FakeModel().start()
    log, state = tmp_path / "sp.log", tmp_path / "sp.state.json"
    sp_env = {"FAKE_SP_LOG": str(log), "FAKE_SP_STATE": str(state)}
    ts_proc: subprocess.Popen[bytes] | None = None
    try:
        ts_ready_file = tmp_path / "ts.ready.json"
        ts_env = {
            **os.environ, **sp_env,
            "NATS_URL": server.url, "NATS_CREDS": str(IDENTITY / "alice.creds"),
            "AGENT_KIND": "ts-agent", "AGENT_OWNER": "test", "AGENT_NAME": "main",
            "AGENT_READY_FILE": str(ts_ready_file),
            "MODEL_PROXY_URL": fake.url, "MODEL_VIRTUAL_KEY": "vk-ts", "MODEL_NAME": "fake-ts",
            "SCRATCHPAD_VOLUME": "TsReplies", "SCRATCHPAD_BIN": str(FAKE_SP), "SCRATCHPAD_DIR": str(tmp_path / "sp-ts"),
        }
        ts_log = open(tmp_path / "ts.log", "wb")  # noqa: SIM115 — closed with the process
        ts_proc = subprocess.Popen(
            [node, "--import", "tsx", "src/main.ts"], cwd=TS_DIR, env=ts_env, stdout=ts_log, stderr=subprocess.STDOUT
        )
        for _ in range(100):
            if ts_ready_file.exists() or ts_proc.poll() is not None:
                break
            await asyncio.sleep(0.2)
        assert ts_ready_file.exists(), (tmp_path / "ts.log").read_text(errors="replace")

        # The Python agent runs in this process, so the stand-in it spawns
        # reads this process's environment.
        for k, v in sp_env.items():
            monkeypatch.setenv(k, v)
        py = await start_agent(
            AgentConfig(
                nats=NatsConfig(url=server.url, creds=str(IDENTITY / "carol.creds")),
                agent=AgentIdentityConfig(
                    kind="py-agent", owner="test", name="main", description="the Python agent",
                    system_prompt="You are under test.", min_sender_trust="any", tools="none", heartbeat_interval_s=None,
                    max_history_exchanges=20, ready_file=None,
                ),
                model=ModelConfig(proxy_url=fake.url, virtual_key="vk-py", model="fake-py", timeout_s=None),
                reply_timeout_s=10.0,
            ),
            log=lambda _line: None,
            env={"SCRATCHPAD_VOLUME": "PyReplies", "SCRATCHPAD_BIN": str(FAKE_SP), "SCRATCHPAD_DIR": str(tmp_path / "sp-py")},
        )

        nc_caller = await nats.connect(server.url, user_credentials=str(IDENTITY / "dave.creds"))
        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_creds_file(str(IDENTITY / "dave.creds"))),
            interceptors=[fabric_tracing().prompt_interceptor],
        )

        async def prompt(kind: str, text: str) -> str:
            found = await caller.discover(timeout=0.5, filter=DiscoverFilter(agent=kind))
            assert found, kind
            return await reply_text(found[0].prompt(text))

        try:
            # The TypeScript agent's reply, committed to its own volume and
            # handed to the caller by reference.
            first = await prompt("ts-agent", "hello")
            assert first.startswith("plain answer to: hello")
            (ref,) = find_references(first)

            # The caller hands it back with a task: the TypeScript agent's
            # model prompts the Python agent with the reference.
            second = await prompt("ts-agent", f"delegate to {py.address}: count {ref}")
            assert second.startswith("they said: plain answer to: count ")

            calls = sp_calls(log)
            ts_commit = next(c for c in calls if c["who"] == "alice" and c["command"] == "publish-file")
            path = ts_commit["flags"]["path"]
            assert ref_fields(ref)["target"]["volume"] == "TsReplies" and ref_fields(ref)["path"] == path
            # The TypeScript agent granted the Python agent read on that one
            # path, and only then did the Python agent read it from the
            # TypeScript agent's volume.
            account, user = py.identity.split(".")  # type: ignore[union-attr]
            grant = next(
                i for i, c in enumerate(calls)
                if c["who"] == "alice" and c["command"] == "grant" and c["flags"]["grantee-user"] == user
            )
            assert calls[grant]["flags"]["grantee-account"] == account
            assert calls[grant]["flags"]["ref"] == ref
            read = next(
                i for i, c in enumerate(calls)
                if c["who"] == "carol" and c["command"] == "read" and c["flags"]["ref"] == ref
            )
            assert grant < read
            # What the Python agent's model was given is what the TypeScript
            # agent committed, read through the one store.
            py_call = next(r for r in fake.requests if r.headers["authorization"] == "Bearer vk-py")
            assert "plain answer to: hello" in py_call.body["messages"][-1]["content"]
            # And the Python agent's own reply came back by reference too, in
            # its volume, granted to the TypeScript agent that asked.
            assert any(
                c["who"] == "carol" and c["command"] == "grant"
                and ref_fields(c["flags"]["ref"])["target"]["volume"] == "PyReplies"
                for c in calls
            )
            volumes = {ref_fields(r)["target"]["volume"] for r in find_references(second)}
            assert volumes == {"TsReplies", "PyReplies"}
        finally:
            await caller.close()
            await nc_caller.close()
            await py.stop()
    finally:
        if ts_proc is not None and ts_proc.poll() is None:
            ts_proc.terminate()
            try:
                ts_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                ts_proc.kill()
        fake.stop()
        server.stop()
