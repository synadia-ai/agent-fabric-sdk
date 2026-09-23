"""Both packages hold the harness thread id to the same rule, and write the same served record.

The id names the harness's own thread — Claude Code's session id,
OpenClaw's 32-hex trace id — bare, next to the harness's name. The bound
is in Unicode code points, what ``len()`` counts and what the TypeScript
package counts too instead of UTF-16 units, the character class is the
SDK's subject-token class, and a lone surrogate, which has no UTF-8 form,
is rejected on both sides. The record itself writes non-ASCII text raw,
as ``JSON.stringify`` does, so the two packages stay byte-identical.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pytest
from synadia_ai.agents import AgentId

from synadia_ai.agent_fabric import (
    HARNESS_THREAD_ID_MAX,
    SERVED_RECORD_VERSION,
    build_served_record,
    unix_seconds,
    valid_harness_thread_id,
)
from tests.support import served_schema_errors

THREAD = "a" * 32
ROOT = "c" * 32
# alice in ACME, from test-fixtures/identity/operator/keys.json: the
# operator-mode `{account NKEY}.{user NKEY}` form the schema requires.
ACME = "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS"
ALICE = "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA"
AGENT = AgentId.new(ACME, ALICE)
#: OpenClaw's harness thread id: the 32-hex trace id of its ``traceparent``.
TRACE_ID = "9f2c4b1e8a7d33051c6e0b42d78a91f0"
#: Claude Code's: the session id.
SESSION = "317f624b-c7c6-4b27-936b-c0de80892e6d"


def test_accepts_the_two_harnesses_ids() -> None:
    assert valid_harness_thread_id(TRACE_ID)
    assert valid_harness_thread_id(SESSION)


@pytest.mark.parametrize(
    "bad",
    [None, 42, "", " ", "has space", "a\nb", "a\tb", "a\x00b", "a\u2028b", "a\ufeffb"],
)
def test_refuses_what_a_header_value_can_never_hold(bad: object) -> None:
    assert not valid_harness_thread_id(bad)


def test_bounds_the_length_in_code_points() -> None:
    assert valid_harness_thread_id("a" * HARNESS_THREAD_ID_MAX)
    assert not valid_harness_thread_id("a" * (HARNESS_THREAD_ID_MAX + 1))
    assert valid_harness_thread_id("\U0001f642" * HARNESS_THREAD_ID_MAX)
    assert not valid_harness_thread_id("\U0001f642" * (HARNESS_THREAD_ID_MAX + 1))


def test_rejects_a_lone_surrogate_half() -> None:
    assert not valid_harness_thread_id("\ud83d")
    assert not valid_harness_thread_id("s_\ude42")


def test_writes_the_start_record_in_the_schemas_key_order_with_no_status() -> None:
    before = unix_seconds()
    record_id, payload = build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start")
    record = json.loads(payload)
    assert list(record) == [
        "version",
        "kind",
        "record_id",
        "ts",
        "agent",
        "thread_id",
        "root_id",
        "harness",
        "harness_thread_id",
        "phase",
    ]
    ts = record.pop("ts")
    assert record == {
        "version": SERVED_RECORD_VERSION,
        "kind": "served",
        "record_id": record_id,
        "agent": f"{ACME}.{ALICE}",
        "thread_id": THREAD,
        "root_id": ROOT,
        "harness": "openclaw",
        "harness_thread_id": TRACE_ID,
        "phase": "start",
    }
    assert before <= ts <= unix_seconds()
    assert SERVED_RECORD_VERSION == 1


def test_record_id_shares_the_thread_id_shape() -> None:
    record_id, payload = build_served_record(AGENT, THREAD, ROOT, "claude", SESSION, "start")
    assert re.fullmatch(r"[0-9a-f]{32}", record_id)
    assert json.loads(payload)["record_id"] == record_id


@pytest.mark.parametrize("status", ["ok", "error", "timeout"])
def test_writes_the_end_record_with_its_status_last_and_the_moment_given(status: Any) -> None:
    _, payload = build_served_record(
        AGENT, THREAD, ROOT, "claude", SESSION, "end", status, 1_700_000_000
    )
    record = json.loads(payload)
    assert record["harness"] == "claude"
    assert record["phase"] == "end"
    assert record["status"] == status
    assert record["ts"] == 1_700_000_000
    assert list(record)[-1] == "status"


def test_writes_a_non_ascii_harness_thread_id_raw() -> None:
    _, payload = build_served_record(AGENT, THREAD, ROOT, "claude", "s\u00e9\U0001f642", "start")
    assert b'"harness_thread_id":"s\xc3\xa9\xf0\x9f\x99\x82"' in payload
    assert b"\\u" not in payload


def test_refuses_an_end_without_a_status_and_a_start_with_one() -> None:
    with pytest.raises(ValueError, match="status"):
        build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "end")
    with pytest.raises(ValueError, match="status"):
        build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start", "ok")


def test_refuses_an_unusable_harness_thread_id_a_bad_ts_and_names_it_does_not_know() -> None:
    with pytest.raises(ValueError, match="harness_thread_id"):
        build_served_record(AGENT, THREAD, ROOT, "openclaw", "has space", "start")
    with pytest.raises(ValueError, match="harness_thread_id"):
        build_served_record(AGENT, THREAD, ROOT, "openclaw", "", "start")
    for bad_ts in (1.5, -1, True):
        with pytest.raises(ValueError, match="ts"):
            build_served_record(
                AGENT,
                THREAD,
                ROOT,
                "openclaw",
                TRACE_ID,
                "start",
                None,
                bad_ts,  # type: ignore[arg-type]
            )
    # Off the types, as untyped code would call it.
    with pytest.raises(ValueError, match="harness"):
        build_served_record(AGENT, THREAD, ROOT, "pi", TRACE_ID, "start")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="phase"):
        build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "middle")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="status"):
        build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "end", "cancelled")  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("harness", "harness_thread_id", "phase", "status"),
    [
        ("openclaw", TRACE_ID, "start", None),
        ("openclaw", TRACE_ID, "end", "error"),
        ("claude", SESSION, "start", None),
        ("claude", SESSION, "end", "ok"),
        ("claude", SESSION, "end", "timeout"),
        ("claude", "s\u00e9\U0001f642", "start", None),
    ],
    ids=[
        "openclaw-start",
        "openclaw-end",
        "claude-start",
        "claude-end",
        "timed-out-end",
        "non-ascii-harness-thread-id",
    ],
)
def test_validates_against_served_json(
    harness: Any, harness_thread_id: str, phase: Any, status: Any
) -> None:
    """The contract: ``docs/schemas/served.json``, vendored under ``test-fixtures/schemas/``."""
    _, payload = build_served_record(AGENT, THREAD, ROOT, harness, harness_thread_id, phase, status)
    assert served_schema_errors(json.loads(payload)) == []


def test_the_schema_would_refuse_a_record_that_broke_the_contract() -> None:
    start = json.loads(build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "start")[1])
    end = json.loads(build_served_record(AGENT, THREAD, ROOT, "openclaw", TRACE_ID, "end", "ok")[1])
    assert served_schema_errors({**start, "harness": "pi"}) != []
    assert served_schema_errors({**start, "thread_id": "A" * 32}) != []
    assert served_schema_errors({**start, "harness_thread_id": ""}) != []
    assert served_schema_errors({**start, "extra": 1}) != []
    assert served_schema_errors({k: v for k, v in end.items() if k != "status"}) != []
