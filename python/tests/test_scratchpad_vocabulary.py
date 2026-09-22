"""The references' vocabulary and the grant request's wire shapes, without a server.

``typescript/test/unit/scratchpad-vocabulary.test.ts`` is the twin.
"""

from __future__ import annotations

import base64
import json

import pytest

from synadia_ai.agent_fabric import (
    READS_REFERENCES_KEY,
    Grantee,
    encode_grant_reply,
    encode_grant_request,
    find_references,
    grant_subject,
    grantee_from_identity,
    reads_references,
    reference_creator,
    remove_references,
)
from tests.scratchpad_fake import make_reference
from tests.support import grant_reply_schema_errors, grant_request_schema_errors

A = make_reference("vol-a", "/a.md", "agents.prompt.writer.acme.w1")
B = make_reference("vol-b", "/b.md")


def _token(made: object) -> str:
    return "sp-ref:" + base64.urlsafe_b64encode(json.dumps(made).encode()).decode().rstrip("=")


def test_find_references_finds_every_token_in_order_repeats_included() -> None:
    assert find_references(f"first {A}, then {B} and {A} again") == [A, B, A]


def test_find_references_finds_none_in_plain_text() -> None:
    assert find_references("sp-ref: alone, and sp-ref:") == []


def test_a_token_stops_at_the_first_character_outside_base64url() -> None:
    assert find_references("(sp-ref:abc_-9.)") == ["sp-ref:abc_-9"]


def test_remove_references_takes_every_token_out_and_tidies_what_that_leaves() -> None:
    text = f"Read this:  {A}\n\n\n\nand {B}   \nthanks"
    assert remove_references(text) == "Read this:\n\nand\nthanks"


def test_remove_references_takes_out_only_the_tokens_listed_every_occurrence() -> None:
    assert remove_references(f"{A} {B} {A}", [A]) == B


def test_remove_references_leaves_nothing_of_a_text_that_was_only_references() -> None:
    assert remove_references(f" {A}\n{B} ") == ""


def test_reference_creator_reads_the_creators_prompt_address() -> None:
    assert reference_creator(A) == "agents.prompt.writer.acme.w1"


def test_reference_creator_is_none_for_a_token_that_names_none() -> None:
    assert reference_creator(B) is None


@pytest.mark.parametrize(
    "token",
    [
        "sp-ref:not-json",
        "sp-ref:",
        _token(["creator"]),
        _token({"creator": ""}),
        _token({"creator": 7}),
    ],
)
def test_reference_creator_is_none_for_a_token_without_a_creator(token: str) -> None:
    assert reference_creator(token) is None


def test_reference_creator_is_none_for_anything_that_is_not_a_reference() -> None:
    assert reference_creator("agents.prompt.writer.acme.w1") is None


def test_reads_references_is_true_only_for_the_key_set_to_the_string_true() -> None:
    assert READS_REFERENCES_KEY == "scratchpad_refs_ok"
    assert reads_references({"scratchpad_refs_ok": "true"}) is True
    assert reads_references({"scratchpad_refs_ok": "True"}) is False
    assert reads_references({"scratchpad_refs_ok": "1"}) is False
    assert reads_references({}) is False


def test_grantee_from_identity_splits_at_the_first_dot() -> None:
    assert grantee_from_identity("ACME.alice") == Grantee("ACME", "alice")
    assert grantee_from_identity("$G.u.v") == Grantee("$G", "u.v")


@pytest.mark.parametrize("identity", ["", "alice", ".alice", "ACME."])
def test_grantee_from_identity_refuses(identity: str) -> None:
    with pytest.raises(ValueError, match="not an agent identity"):
        grantee_from_identity(identity)


def test_grant_subject_is_the_prompt_address_with_the_verb_changed() -> None:
    assert grant_subject("agents.prompt.writer.acme.w1") == "agents.sp-grant.writer.acme.w1"


@pytest.mark.parametrize(
    "address", ["agents.status.writer.acme.w1", "agents.prompt.", "prompt.writer", ""]
)
def test_grant_subject_refuses(address: str) -> None:
    with pytest.raises(ValueError, match="not a prompt address"):
        grant_subject(address)


THREAD, ROOT = "a" * 32, "b" * 32


def test_a_request_is_written_in_the_schemas_key_order_whatever_order_it_was_given() -> None:
    data = encode_grant_request(
        {
            "trace": {"tool_call_id": "toolu_1", "root_id": ROOT, "thread_id": THREAD},
            "grantee": "ACME.carol",
            "reference": A,
        }
    )
    assert (
        data
        == (
            f'{{"reference":"{A}","grantee":"ACME.carol","trace":{{"thread_id":"{THREAD}",'
            f'"root_id":"{ROOT}","tool_call_id":"toolu_1"}}}}'
        ).encode()
    )
    assert grant_request_schema_errors(json.loads(data)) == []


def test_a_request_leaves_out_what_it_was_not_given() -> None:
    assert encode_grant_request({"reference": A, "grantee": "ACME.carol"}) == (
        f'{{"reference":"{A}","grantee":"ACME.carol"}}'.encode()
    )
    data = encode_grant_request(
        {"reference": A, "grantee": "ACME.carol", "trace": {"thread_id": THREAD, "root_id": ROOT}}
    )
    assert (
        data
        == (
            f'{{"reference":"{A}","grantee":"ACME.carol","trace":'
            f'{{"thread_id":"{THREAD}","root_id":"{ROOT}"}}}}'
        ).encode()
    )
    assert grant_request_schema_errors(json.loads(data)) == []


def test_a_grant_and_a_refusal_are_written_as_the_reply_schema_has_them() -> None:
    assert encode_grant_reply({"granted": True}) == b'{"granted":true}'
    assert encode_grant_reply({"granted": False, "reason": "no"}) == (
        b'{"granted":false,"reason":"no"}'
    )
    for reply in (b'{"granted":true}', b'{"granted":false,"reason":"no"}'):
        assert grant_reply_schema_errors(json.loads(reply)) == []
    assert grant_reply_schema_errors({"granted": False}) != []
    assert grant_reply_schema_errors({"granted": True, "reason": "x"}) != []
