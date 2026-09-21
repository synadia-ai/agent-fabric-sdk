"""Cross-language agreement on the edge record.

The record is the fabric's own wire object, and both packages write it. A
field renamed, reordered, retyped or dropped on one side only would go
unnoticed until a consumer read a mixed-language fleet — so generate one
from each implementation with identical inputs and compare the bytes.

Skips cleanly (never fails) when ``bun`` or the TypeScript package's
dependencies are missing.
"""

from __future__ import annotations

import json
import re
import subprocess

import pytest
from synadia_ai.agents import AgentId

from synadia_ai.agent_fabric import EDGE_RECORD_VERSION, build_edge_record
from tests.interop import TS_DIR, interop_prereqs_missing

# alice in ACME, from test-fixtures/identity/operator/keys.json.
AGENT = AgentId.new(
    "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
    "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
)
THREAD = "a" * 32
PARENT = "b" * 32
ROOT = "c" * 32
# Non-ASCII, with an astral character: `JSON.stringify` writes it raw.
UNICODE_CALL = "call_\u00e9\U0001f642"

# The two volatile fields: a fresh id per record, and wall-clock seconds.
_RECORD_ID = re.compile(r'"record_id":"[0-9a-f]{32}"')
_TS = re.compile(r'"ts":\d+')

pytestmark = pytest.mark.skipif(
    interop_prereqs_missing() is not None, reason=str(interop_prereqs_missing())
)


def _normalise(payload: bytes) -> str:
    text = payload.decode("utf-8")
    text = _RECORD_ID.sub('"record_id":"<id>"', text)
    return _TS.sub('"ts":<ts>', text)


def _typescript_records() -> list[str]:
    """Ask the TypeScript package for the same three records."""
    # The id goes into the script as JSON, so it is plain ASCII on stdin
    # and the JS parser rebuilds the same string.
    unicode_call = json.dumps(UNICODE_CALL)
    script = (
        'import { buildEdgeRecord, EDGE_RECORD_VERSION } from "./src/index.ts";'
        'import { parseAgentId } from "@synadia-ai/agents";'
        "const d = new TextDecoder();"
        f'const agent = parseAgentId("{AGENT}");'
        f'const nested = buildEdgeRecord(agent, "{THREAD}", "{PARENT}", "{ROOT}", "call_1", 7);'
        "console.log(d.decode(nested.payload));"
        f'const root = buildEdgeRecord(agent, "{THREAD}", null, "{THREAD}", null, 0);'
        "console.log(d.decode(root.payload));"
        f'const uni = buildEdgeRecord(agent, "{THREAD}", "{PARENT}", "{ROOT}", {unicode_call}, 1);'
        "console.log(d.decode(uni.payload));"
        "console.log(String(EDGE_RECORD_VERSION));"
    )
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
    return out.stdout.strip().splitlines()


def test_edge_records_are_byte_identical_across_packages() -> None:
    ts_nested, ts_root, ts_unicode, ts_version = _typescript_records()

    py_nested = _normalise(build_edge_record(AGENT, THREAD, PARENT, ROOT, "call_1", 7)[1])
    py_root = _normalise(build_edge_record(AGENT, THREAD, None, THREAD, None, 0)[1])
    py_unicode = _normalise(build_edge_record(AGENT, THREAD, PARENT, ROOT, UNICODE_CALL, 1)[1])

    assert _normalise(ts_nested.encode()) == py_nested
    assert _normalise(ts_root.encode()) == py_root
    assert _normalise(ts_unicode.encode()) == py_unicode, "non-ASCII ids are escaped differently"
    assert int(ts_version) == EDGE_RECORD_VERSION, (
        "the two packages disagree on the edge record schema version"
    )


def test_edge_record_keys_are_in_the_same_order() -> None:
    ts_nested, _, _, _ = _typescript_records()
    py_nested = build_edge_record(AGENT, THREAD, PARENT, ROOT, "call_1", 7)[1]
    assert list(json.loads(ts_nested)) == list(json.loads(py_nested))
