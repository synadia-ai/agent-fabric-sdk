"""Both packages bound the tool call id the same way, and write the same record.

The id a caller passes labels the edge record. The bound is in Unicode
code points — what ``len()`` counts, and what the TypeScript package
counts too instead of UTF-16 units — so a mixed-language fleet accepts
exactly the same ids. A lone surrogate has no UTF-8 form and is rejected
on both sides. The record itself writes non-ASCII text raw, as
``JSON.stringify`` does, so the two packages stay byte-identical.
"""

from __future__ import annotations

import json
import re
import time

import pytest
from synadia_ai.agents import AgentId

from synadia_ai.agent_fabric import (
    EDGE_RECORD_VERSION,
    TOOL_CALL_ID_MAX,
    build_edge_record,
    valid_tool_call_id,
)
from tests.support import edge_schema_errors

THREAD = "a" * 32
PARENT = "b" * 32
ROOT = "c" * 32
# alice in ACME, from test-fixtures/identity/operator/keys.json: the
# operator-mode `{account NKEY}.{user NKEY}` form the schema requires.
ACME = "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS"
ALICE = "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA"
AGENT = AgentId.new(ACME, ALICE)


def test_accepts_an_ordinary_id() -> None:
    assert valid_tool_call_id("call_1")
    assert valid_tool_call_id("toolu_01A09q90qw90lq917835lq9")


def test_rejects_an_empty_id() -> None:
    assert not valid_tool_call_id("")


def test_bounds_the_length_in_code_points() -> None:
    assert valid_tool_call_id("a" * TOOL_CALL_ID_MAX)
    assert not valid_tool_call_id("a" * (TOOL_CALL_ID_MAX + 1))
    assert valid_tool_call_id("\U0001f642" * TOOL_CALL_ID_MAX)
    assert not valid_tool_call_id("\U0001f642" * (TOOL_CALL_ID_MAX + 1))


def test_rejects_a_lone_surrogate_half() -> None:
    assert not valid_tool_call_id("\ud83d")
    assert not valid_tool_call_id("call_\ude42")
    assert not valid_tool_call_id("a\ud83db")


def test_the_record_writes_a_non_ascii_id_raw() -> None:
    _, payload = build_edge_record(AGENT, THREAD, None, THREAD, "call_\u00e9\U0001f642", 0)
    assert b'"tool_call_id":"call_\xc3\xa9\xf0\x9f\x99\x82"' in payload
    assert b"\\u" not in payload
    assert json.loads(payload)["tool_call_id"] == "call_\u00e9\U0001f642"


def test_record_id_shares_the_thread_id_shape() -> None:
    record_id, payload = build_edge_record(AGENT, THREAD, None, THREAD, None, 0)
    assert re.fullmatch(r"[0-9a-f]{32}", record_id)
    assert json.loads(payload)["record_id"] == record_id


def test_the_record_names_its_writer() -> None:
    _, payload = build_edge_record(AGENT, THREAD, None, THREAD, None, 0)
    record = json.loads(payload)
    assert record["agent"] == f"{ACME}.{ALICE}"
    # The writer sits where the design's table puts it: after `ts`, before the ids.
    assert list(record) == [
        "version",
        "kind",
        "record_id",
        "ts",
        "agent",
        "thread_id",
        "parent_id",
        "root_id",
        "tool_call_id",
        "turn_count_hint",
    ]


def test_is_version_1_of_kind_edge_stamped_in_unix_seconds() -> None:
    before = int(time.time())
    record = json.loads(build_edge_record(AGENT, THREAD, PARENT, ROOT, "call_1", 7)[1])
    assert EDGE_RECORD_VERSION == 1
    assert record["version"] == 1
    assert record["kind"] == "edge"
    assert (record["thread_id"], record["parent_id"], record["root_id"]) == (THREAD, PARENT, ROOT)
    assert (record["tool_call_id"], record["turn_count_hint"]) == ("call_1", 7)
    assert before <= record["ts"] <= int(time.time())


@pytest.mark.parametrize(
    ("thread", "parent", "root", "call", "turns"),
    [
        (THREAD, None, THREAD, None, 0),
        (THREAD, PARENT, ROOT, "call_1", 7),
        (THREAD, PARENT, ROOT, "call_\u00e9\U0001f642", 1),
    ],
    ids=["root", "child", "non-ascii-tool-call-id"],
)
def test_validates_against_edge_json(
    thread: str, parent: str | None, root: str, call: str | None, turns: int
) -> None:
    """The contract: ``docs/schemas/edge.json``, vendored under ``test-fixtures/schemas/``."""
    record = json.loads(build_edge_record(AGENT, thread, parent, root, call, turns)[1])
    assert edge_schema_errors(record) == []


def test_the_schema_would_refuse_a_record_that_broke_the_contract() -> None:
    record = json.loads(build_edge_record(AGENT, THREAD, None, THREAD, None, 0)[1])
    assert edge_schema_errors({**record, "thread_id": "A" * 32}) != []
    assert edge_schema_errors({**record, "extra": 1}) != []
