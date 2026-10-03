"""The two reference agents word their durable pieces the same.

The ``start_workflow`` tool is defined word for word the same in both
languages, as the agent tools are, so a model is shown the same tool whichever
agent it runs in; the workflow names are the same, so either agent's worker
runs the other's runs; and the words a step tells the model are the same.
Compares the bytes against ``typescript/test/harness/durable-bytes.ts``.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from fabric_agent.durable import (
    DURABLE_STEP_INSTRUCTION,
    DURABLE_TASK,
    START_WORKFLOW,
    hosted_workflows,
    start_workflow_tool,
)
from fabric_agent.durable_agent import AGENT_LOOP, NO_REPLY

TS_DIR = Path(__file__).resolve().parents[2] / "typescript"
node = shutil.which("node")
ts_ready = (TS_DIR / "node_modules" / "tsx").is_dir()


def _bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


@pytest.mark.skipif(node is None or not ts_ready, reason="needs node and reference-agents/typescript installed")
def test_the_durable_pieces_are_byte_identical_across_the_agents() -> None:
    out = subprocess.run(
        [node, "--import", "tsx", "test/harness/durable-bytes.ts"],  # type: ignore[list-item]
        cwd=TS_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert out.returncode == 0, out.stderr
    ts = [json.loads(line).encode() for line in out.stdout.strip().split("\n")]
    # The workflows close over a model client they never call here.
    py = [
        _bytes(start_workflow_tool(hosted_workflows(None))),  # type: ignore[arg-type]
        _bytes([START_WORKFLOW, DURABLE_TASK, AGENT_LOOP]),
        _bytes(DURABLE_STEP_INSTRUCTION),
        _bytes(NO_REPLY),
    ]
    assert ts == py
