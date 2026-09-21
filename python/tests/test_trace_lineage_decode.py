"""Lineage on the wire is untrusted, bounded input.

``thread_id`` and ``root_id`` are the fabric's only additions to the
envelope — two §5.6 fields the protocol SDK passes through as extras. The
host interceptor adopts them verbatim and ``trace_headers()`` stamps them
on the model requests the agent issues, as header values. So a value that
is not shaped exactly like what the packages mint — 32 lowercase hex
characters — is a malformed envelope (400), never something to adopt: a
CRLF would reach a third party's HTTP stack, a megabyte of garbage would
ride every completion request. The TypeScript package reads the wire the
same way.
"""

from __future__ import annotations

import json
from typing import cast

import pytest
from synadia_ai.agent_service import RequestInterceptorContext, RequestRejectedError
from synadia_ai.agents import PromptInterceptorContext, decode

from synadia_ai.agent_fabric import (
    THREAD_ID_HEX_LEN,
    TraceScope,
    active_trace,
    fabric_tracing,
    is_thread_id,
    random_thread_id,
)

THREAD = "a" * 32
ROOT = "b" * 32


def _wire(**fields: object) -> bytes:
    return json.dumps({"prompt": "x", **fields}).encode()


async def _host_scope(body: bytes) -> TraceScope | None:
    """The scope the handler would run in, for a raw envelope decoded as the SDK decodes it."""
    interceptor = fabric_tracing().request_interceptor
    ctx = RequestInterceptorContext(
        envelope=decode(body), sender=None, subject="agents.prompt.a.o.s", headers={}
    )
    seen: list[TraceScope | None] = []

    async def call_next() -> None:
        seen.append(active_trace())

    await interceptor.around_request(ctx, call_next)
    return seen[0]


async def _refusal(body: bytes) -> RequestRejectedError:
    with pytest.raises(RequestRejectedError) as info:
        await _host_scope(body)
    assert info.value.code == 400
    return info.value


async def test_reads_both_fields() -> None:
    scope = await _host_scope(_wire(thread_id=THREAD, root_id=ROOT))
    assert scope == TraceScope(THREAD, ROOT)
    assert scope is not None and scope.turn_count_hint == [0]


@pytest.mark.parametrize(
    "body",
    [_wire(), _wire(thread_id=None, root_id=None), _wire(thread_id="", root_id="")],
    ids=["absent", "null", "empty"],
)
async def test_treats_absent_null_and_empty_as_no_lineage_and_mints_a_root(body: bytes) -> None:
    scope = await _host_scope(body)
    assert scope is not None
    assert is_thread_id(scope.thread_id)
    assert scope.root_id == scope.thread_id


@pytest.mark.parametrize("value", [123, {}, [], True], ids=["number", "object", "array", "boolean"])
async def test_rejects_a_wrongly_typed_id(value: object) -> None:
    for body in (_wire(thread_id=value, root_id=ROOT), _wire(thread_id=THREAD, root_id=value)):
        err = await _refusal(body)
        assert "must be a string" in err.description


@pytest.mark.parametrize(
    "value",
    [
        "A" * 32,
        "a" * 31,
        "a" * 33,
        "g" * 32,
        "a" * 30 + "\r\nX-Injected: yes",
        " " + "a" * 30 + " ",
        "a" * (1 << 20),
    ],
    ids=[
        "uppercase-hex",
        "one-short",
        "one-long",
        "non-hex",
        "header-injection",
        "whitespace",
        "megabyte",
    ],
)
async def test_rejects_a_malformed_id(value: str) -> None:
    for body in (
        _wire(thread_id=value, root_id=ROOT),
        _wire(thread_id=THREAD, root_id=value),
        _wire(thread_id=value),
        _wire(root_id=value),
    ):
        err = await _refusal(body)
        assert f"must be {THREAD_ID_HEX_LEN} lowercase hex characters" in err.description


@pytest.mark.parametrize(
    "body",
    [
        _wire(thread_id=THREAD),
        _wire(root_id=ROOT),
        _wire(thread_id=THREAD, root_id=""),
        _wire(thread_id=None, root_id=ROOT),
    ],
    ids=["thread-alone", "root-alone", "thread-with-empty-root", "root-with-null-thread"],
)
async def test_rejects_a_half_pair(body: bytes) -> None:
    """The pair travels together: a caller that traces sends both, one that
    does not sends neither. Exactly one names a broken or hand-written
    caller, and adopting the lone field would file the execution under a
    tree the caller never named — so it is rejected like a wrongly shaped
    id, in both packages."""
    err = await _refusal(body)
    assert err.description == "malformed envelope: thread_id and root_id must be given together"


async def test_accepts_exactly_what_the_caller_mints() -> None:
    ctx = cast("PromptInterceptorContext", type("Ctx", (), {"context": {}})())
    extras = await fabric_tracing().prompt_interceptor.before_prompt(ctx)
    scope = await _host_scope(json.dumps({"prompt": "x", **extras.fields}).encode())
    assert scope == TraceScope(
        cast("str", extras.fields["thread_id"]), cast("str", extras.fields["root_id"])
    )


async def test_leaves_the_handlers_errors_to_the_sdk() -> None:
    interceptor = fabric_tracing().request_interceptor
    ctx = RequestInterceptorContext(envelope=decode(_wire()), sender=None, subject="s", headers={})
    boom = RuntimeError("handler failed")

    async def call_next() -> None:
        raise boom

    with pytest.raises(RuntimeError) as info:
        await interceptor.around_request(ctx, call_next)
    assert info.value is boom
    assert active_trace() is None


def test_is_thread_id_matches_what_the_package_mints() -> None:
    minted = random_thread_id()
    assert len(minted) == THREAD_ID_HEX_LEN
    assert is_thread_id(minted)
    assert is_thread_id(THREAD)
    assert not is_thread_id(THREAD.upper())
    assert not is_thread_id("")
