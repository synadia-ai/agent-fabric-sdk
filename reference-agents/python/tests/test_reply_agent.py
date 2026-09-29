"""Real signed agent handlers; only the HTTP model and external ScratchPad are stubs."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import nats
import pytest
from synadia_ai.agent_fabric import fabric_tracing
from synadia_ai.agents import Agents, DiscoverFilter, Identity, ResponseChunk, signer_from_seed

from fabric_agent.agent import start_agent
from fabric_agent.config import AgentConfig, AgentIdentityConfig, ModelConfig, NatsConfig
from tests.test_agent import FakePad
from tests.harness.nats_server import LocalNatsServer, nats_server_on_path, new_user
from tests.test_reply import CASES

REFERENCE = json.loads((Path(__file__).parents[3] / "test-fixtures/scratchpad/reference-v2.json").read_text())["token"]


@pytest.mark.parametrize("item", CASES, ids=lambda item: item["name"])
async def test_bounded_reply_through_actual_agent(item):
    binary = nats_server_on_path()
    assert binary is not None, "bounded reply behavior tests require nats-server"
    caller_user, agent_user = new_user(), new_user()
    server = LocalNatsServer.start(binary, [caller_user, agent_user])
    requests = []
    text = item["unit"] * item["repeat"] + item["suffix"]
    model_reply = [text]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            body = json.dumps({"id": "bounded-model", "object": "chat.completion", "model": "fixture",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": model_reply[0]}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    model = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=model.serve_forever, daemon=True)
    thread.start()
    nc = caller = agent = None
    failure = "PRIVATE_PROVIDER_ERROR" + "e" * 100000

    class Pad(FakePad):
        @staticmethod
        def token(_path):
            return REFERENCE

        async def owns(self, reference):
            return reference == REFERENCE

        async def commit(self, value, path, trace):
            token = await super().commit(value, path, trace)
            if item["mode"] == "publish-failure":
                raise RuntimeError(failure)
            return token

        async def grant_read(self, *args, **kwargs):
            if item["mode"] == "grant-failure":
                raise RuntimeError(failure)
            await super().grant_read(*args, **kwargs)

    pad = Pad()
    try:
        nc = await nats.connect(server.url, nkeys_seed_str=caller_user.seed)
        tracing = fabric_tracing()
        caller = Agents(nc=nc, identity=None if item["mode"] == "unsigned" else Identity(signer=signer_from_seed(caller_user.seed)),
                        interceptors=[tracing.prompt_interceptor])
        cfg = AgentConfig(nats=NatsConfig(url=server.url, nkey=server.write_seed_file(agent_user, "agent")),
            agent=AgentIdentityConfig(kind="delivery", owner="test", name="main", description="bounded delivery test",
                system_prompt="test", min_sender_trust="any", tools="none", heartbeat_interval_s=None, max_history_exchanges=2, ready_file=None),
            model=ModelConfig(proxy_url=f"http://127.0.0.1:{model.server_address[1]}", virtual_key="fixture", model="fixture", timeout_s=5),
            reply_timeout_s=5)
        agent = await start_agent(cfg, log=lambda _line: None, env={}, scratchpad=None if item["mode"] == "absent" else pad)
        found = await caller.discover(timeout=0.2, filter=DiscoverFilter(agent="delivery"))
        assert len(found) == 1 and found[0].id_sig_verified

        async def prompt():
            parts = []
            async for message in found[0].prompt("short input", max_wait_s=5):
                if isinstance(message, ResponseChunk):
                    parts.append(message.text)
            return "".join(parts)

        reply = await prompt()
        assert [value[0] for value in pad.commits] == ([] if item["mode"] == "absent" else [text])
        assert len(pad.grants) == (1 if item["mode"] == "granted" else 0)
        if pad.grants:
            assert pad.grants[0][1].user == caller_user.public_key
        reference = pad.token(pad.commits[0][1]) if pad.commits else None
        if item["large"]:
            assert len(reply.encode()) < 1024 and text not in reply
            assert str(item["bytes"]) in reply and "PRIVATE_PROVIDER_ERROR" not in reply
            if item["mode"] == "granted":
                assert reply == f"Result stored in ScratchPad ({item['bytes']} UTF-8 bytes). Read the granted reference to retrieve it.\n\n{reference}"
            else:
                assert reply.startswith("Delivery refused:") and "sp-ref:" not in reply
        else:
            assert reply == text + (f"\n\n{reference}" if item["mode"] == "granted" else "")
        model_reply[0] = "next"
        await prompt()
        assert len(requests) == 2
        # An unsigned caller is kept no history.
        expected = [] if item["mode"] == "unsigned" else [reply if item["large"] else text]
        assert [m["content"] for m in requests[1]["messages"] if m["role"] == "assistant"] == expected
    finally:
        if agent:
            await agent.stop()
        if caller:
            await caller.close()
        if nc:
            await nc.close()
        model.shutdown()
        model.server_close()
        thread.join(timeout=5)
        server.stop()
