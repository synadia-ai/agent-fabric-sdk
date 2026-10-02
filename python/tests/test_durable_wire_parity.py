"""Cross-language agreement on a durable run's id, its input's trace and the headers.

A run id is how a run names the task that started it, so a character
replaced in one language and kept in the other would join a TypeScript
agent's runs and not a Python agent's. Build the same ids, traces and
headers in each implementation and compare the bytes.

Skips cleanly (never fails) when ``bun`` or the TypeScript package's
dependencies are missing.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    TraceScope,
    bind_active_trace,
    durable_headers,
    durable_run_id,
    durable_trace,
)
from tests.interop import TS_DIR, interop_prereqs_missing

pytestmark = pytest.mark.skipif(
    interop_prereqs_missing() is not None, reason=str(interop_prereqs_missing())
)

THREAD, ROOT = "0123456789abcdef" * 2, "fedcba9876543210" * 2

# A dot, the two wildcards, a space, non-ASCII, an astral character, a C0
# control, DEL and U+2028: every place the two replacements could part ways.
TOOL_CALL_IDS = [
    "call_Ab-9",
    "toolu_01.A*B>C D",
    "call_\u00e9\U0001f642\u0001\u007f\u2028",
    "a.b.c",
    "*",
    ">",
    " ",
    "\u00e9",
    "x" * 256,
]

TRACES: list[Any] = [
    {"thread_id": THREAD, "root_id": ROOT},
    {"root_id": ROOT, "thread_id": THREAD},
    {"thread_id": THREAD.upper(), "root_id": ROOT},
    {"thread_id": THREAD},
    None,
    "x",
]


def _python() -> list[str]:
    with bind_active_trace(TraceScope(thread_id=THREAD, root_id=ROOT)):
        ids = [durable_run_id(t) for t in TOOL_CALL_IDS]
        trace = durable_trace()
    lines: list[Any] = [*ids, trace, *(durable_headers(t) for t in TRACES)]
    return [json.dumps(x, separators=(",", ":"), ensure_ascii=False) for x in lines]


def _typescript() -> list[str]:
    script = f"""
import {{ bindActiveTrace, durableHeaders, durableRunId, durableTrace }} from "./src/index.ts";
const scope = {{ threadId: {json.dumps(THREAD)}, rootId: {json.dumps(ROOT)}, turnCountHint: 0 }};
const [ids, trace] = bindActiveTrace(scope, () => [
  {json.dumps(TOOL_CALL_IDS)}.map((t) => durableRunId(t)),
  durableTrace(),
]);
const lines = [...ids, trace, ...{json.dumps(TRACES)}.map((t) => durableHeaders(t))];
for (const line of lines) console.log(JSON.stringify(JSON.stringify(line)));
"""
    out = subprocess.run(
        ["bun", "run", "-"],
        check=False,
        input=script,
        capture_output=True,
        text=True,
        cwd=TS_DIR,
        timeout=60,
    )
    if out.returncode != 0:
        pytest.fail(f"could not run the TypeScript package: {out.stderr.strip()[:400]}")
    # Each line is the bytes as a JSON string; split on newlines only, since
    # `splitlines()` also splits U+2028.
    return [json.loads(line) for line in out.stdout.strip().split("\n")]


def test_run_ids_traces_and_headers_are_byte_identical_across_packages() -> None:
    py = _python()
    ts = _typescript()
    assert [s.encode() for s in ts] == [s.encode() for s in py]
    # And the ids are what the convention says, not merely the same.
    assert py[1] == json.dumps(f"{THREAD}-toolu_01_A_B_C_D")
    assert py[2] == json.dumps(f"{THREAD}-call" + "_" * 6)
