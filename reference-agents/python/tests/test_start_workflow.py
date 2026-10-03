"""Durable work delegated (5): a workflow started by the model's
``start_workflow`` call joins the tool call that started it, and starting the
worker creates nothing.

    server  — a nats-server with JetStream and one account shaped like a
              tenant's: file storage only, ``max_bytes`` required, room for
              the seven streams of the durable-execution library
    tenant  — a user of that account. It creates the seven first, from the
              configurations the fabric's onboarding applies
              (``test-fixtures/durable/``, at R1), watches the account's
              JetStream API advisories, and reads the run's journal back
    agent   — ``start_agent()`` with ``durable=True``, pointed at the fake
    fake    — the model behind a fake proxy: a prompt "durable: <task>" asks
              for ``start_workflow`` of ``durable-task`` under a tool-call id with a dot and a
              space in it; the step's call answers "step answer: …"; a tool
              result is answered "done: …"

Asserted: the run id is ``<served thread>-<tool call id sanitised>``; the
journal's start entry carries the workflow and the served trace in its input;
the step's model call reached the proxy with the two headers equal to that
trace; the worker's start, and the run, sent no STREAM.CREATE and no
STREAM.UPDATE, and the account still holds the seven and the worker's two
consumers alone. The same test as the TypeScript agent's
``test/durable.test.ts``.
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
from collections import Counter
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import nats
import pytest
from synadia_ai.agent_fabric import fabric_tracing
from synadia_ai.agents import Agents, DiscoverFilter, Identity, ResponseChunk, signer_from_seed

from fabric_agent.agent import start_agent
from fabric_agent.config import AgentConfig, AgentIdentityConfig, ModelConfig, NatsConfig, load_config
from fabric_agent.durable import DURABLE_STEP_INSTRUCTION, START_WORKFLOW
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user

binary = nats_server_on_path()

FIXTURES = Path(__file__).resolve().parents[3] / "test-fixtures" / "durable"
SEVEN = ["DE_JOURNAL", "DE_WORK", "DE_TIMERS", "KV_DE_RUNS", "KV_DE_LEASES", "KV_DE_PARKED", "OBJ_DE_BLOBS"]
# A dot and a space, which a run id may not hold.
TOOL_CALL_ID = "call.durable 1"
SANITISED = "call_durable_1"


def test_agent_durable_is_off_by_default_on_with_1_and_refuses_anything_else() -> None:
    base = {"MODEL_PROXY_URL": "http://p", "MODEL_VIRTUAL_KEY": "k", "MODEL_NAME": "m", "NATS_CREDS": "/c"}
    assert load_config(base).durable is False
    assert load_config({**base, "AGENT_DURABLE": "1"}).durable is True
    with pytest.raises(ValueError, match="AGENT_DURABLE"):
        load_config({**base, "AGENT_DURABLE": "yes"})


@dataclass
class _Fake:
    """The model behind the proxy, for this test's three moves."""

    requests: list[tuple[dict[str, str], dict[str, Any]]] = field(default_factory=list)
    server: ThreadingHTTPServer | None = None

    def start(self) -> str:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_POST(self) -> None:  # noqa: N802 — http.server's name
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                fake.requests.append(({k.lower(): v for k, v in self.headers.items()}, body))
                last = body["messages"][-1]
                content = last.get("content") or ""
                offered = [t["function"]["name"] for t in body.get("tools") or []]
                message: dict[str, Any]
                if body["messages"][0].get("content") == DURABLE_STEP_INSTRUCTION:
                    message = {"role": "assistant", "content": f"step answer: {content}"}
                elif last["role"] == "tool":
                    message = {"role": "assistant", "content": f"done: {content}"}
                elif content.startswith("durable: ") and START_WORKFLOW in offered:
                    call = {
                        "id": TOOL_CALL_ID,
                        "type": "function",
                        "function": {
                            "name": START_WORKFLOW,
                            "arguments": json.dumps({"name": "durable-task", "input": {"task": content[9:]}}),
                        },
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
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def stop(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()


def _kinds(subjects: list[str]) -> list[str]:
    return [".".join(s.removeprefix("$JS.API.").split(".")[:2]) for s in subjects]


@pytest.mark.skipif(binary is None, reason="nats-server not on PATH")
async def test_a_durable_run_names_the_served_thread_and_the_tool_call_and_creates_nothing() -> None:
    users = {name: new_user() for name in ("caller", "agent", "tenant")}
    server = LocalNatsServer.start_tenant(binary, list(users.values()), max_streams=7)  # type: ignore[arg-type]
    fake = _Fake()
    proxy_url = fake.start()
    advisories: list[str] = []
    try:
        nc_tenant = await nats.connect(server.url, nkeys_seed_str=users["tenant"].seed, name="tenant")
        nc_caller = await nats.connect(server.url, nkeys_seed_str=users["caller"].seed, name="caller")

        async def api(subject: str, body: Any = None) -> dict[str, Any]:
            msg = await nc_tenant.request(subject, json.dumps(body or {}).encode(), timeout=5)
            reply: dict[str, Any] = json.loads(msg.data)
            if "error" in reply:
                raise AssertionError(f"{subject}: {reply['error']}")
            return reply

        # The seven, as the fabric's onboarding creates them, at R1 on one node.
        for name in SEVEN:
            config = json.loads((FIXTURES / f"{name}.json").read_text(encoding="utf-8"))
            await api(f"$JS.API.STREAM.CREATE.{name}", {**config, "num_replicas": 1})

        # Every JetStream API request the account audits from here on.
        async def audit(msg: Any) -> None:
            a = json.loads(msg.data)
            if (a.get("client") or {}).get("name") != "tenant":
                advisories.append(a["subject"])

        await nc_tenant.subscribe("$JS.EVENT.ADVISORY.API", cb=audit)
        await nc_tenant.flush()

        cfg = AgentConfig(
            nats=NatsConfig(url=server.url, nkey=server.write_seed_file(users["agent"], "agent")),
            agent=AgentIdentityConfig(
                kind="assistant", owner="test", name="durable", description="the agent under test",
                system_prompt="You are under test.", min_sender_trust="any", tools="blocking",
                heartbeat_interval_s=None, max_history_exchanges=0, ready_file=None,
            ),
            model=ModelConfig(proxy_url=proxy_url, virtual_key="vk-test", model="fake-1", timeout_s=None),
            reply_timeout_s=20.0,
            durable=True,
        )
        agent = await start_agent(cfg, log=lambda _line: None, env={})
        # The advisories are asynchronous.
        await asyncio.sleep(1.0)
        start_advisories = list(advisories)
        tracing = fabric_tracing()
        caller = Agents(
            nc=nc_caller,
            identity=Identity(signer=signer_from_seed(users["caller"].seed)),
            interceptors=[tracing.prompt_interceptor],
        )
        try:
            found = await caller.discover(timeout=1.0, filter=DiscoverFilter(agent="assistant"))
            assert found
            parts: list[str] = []
            async for m in found[0].prompt("durable: count to three"):
                if isinstance(m, ResponseChunk):
                    parts.append(m.text)
            reply = "".join(parts)

            # The served prompt's first model call names its thread.
            served_headers, served_body = fake.requests[0]
            assert START_WORKFLOW in [t["function"]["name"] for t in served_body["tools"]]
            thread = served_headers["x-synadia-thread-id"]
            root = served_headers["x-synadia-root-id"]
            run_id = f"{thread}-{SANITISED}"

            # The tool's result came back to the model, and the reply carries it.
            assert json.loads(reply.removeprefix("done: ")) == {
                "run_id": run_id,
                "result": {"task": "count to three", "answer": "step answer: count to three"},
            }

            # The journal's start entry, read back as the tenant.
            got = await api("$JS.API.STREAM.MSG.GET.DE_JOURNAL", {"seq": 1, "next_by_subj": f"de.journal.{run_id}"})
            assert got["message"]["subject"] == f"de.journal.{run_id}"
            start = json.loads(base64.b64decode(got["message"]["data"]))
            assert start["kind"] == "start"
            assert start["wf"] == "durable-task"
            assert start["input"] == {
                "input": {"task": "count to three"},
                "trace": {"thread_id": thread, "root_id": root},
            }

            # The step's model call, made on the worker, carried the same trace.
            step = next(h for h, b in fake.requests if b["messages"][0].get("content") == DURABLE_STEP_INSTRUCTION)
            assert step["x-synadia-thread-id"] == thread
            assert step["x-synadia-root-id"] == root

            # Nothing created, nothing changed: not at the worker's start, not by the run.
            await asyncio.sleep(0.5)
            touched = [k for k in _kinds(advisories) if k in ("STREAM.CREATE", "STREAM.UPDATE")]
            assert start_advisories
            assert touched == []
            assert sorted((await api("$JS.API.STREAM.NAMES"))["streams"]) == sorted(SEVEN)
            assert (await api("$JS.API.CONSUMER.NAMES.DE_WORK"))["consumers"] == ["de-worker-durable-task"]
            assert (await api("$JS.API.CONSUMER.NAMES.DE_TIMERS"))["consumers"] == ["de-timer-durable-task"]

            # The evidence, for whoever reads the run's output (pytest -s).
            print(
                json.dumps(
                    {
                        "run_id": run_id,
                        "start_input": start["input"],
                        "step_headers": {"thread": step["x-synadia-thread-id"], "root": step["x-synadia-root-id"]},
                        "worker_start_advisories": len(start_advisories),
                        "worker_start_kinds": dict(Counter(_kinds(start_advisories))),
                        "stream_creates_or_updates": len(touched),
                    }
                )
            )
        finally:
            await caller.close()
            await agent.stop()
            await nc_caller.close()
            await nc_tenant.close()
    finally:
        fake.stop()
        server.stop()
