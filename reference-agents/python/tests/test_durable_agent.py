"""The durable agent survives a crash: the model loop is the workflow, so the
run is taken up again after the process is killed and completes without
repeating a model turn it had journaled.

    server  — a nats-server with JetStream and one account shaped like a
              tenant's, the durable-execution library's seven created first
              from ``test-fixtures/durable/`` (as ``test_start_workflow.py`` does)
    agent   — ``python -m fabric_agent.durable_main`` as a subprocess, twice:
              the first is killed, the second takes the run up
    fake    — the model behind a fake proxy. The first turn asks for
              ``discover_agents``; the second, with the tool's result in front
              of it, is held until a marker file exists, then answers
    caller  — an SDK client with tracing on, prompting the agent once

Asserted: the run ``<served thread>-prompt`` completes after the restart; its
journal has one ``step-end`` per step; the fake saw the first model turn
exactly once across both processes; every model call of both processes
carried the same two trace headers, the served thread's; the journal's result
holds the answer. And the limit, stated: the prompt that was being served
when the first process died ended without the reply. The same test as the
TypeScript agent's ``test/durable-agent.test.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import nats
import pytest
from synadia_ai.agent_fabric import fabric_tracing
from synadia_ai.agents import Agents, DiscoverFilter, Identity, ResponseChunk, signer_from_seed

from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user

binary = nats_server_on_path()

AGENT_DIR = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parents[3] / "test-fixtures" / "durable"
SEVEN = ["DE_JOURNAL", "DE_WORK", "DE_TIMERS", "KV_DE_RUNS", "KV_DE_LEASES", "KV_DE_PARKED", "OBJ_DE_BLOBS"]
ANSWER = "the fabric has agents, and this one survived a crash"


@dataclass
class _Fake:
    """The model: a tool call first, then an answer held until ``marker`` exists."""

    marker: Path
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
                message: dict[str, Any]
                if not any(m["role"] == "tool" for m in body["messages"]):
                    call = {
                        "id": "call_discover_1",
                        "type": "function",
                        "function": {"name": "discover_agents", "arguments": "{}"},
                    }
                    message = {"role": "assistant", "content": "", "tool_calls": [call]}
                else:
                    while not fake.marker.exists():
                        time.sleep(0.05)
                    message = {"role": "assistant", "content": ANSWER}
                raw = json.dumps({"choices": [{"index": 0, "message": message}], "usage": {}}).encode()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                except OSError:
                    pass  # the process that asked is gone

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()


def _label(e: dict[str, Any]) -> str:
    return f"{e['kind']} {e['name']}" if "name" in e else e["kind"]


@pytest.mark.skipif(binary is None, reason="nats-server not on PATH")
async def test_the_run_completes_after_a_kill_without_repeating_a_journaled_model_turn(tmp_path: Path) -> None:
    users = {name: new_user() for name in ("caller", "agent", "tenant")}
    server = LocalNatsServer.start_tenant(binary, list(users.values()), max_streams=7)  # type: ignore[arg-type]
    fake = _Fake(marker=tmp_path / "release-the-second-turn")
    proxy_url = fake.start()
    children: list[subprocess.Popen[bytes]] = []
    logs = tmp_path / "agent.log"
    try:
        nc_tenant = await nats.connect(server.url, nkeys_seed_str=users["tenant"].seed, name="tenant")
        nc_caller = await nats.connect(server.url, nkeys_seed_str=users["caller"].seed, name="caller")
        for name in SEVEN:
            config = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
            msg = await nc_tenant.request(
                f"$JS.API.STREAM.CREATE.{name}", json.dumps({**config, "num_replicas": 1}).encode(), timeout=5
            )
            assert "error" not in json.loads(msg.data), msg.data

        async def journal(run_id: str) -> list[dict[str, Any]]:
            entries: list[dict[str, Any]] = []
            seq = 1
            while True:
                msg = await nc_tenant.request(
                    "$JS.API.STREAM.MSG.GET.DE_JOURNAL",
                    json.dumps({"seq": seq, "next_by_subj": f"de.journal.{run_id}"}).encode(),
                    timeout=5,
                )
                got = json.loads(msg.data)
                if "message" not in got:
                    return entries
                entries.append(json.loads(base64.b64decode(got["message"]["data"])))
                seq = got["message"]["seq"] + 1

        env = {
            **os.environ,
            "NATS_URL": server.url,
            "NATS_NKEY_SEED_FILE": server.write_seed_file(users["agent"], "agent"),
            "MODEL_PROXY_URL": proxy_url,
            "MODEL_VIRTUAL_KEY": "vk-test",
            "MODEL_NAME": "fake-1",
            "AGENT_KIND": "assistant",
            "AGENT_OWNER": "test",
            "AGENT_NAME": "durable",
            "AGENT_REPLY_TIMEOUT_MS": "120000",
            "SCRATCHPAD_VOLUME": "",
        }

        async def start_agent(n: int) -> subprocess.Popen[bytes]:
            ready = tmp_path / f"ready-{n}.json"
            out = logs.open("ab")
            # A file that does not exist, so no .env next to the agent is read.
            child = subprocess.Popen(
                [sys.executable, "-m", "fabric_agent.durable_main", str(tmp_path / "no.env")],
                cwd=AGENT_DIR,
                env={**env, "AGENT_READY_FILE": str(ready)},
                stdout=out,
                stderr=subprocess.STDOUT,
            )
            children.append(child)
            for _ in range(300):
                if ready.exists():
                    return child
                if child.poll() is not None:
                    break
                await asyncio.sleep(0.1)
            raise AssertionError(f"agent {n} did not start:\n{logs.read_text()}")

        first = await start_agent(1)
        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_seed(users["caller"].seed)),
            interceptors=[fabric_tracing().prompt_interceptor],
        )
        found = await caller.discover(timeout=2.0, filter=DiscoverFilter(agent="assistant"))
        assert found

        # The prompt, read in the background: the agent serving it will die.
        chunks: list[str] = []

        async def read() -> str:
            try:
                async for m in found[0].prompt("what is on the fabric?", timeout=10.0):
                    if isinstance(m, ResponseChunk):
                        chunks.append(m.text)
                return "completed"
            except Exception as err:  # noqa: BLE001 — the outcome is the point
                return type(err).__name__

        ended = asyncio.create_task(read())

        # The served thread, from the first model call; the run is named after it.
        for _ in range(100):
            if fake.seen:
                break
            await asyncio.sleep(0.1)
        assert fake.seen, logs.read_text()
        thread = fake.seen[0][0]["x-synadia-thread-id"]
        root = fake.seen[0][0]["x-synadia-root-id"]
        run_id = f"{thread}-prompt"

        # Killed once its first step has ended.
        before: list[dict[str, Any]] = []
        for _ in range(100):
            before = await journal(run_id)
            if any(e["kind"] == "step-end" for e in before):
                break
            await asyncio.sleep(0.1)
        first.kill()
        first.wait()
        before = await journal(run_id)
        calls_before = len(fake.seen)

        # The stream of the prompt that was being served ends without the reply.
        outcome = await ended
        assert ANSWER not in "".join(chunks)

        # The second turn may go out now; a second process takes the run up.
        fake.marker.write_text("")
        await start_agent(2)
        after: list[dict[str, Any]] = []
        for _ in range(900):
            after = await journal(run_id)
            if any(e["kind"] == "result" for e in after):
                break
            await asyncio.sleep(0.1)
        result = next((e for e in after if e["kind"] == "result"), None)
        assert result is not None, logs.read_text()
        assert result["value"] == {"answer": ANSWER, "modelTurns": 2}
        ends = [e for e in after if e["kind"] == "step-end"]
        assert len({e["seq"] for e in ends}) == len(ends)
        assert [e["name"] for e in ends] == ["llm-0", "tool-0-0", "llm-1"]
        first_turns = [m for _, m in fake.seen if not any(x["role"] == "tool" for x in m)]
        assert len(first_turns) == 1
        for headers, _ in fake.seen:
            assert headers["x-synadia-thread-id"] == thread
            assert headers["x-synadia-root-id"] == root

        print(
            json.dumps(
                {
                    "run_id": run_id,
                    "journal_before_kill": [_label(e) for e in before],
                    "journal_after": [_label(e) for e in after],
                    "model_calls": {"before_kill": calls_before, "total": len(fake.seen), "first_turn": len(first_turns)},
                    "headers": {"thread": thread, "root": root},
                    "first_prompt": {"outcome": outcome, "reply_chunks": len(chunks)},
                    "result": result["value"],
                }
            )
        )
        await caller.close()
        await nc_caller.close()
        await nc_tenant.close()
    finally:
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait()
        fake.marker.write_text("")
        fake.stop()
        server.stop()
