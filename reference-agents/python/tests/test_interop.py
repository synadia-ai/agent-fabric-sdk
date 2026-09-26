"""Two languages, one behaviour: the TypeScript agent prompts the Python one
and back, both on one throwaway server, both with the fake model.

    ts  — ``reference-agents/typescript`` started as a subprocess, as ``npm start`` would
    py  — ``start_agent()`` in this process

The fake model asks for ``prompt_agent`` to whatever address the prompt names
after "delegate to". The caller asks the Python agent to delegate to the
TypeScript one, then the TypeScript agent to delegate to the Python one; each
time the reply carries the other's answer and the edge written by the
delegating agent has its served thread as parent. Skipped when the
TypeScript agent's dependencies are not installed.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

import nats
import pytest
from synadia_ai.agent_fabric import fabric_tracing
from synadia_ai.agents import Agents, DiscoverFilter, Identity, ResponseChunk, signer_from_seed

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
