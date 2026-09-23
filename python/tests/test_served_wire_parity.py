"""Cross-language agreement on the served record.

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

from synadia_ai.agent_fabric import SERVED_RECORD_VERSION, build_served_record
from tests.interop import TS_DIR, interop_prereqs_missing

# alice in ACME, from test-fixtures/identity/operator/keys.json.
AGENT = AgentId.new(
    "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
    "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
)
THREAD = "a" * 32
ROOT = "c" * 32
TRACE_ID = "9f2c4b1e8a7d33051c6e0b42d78a91f0"
SESSION = "317f624b-c7c6-4b27-936b-c0de80892e6d"
# Non-ASCII, with an astral character: `JSON.stringify` writes it raw.
UNICODE_ID = "s\u00e9\U0001f642"

# The one volatile field when `ts` is given: a fresh id per record.
_RECORD_ID = re.compile(r'"record_id":"[0-9a-f]{32}"')

pytestmark = pytest.mark.skipif(
    interop_prereqs_missing() is not None, reason=str(interop_prereqs_missing())
)


def _normalise(payload: bytes) -> str:
    return _RECORD_ID.sub('"record_id":"<id>"', payload.decode("utf-8"))


def _typescript_records() -> list[str]:
    """Ask the TypeScript package for the same three records."""
    # The id goes into the script as JSON, so it is plain ASCII on stdin
    # and the JS parser rebuilds the same string.
    unicode_id = json.dumps(UNICODE_ID)
    script = (
        'import { buildServedRecord, SERVED_RECORD_VERSION } from "./src/index.ts";'
        'import { parseAgentId } from "@synadia-ai/agents";'
        "const d = new TextDecoder();"
        f'const agent = parseAgentId("{AGENT}");'
        f'const start = buildServedRecord(agent, "{THREAD}", "{ROOT}", "openclaw", '
        f'"{TRACE_ID}", "start", undefined, 1700000000);'
        "console.log(d.decode(start.payload));"
        f'const end = buildServedRecord(agent, "{THREAD}", "{ROOT}", "claude", '
        f'"{SESSION}", "end", "timeout", 1700000001);'
        "console.log(d.decode(end.payload));"
        f'const uni = buildServedRecord(agent, "{THREAD}", "{ROOT}", "claude", '
        f'{unicode_id}, "end", "ok", 1700000002);'
        "console.log(d.decode(uni.payload));"
        "console.log(String(SERVED_RECORD_VERSION));"
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


def test_served_records_are_byte_identical_across_packages() -> None:
    ts_start, ts_end, ts_unicode, ts_version = _typescript_records()

    py_start = build_served_record(
        AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start", None, 1_700_000_000
    )[1]
    py_end = build_served_record(
        AGENT, THREAD, ROOT, "claude", SESSION, "end", "timeout", 1_700_000_001
    )[1]
    py_unicode = build_served_record(
        AGENT, THREAD, ROOT, "claude", UNICODE_ID, "end", "ok", 1_700_000_002
    )[1]

    assert _normalise(ts_start.encode()) == _normalise(py_start)
    assert _normalise(ts_end.encode()) == _normalise(py_end)
    assert _normalise(ts_unicode.encode()) == _normalise(py_unicode), (
        "non-ASCII ids are escaped differently"
    )
    assert int(ts_version) == SERVED_RECORD_VERSION, (
        "the two packages disagree on the served record schema version"
    )


def test_served_record_keys_are_in_the_same_order() -> None:
    ts_start, ts_end, _, _ = _typescript_records()
    py_start = build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start")[1]
    py_end = build_served_record(AGENT, THREAD, ROOT, "claude", SESSION, "end", "timeout")[1]
    assert list(json.loads(ts_start)) == list(json.loads(py_start))
    assert list(json.loads(ts_end)) == list(json.loads(py_end))
