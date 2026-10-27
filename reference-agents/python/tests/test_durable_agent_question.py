"""The durable agent's tools and questions: a tool call made on the worker, in
the run's tool scope and the prompt's trace, and a question from the prompted
agent parked on a durable signal and relayed to the caller.

    server  — JetStream, one account
    engine  — ``durable-engine serve`` on that account (``harness/engine.py``)
    agent   — ``python -m fabric_agent.durable_main`` as a subprocess
    asker   — an agent that asks its caller a question before it answers
    fake    — the model: a prompt "delegate to <address>" asks for
              ``prompt_agent``; a tool result is answered "done: …"
    caller  — an SDK client with tracing on; it answers the question "yes"

Asserted: the question reached the caller, its answer reached the asker, and
the model saw the call's final result; the journal parked on ``ask-0-0``,
took the signal and carried the answer back in ``answer-0-0``; the edge
``prompt_agent`` wrote from the worker has the served thread as its parent
and the model's tool call as its call. The same test as the TypeScript
agent's ``test/durable-agent-question.test.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import nats
import pytest
from synadia_ai.agent_fabric import fabric_tracing
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Agents, DiscoverFilter, Envelope, Identity, Query, ResponseChunk, signer_from_seed

from tests.harness.engine import ENGINE_UNAVAILABLE, LocalEngine
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user

binary = nats_server_on_path()

AGENT_DIR = Path(__file__).resolve().parents[1]
_DELEGATE = re.compile(r"delegate to (\S+)")


@dataclass
class _Fake:
    seen: list[tuple[dict[str, str], list[dict[str, Any]]]] = field(default_factory=list)
    server: ThreadingHTTPServer | None = None

    def start(self) -> str:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802 — http.server's name
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                fake.seen.append(({k.lower(): v for k, v in self.headers.items()}, body["messages"]))
                last = body["messages"][-1]
                content = last.get("content") or ""
                message: dict[str, Any]
                if last["role"] == "tool":
                    message = {"role": "assistant", "content": f"done: {content}"}
                elif (m := _DELEGATE.search(content)) is not None:
                    call = {
                        "id": "call_ask_1",
                        "type": "function",
                        "function": {"name": "prompt_agent", "arguments": json.dumps({"address": m.group(1), "prompt": "go"})},
                    }
                    message = {"role": "assistant", "content": "", "tool_calls": [call]}
                else:
                    message = {"role": "assistant", "content": f"plain answer to: {content}"}
                raw = json.dumps({"choices": [{"index": 0, "message": message}], "usage": {}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()


@pytest.mark.skipif(binary is None, reason="nats-server not on PATH")
@pytest.mark.skipif(ENGINE_UNAVAILABLE is not None, reason=f"no durable engine: {ENGINE_UNAVAILABLE}")
async def test_a_prompted_agents_question_is_relayed_to_the_caller_and_answered(tmp_path: Path) -> None:
    users = {name: new_user() for name in ("caller", "agent", "asker", "tenant")}
    server = LocalNatsServer.start_tenant(binary, list(users.values()), max_streams=8)  # type: ignore[arg-type]
    fake = _Fake()
    proxy_url = fake.start()
    engine: LocalEngine | None = None
    child: subprocess.Popen[bytes] | None = None
    logs = tmp_path / "agent.log"
    tracing = fabric_tracing()
    try:
        nc_tenant = await nats.connect(server.url, nkeys_seed_str=users["tenant"].seed)
        nc_caller = await nats.connect(server.url, nkeys_seed_str=users["caller"].seed)
        nc_asker = await nats.connect(server.url, nkeys_seed_str=users["asker"].seed)
        engine = await LocalEngine.start(server.engine_url)
        edges: list[dict[str, Any]] = []

        async def collect(msg: Any) -> None:
            edges.append(json.loads(msg.data))

        await nc_tenant.subscribe("TRACE.edges", cb=collect)

        asker = AgentService(
            agent="asker", owner="test", session_name="a", nc=nc_asker,
            interceptors=[tracing.request_interceptor],
            identity=ServiceIdentity(signer=signer_from_seed(users["asker"].seed)), keepalive_interval_s=None,
        )
        told: list[str] = []

        async def ask_first(envelope: Envelope, stream: PromptStream) -> None:
            answer = await stream.ask("may I read the file?", timeout=10)
            told.append(answer.prompt)
            await stream.send(f"asked, and was told: {answer.prompt}")

        asker.on_prompt(ask_first)
        await asker.start()

        ready = tmp_path / "ready.json"
        child = subprocess.Popen(
            [sys.executable, "-m", "fabric_agent.durable_main", str(tmp_path / "no.env")],
            cwd=AGENT_DIR,
            env={
                **os.environ,
                "NATS_URL": server.url,
                "NATS_NKEY_SEED_FILE": server.write_seed_file(users["agent"], "agent"),
                "MODEL_PROXY_URL": proxy_url,
                "MODEL_VIRTUAL_KEY": "vk-test",
                "MODEL_NAME": "fake-1",
                "AGENT_KIND": "assistant",
                "AGENT_OWNER": "test",
                "AGENT_NAME": "durable",
                "AGENT_REPLY_TIMEOUT_MS": "20000",
                "AGENT_READY_FILE": str(ready),
                "SCRATCHPAD_VOLUME": "",
            },
            stdout=logs.open("wb"),
            stderr=subprocess.STDOUT,
        )
        for _ in range(300):
            if ready.exists() or child.poll() is not None:
                break
            await asyncio.sleep(0.1)
        assert ready.exists(), logs.read_text()

        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_seed(users["caller"].seed)),
            interceptors=[tracing.prompt_interceptor],
        )
        found = await caller.discover(timeout=2.0, filter=DiscoverFilter(agent="assistant"))
        assert found
        questions: list[str] = []
        parts: list[str] = []
        async for m in found[0].prompt(f"please delegate to {asker.subject.prompt}"):
            if isinstance(m, Query):
                questions.append(m.prompt)
                await m.reply("yes")
            elif isinstance(m, ResponseChunk):
                parts.append(m.text)

        assert questions == [f"{asker.subject.prompt} asks: may I read the file?"]
        assert told == ["yes"]
        result = json.loads("".join(parts).removeprefix("done: "))
        assert result["state"] == "completed"
        assert result["reply"] == "asked, and was told: yes"

        # The journal: parked on the question, the signal, the answer carried back.
        thread = fake.seen[0][0]["x-synadia-thread-id"]
        run_id = f"{thread}-prompt"
        kinds: list[str] = []
        seq = 1
        while True:
            msg = await nc_tenant.request(
                "$JS.API.STREAM.MSG.GET.DE_JOURNAL",
                json.dumps({"seq": seq, "next_by_subj": f"de.journal.{run_id}"}).encode(),
                timeout=5,
            )
            got = json.loads(msg.data)
            if "message" not in got:
                break
            e = json.loads(base64.b64decode(got["message"]["data"]))
            kinds.append(f"{e['kind']} {e['name']}" if "name" in e else e["kind"])
            seq = got["message"]["seq"] + 1
        assert kinds == [
            "start",
            "step-begin llm-0",
            "step-end llm-0",
            "step-begin tool-0-0",
            "step-end tool-0-0",
            "step-begin ask-request-0-0",
            "step-end ask-request-0-0",
            "await ask-0-0",
            "signal ask-0-0",
            "step-begin answer-0-0",
            "step-end answer-0-0",
            "step-begin llm-1",
            "step-end llm-1",
            "result",
        ]

        # The edge prompt_agent wrote on the worker: under the served thread,
        # under the model's call, after one model turn.
        await nc_tenant.flush()
        root = fake.seen[0][0]["x-synadia-root-id"]
        child_edge = next(e for e in edges if e["tool_call_id"] == "call_ask_1")
        assert (child_edge["parent_id"], child_edge["root_id"], child_edge["turn_count_hint"]) == (thread, root, 1)
        assert all(h["x-synadia-thread-id"] == thread for h, _ in fake.seen)
        print(json.dumps({"run_id": run_id, "journal": kinds, "edge": child_edge}))

        await caller.close()
        await asker.stop()
        await nc_caller.close()
        await nc_asker.close()
        await nc_tenant.close()
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            child.wait(timeout=10)
        if engine is not None:
            await engine.stop()
        fake.stop()
        server.stop()
