"""Dispatch refuses model targets and never substitutes zero for unknown usage."""

import json

import pytest
from synadia_ai.agent_fabric import NativeScratchPadError

from fabric_agent.scratchpad_usage import ScratchPadUsage
from fabric_agent.tools import NO_TOOLS


class Inspector:
    def __init__(self):
        self.calls = 0
        self.error = None

    async def diagnostics(self):
        self.calls += 1
        if self.error:
            raise self.error
        return {"volume": "Replies", "status": "unbound", "allowance": {"bytes": 1024, "objects": 100}}


@pytest.mark.parametrize("args", ["{}", "", "  "])
async def test_no_argument_provider_output_preserves_unknown_usage(args):
    client = Inspector()
    runner = ScratchPadUsage(NO_TOOLS, client)
    assert len(runner.definitions) == 1
    result = json.loads(await runner.call("scratchpad_usage", args, "call-1"))
    assert result["status"] == "unbound" and "charged" not in result
    assert client.calls == 1
    forwarded = json.loads(await runner.call("discover_agents", "{}", "call-2"))
    assert forwarded["error"] == "this agent has no tools"


@pytest.mark.parametrize("args", ['{"volume":"other"}', '{"credentials":"secret"}', "[]", "null", "bad json"])
async def test_model_cannot_select_volume_or_supply_credentials(args):
    client = Inspector()
    runner = ScratchPadUsage(NO_TOOLS, client)
    assert json.loads(await runner.call("scratchpad_usage", args, "call-1"))["status"] == "invalid"
    assert client.calls == 0


async def test_error_codes_preserved_without_raw_errors_and_unsupported_client_offers_no_tool():
    client = Inspector()
    runner = ScratchPadUsage(NO_TOOLS, client)
    for error in [RuntimeError("PRIVATE_PATH"), NativeScratchPadError("fenced", "PRIVATE_PATH")]:
        client.error = error
        reply = await runner.call("scratchpad_usage", "{}", "call-1")
        assert json.loads(reply) == {
            "status": "error",
            "code": "fenced" if isinstance(error, NativeScratchPadError) else "unavailable",
        }
        assert "PRIVATE" not in reply and "charged" not in reply
    assert ScratchPadUsage(NO_TOOLS).definitions == []
