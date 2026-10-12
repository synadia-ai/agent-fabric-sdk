"""Mutation outcome and bounded-wire checks against a public NATS test double."""

from __future__ import annotations

import asyncio
import copy
import json
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import cast

import pytest
from nats import NATS
from nats.aio.msg import Msg

from synadia_ai.agent_fabric._scratchpad_native import codec as c
from synadia_ai.agent_fabric._scratchpad_native import protocol as p
from synadia_ai.agent_fabric._scratchpad_native.errors import NativeScratchPadError
from synadia_ai.agent_fabric._scratchpad_native.transport import ScratchPadTransport

PRINCIPAL: p.Wire = {
    "account": "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
    "user": "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
}
TARGET: p.Wire = {"volume": "Replies", "creation_id": "ab" * 16}
ROOT = c.EMPTY_ROOT
COMMAND: p.Wire = {
    "creation_id": TARGET["creation_id"],
    "writer": {"slot": 0, "generation": 1},
    "number": 1,
    "operation_id": "publish-1",
    "base": {"generation": 1, "root": ROOT},
    "root": ROOT,
    "trace": {},
    "retention": {"enabled": True, "slot": 0, "generation": 0, "until": 1900000600},
}
RECEIPT: p.Wire = {
    "volume": TARGET["volume"],
    "principal": PRINCIPAL,
    "command": COMMAND,
    "head": {"generation": 2, "root": ROOT},
    "retention": {"slot": 0, "generation": 2},
}


@dataclass
class Reply:
    data: bytes
    headers: dict[str, str] | None


def message(body: object, metadata: p.Wire | None = None) -> Msg:
    return cast(
        Msg,
        Reply(
            data=body if isinstance(body, bytes) else p.go_json(body).encode(),
            headers={p.REPLY_HEADER: p.go_json(metadata or {"code": "ok", "message": ""})},
        ),
    )


class Connection:
    """Only public connection properties and request/flush APIs are modeled."""

    def __init__(self, reply: Msg | BaseException | None = None) -> None:
        self.is_connected, self.is_closed, self.is_draining = True, False, False
        self.max_payload = 1024 * 1024
        self.reply = message(RECEIPT) if reply is None else reply
        self.calls: list[tuple[str, bytes, dict[str, str] | None]] = []
        self.flushes = 0
        self.on_flush: Callable[[], Awaitable[None]] | None = None
        self.on_request: Callable[[], Awaitable[Msg]] | None = None
        self.entered = asyncio.Event()

    async def flush(self) -> None:
        self.flushes += 1
        if self.on_flush:
            await self.on_flush()

    async def request(
        self, subject: str, payload: bytes, *, timeout: float, headers: dict[str, str] | None
    ) -> Msg:
        assert timeout > 0
        self.calls.append((subject, payload, headers))
        self.entered.set()
        if self.on_request:
            return await self.on_request()
        if isinstance(self.reply, BaseException):
            raise self.reply
        return self.reply


def client(connection: Connection, timeout_s: float = 0.1) -> ScratchPadTransport:
    return ScratchPadTransport(cast(NATS, connection), timeout_s)


def publication() -> p.Wire:
    return copy.deepcopy({"target": TARGET, "command": COMMAND})


async def test_publication_is_one_shot_and_preserves_full_command() -> None:
    nc = Connection()
    assert await client(nc).publish(publication()) == RECEIPT
    assert nc.flushes == 1 and len(nc.calls) == 1
    assert nc.calls[0][0] == "sp.v1.api.v2.checkpoint.publish"
    assert json.loads(nc.calls[0][1]) == publication()


async def test_dormant_receipt_does_not_grant_its_former_writer_access() -> None:
    saved = copy.deepcopy(RECEIPT)
    saved["command"]["writer"]["slot"] = 1
    view: p.Wire = {
        "target": TARGET,
        "owner": PRINCIPAL,
        "head": saved["head"],
        "revision": 2,
        "closed": False,
        "epoch": 0,
        "objects": 1,
        "bytes": 4,
        "writers": [{"generation": 1, "number": 0, "write": False} for _ in range(8)],
        "retentions": [{"generation": 0} for _ in range(8)],
        "grants": [{"generation": 0} for _ in range(16)],
    }
    view["writers"][1] = {"generation": 1, "number": 1, "write": False, "receipt": saved}
    observed = await client(Connection(message(view))).get_volume(TARGET)
    assert observed["writers"][1] == view["writers"][1]
    assert "principal" not in observed["writers"][1]
    for corrupt in ("write", "account", "number", "assigned_readonly"):
        changed = copy.deepcopy(view)
        slot = changed["writers"][1]
        if corrupt == "write":
            slot["write"] = True
        elif corrupt == "account":
            slot["receipt"]["principal"]["account"] = (
                "ADYGVCD4O7RNGXKVYEGEU6LQTJFMAWCBI66CZCGTHQ43A7LMGLQUQTME"
            )
        elif corrupt == "number":
            slot["receipt"]["command"]["number"] += 1
        else:
            slot["principal"] = PRINCIPAL
        with pytest.raises(NativeScratchPadError) as failure:
            await client(Connection(message(changed))).get_volume(TARGET)
        assert failure.value.code == "corrupt" and not failure.value.unknown


async def test_optional_zero_trace_matches_go_semantics() -> None:
    request = publication()
    request["command"]["trace"] = {"thread_id": "", "root_id": "", "tool_call_id": ""}
    assert await client(Connection()).publish(request) == RECEIPT


async def test_ready_failure_does_not_transmit() -> None:
    nc = Connection()

    async def lost() -> None:
        raise OSError("disconnected")

    nc.on_flush = lost
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(publication())
    assert caught.value.local and not caught.value.unknown
    assert not nc.calls


@pytest.mark.parametrize("reason", ["timeout", "no responders", "permissions", "reconnect"])
async def test_any_request_failure_is_unknown(reason: str) -> None:
    nc = Connection(OSError(reason))
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(publication())
    assert caught.value.code == "unknown" and caught.value.unknown and not caught.value.local
    assert len(nc.calls) == 1


@pytest.mark.parametrize("mutation", [False, True])
@pytest.mark.parametrize("after_send", [False, True])
async def test_user_cancellation_propagates_before_and_after_send(
    mutation: bool, after_send: bool
) -> None:
    nc = Connection()
    flushing = asyncio.Event()

    async def stalled_flush() -> None:
        flushing.set()
        await asyncio.Future()

    async def stalled() -> Msg:
        return await asyncio.Future()

    if after_send:
        nc.on_request = stalled
    else:
        nc.on_flush = stalled_flush
    transport = client(nc)
    task = asyncio.create_task(transport.publish(publication()) if mutation else transport.info())
    await (nc.entered if after_send else flushing).wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()
    assert len(nc.calls) == int(after_send)


async def test_bounded_reply_deadline_is_unknown() -> None:
    nc = Connection()

    async def stalled() -> Msg:
        return await asyncio.Future()

    nc.on_request = stalled
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc, 0.01).publish(publication())
    assert caught.value.unknown and len(nc.calls) == 1


@pytest.mark.parametrize("code", ["unknown", "unavailable", "internal"])
async def test_service_ambiguous_codes(code: str) -> None:
    nc = Connection(message(b"", {"code": code, "message": "try later"}))
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(publication())
    assert caught.value.unknown and caught.value.code == code


async def test_definite_refusal_requires_empty_body() -> None:
    nc = Connection(message(b"", {"code": "denied", "message": "read only"}))
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(publication())
    assert caught.value.code == "denied" and not caught.value.unknown
    nc.reply = message({"invalid": True}, {"code": "denied", "message": "read only"})
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(publication())
    assert caught.value.unknown


@pytest.mark.parametrize("case", ["operation", "retention", "volume"])
async def test_receipt_mismatch_is_unknown(case: str) -> None:
    receipt = copy.deepcopy(RECEIPT)
    if case == "operation":
        receipt["command"]["operation_id"] = "other"
    elif case == "retention":
        receipt["retention"]["generation"] = 0
    else:
        receipt["volume"] = "Another"
    with pytest.raises(NativeScratchPadError) as caught:
        await client(Connection(message(receipt))).publish(publication())
    assert caught.value.unknown


async def test_request_is_copied_before_readiness_await() -> None:
    nc, request = Connection(), publication()

    async def mutate() -> None:
        request["command"]["operation_id"] = "changed"

    nc.on_flush = mutate
    assert await client(nc).publish(request) == RECEIPT


@pytest.mark.parametrize("case", ["missing", "case-duplicate", "oversized", "duplicate-json"])
async def test_observable_header_defects_are_unknown(case: str) -> None:
    reply = message(RECEIPT)
    assert reply.headers is not None
    if case == "missing":
        reply.headers.clear()
    elif case == "case-duplicate":
        reply.headers[p.REPLY_HEADER.lower()] = reply.headers[p.REPLY_HEADER]
    elif case == "oversized":
        reply.headers["Extra"] = "x" * p.MAX_HEADER_BYTES
    else:
        reply.headers[p.REPLY_HEADER] = '{"code":"ok","code":"denied","message":""}'
    with pytest.raises(NativeScratchPadError) as caught:
        await client(Connection(reply)).publish(publication())
    assert caught.value.unknown


@pytest.mark.parametrize(
    "replacement", ['"volume":"Replies","extra":1', '"volume":"Replies","volume":"Replies"']
)
async def test_unknown_or_duplicate_body_fields_are_unknown(replacement: str) -> None:
    body = p.go_json(RECEIPT).replace('"volume":"Replies"', replacement)
    with pytest.raises(NativeScratchPadError) as caught:
        await client(Connection(message(body.encode()))).publish(publication())
    assert caught.value.unknown


async def test_local_invalid_counter_never_transmits() -> None:
    nc, request = Connection(), publication()
    request["command"]["number"] = True
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(request)
    assert caught.value.local and not caught.value.unknown
    assert nc.flushes == 0 and not nc.calls


async def test_raw_range_correlates_offset_length_and_metadata() -> None:
    stat = {"type": "file", "object": ROOT, "size": 6, "sha256": "ab" * 32, "executable": False}
    meta = {"code": "ok", "message": "", "range": {"stat": stat, "offset": 2, "length": 4}}
    request = {
        "target": TARGET,
        "root": ROOT,
        "path": "/result",
        "trace": {},
        "offset": 2,
        "length": 6,
    }
    nc = Connection(message(b"cdef", meta))
    assert await client(nc).read(request) == {"stat": stat, "offset": 2, "data": b"cdef"}
    nc.reply = message(b"def", meta)
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).read(request)
    assert caught.value.code == "corrupt" and not caught.value.unknown


async def test_prepare_identity_and_verify_epoch_must_match() -> None:
    obj = {"kind": "chnk", "id": c.chunk_id(b"a")}
    progress = {"object": obj, "length": 1, "state": "verified", "next": 0, "code": "ok"}
    nc = Connection(message({"epoch": 7, "objects": [progress]}))
    assert (
        await client(nc).prepare({"target": TARGET, "objects": [{"object": obj, "length": 1}]})
    )["epoch"] == 7
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).prepare({"target": TARGET, "objects": [{"object": obj, "length": 2}]})
    assert caught.value.unknown
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).verify({"target": TARGET, "epoch": 8, "objects": [obj]})
    assert caught.value.unknown


async def test_put_verifies_local_bytes_and_empty_reply() -> None:
    request = {"target": TARGET, "epoch": 0, "object": {"kind": "chnk", "id": c.chunk_id(b"hello")}}
    nc = Connection(message({}))
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).put_prepared(request, b"changed")
    assert caught.value.local and not nc.calls
    await client(nc).put_prepared(request, b"hello")
    assert nc.calls[0][2] == {p.METADATA_HEADER: p.go_json(request)}
    nc.reply = message({"unexpected": True})
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).put_prepared(request, b"hello")
    assert caught.value.unknown


async def test_current_payload_bound_checked_after_flush() -> None:
    nc = Connection()

    async def smaller() -> None:
        nc.max_payload = 1

    nc.on_flush = smaller
    with pytest.raises(NativeScratchPadError) as caught:
        await client(nc).publish(publication())
    assert caught.value.local and not caught.value.unknown and not nc.calls


def test_native_constructor_rejects_older_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "version_info", (3, 11, 9))
    with pytest.raises(NativeScratchPadError, match=r"Python 3\.12"):
        client(Connection())
