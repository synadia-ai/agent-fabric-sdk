"""Short locator parity, intent recovery, and current read authorization."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path
from typing import cast

import pytest
from nats import NATS
from nats.aio.msg import Msg

from synadia_ai.agent_fabric import find_references, remove_references
from synadia_ai.agent_fabric._scratchpad_native import codec as c
from synadia_ai.agent_fabric._scratchpad_native import protocol as p
from synadia_ai.agent_fabric._scratchpad_native import references as r
from synadia_ai.agent_fabric._scratchpad_native.client import native_scratchpad
from synadia_ai.agent_fabric._scratchpad_native.errors import NativeScratchPadError
from synadia_ai.agent_fabric._scratchpad_native.reader import ScratchPadReader
from synadia_ai.agent_fabric._scratchpad_native.store import WorkspaceStore
from tests.test_scratchpad_native_transport import Connection, client, message

VECTOR = json.loads(
    (Path(__file__).parents[2] / "test-fixtures/scratchpad/reference-short-v1.json").read_text()
)
INTENT_VECTOR = json.loads(
    (Path(__file__).parents[2] / "test-fixtures/scratchpad/reference-intent-v1.json").read_text()
)
PAIR, REF = VECTOR["resolved"], VECTOR["resolved"]["expanded"]
PRINCIPAL = {
    "account": REF["account"],
    "user": "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
}
COMMAND = {
    "creation_id": REF["target"]["creation_id"],
    "writer": {"slot": 0, "generation": 1},
    "number": 1,
    "operation_id": "reference-fixture",
    "base": {"generation": 6, "root": REF["root"]},
    "root": REF["root"],
    "trace": {},
    "retention": {
        "enabled": True,
        "slot": REF["retention"]["slot"],
        "generation": REF["retention"]["generation"] - 1,
        "until": REF["expires_at"],
    },
}
RECEIPT = {
    "volume": REF["target"]["volume"],
    "principal": PRINCIPAL,
    "command": COMMAND,
    "head": {"generation": REF["generation"], "root": REF["root"]},
    "retention": REF["retention"],
}
REQUEST = {
    "target": REF["target"],
    "command": COMMAND,
    "reference": {"creator": REF["creator"], "paths": [REF["path"]]},
}
RESULT = {"receipt": RECEIPT, "references": [PAIR]}
CAPABILITIES = {
    "enabled": True,
    "version": 1,
    "prefix": "sp-r1:",
    "token_bytes": 66,
    "paths_per_retention": 8,
    "max_intent_bytes": 3072,
    "max_metadata_bytes": 32768,
}


def test_shared_short_locator_and_expanded_identity() -> None:
    assert len(PAIR["short"]) == 66
    assert r.decode_short_reference(PAIR["short"]) == VECTOR["locator"]
    r.validate_resolved_reference(PAIR)
    assert c.encode_reference(REF) == VECTOR["full_token"]
    assert c.decode_reference(VECTOR["full_token"]) == REF
    assert find_references(f"{PAIR['short']}, {VECTOR['full_token']}") == [
        PAIR["short"],
        VECTOR["full_token"],
    ]
    assert remove_references(f"read {PAIR['short']}") == "read"


def test_copying_errors_and_metadata_mismatch_are_refused() -> None:
    packed = bytearray(base64.urlsafe_b64decode(PAIR["short"][6:]))
    packed[32] = 64
    generation = bytearray(base64.urlsafe_b64decode(PAIR["short"][6:]))
    generation[24:32] = bytes(8)
    for token in (
        PAIR["short"] + "=",
        PAIR["short"][:-1],
        PAIR["short"] + "a",
        "sp-r1:" + base64.urlsafe_b64encode(packed).decode(),
        "sp-r1:" + base64.urlsafe_b64encode(generation).decode(),
    ):
        with pytest.raises(NativeScratchPadError):
            r.decode_short_reference(token)
    with pytest.raises(NativeScratchPadError):
        r.validate_resolved_reference(
            {**PAIR, "expanded": {**REF, "target": {**REF["target"], "volume": "Other"}}}
        )
    with pytest.raises(NativeScratchPadError):
        r.validate_reference_spec({"creator": "writer", "paths": ["/b", "/a"]})
    with pytest.raises(NativeScratchPadError, match="byte bound"):
        r.validate_reference_spec({"creator": "<" * 512, "paths": ["/a"]})


async def test_only_unknown_operation_permits_capability_fallback() -> None:
    assert (
        await client(
            Connection(message(b"", {"code": "invalid", "message": "test refusal"}))
        ).reference_info()
        is None
    )
    assert not (
        await client(Connection(message({**CAPABILITIES, "enabled": False}))).reference_info()
    )["enabled"]
    for changed in ({"version": 2}, {"max_intent_bytes": 4096}):
        with pytest.raises(NativeScratchPadError, match="reply body is malformed"):
            await client(Connection(message({**CAPABILITIES, **changed}))).reference_info()
    for code in ("denied", "unavailable", "unauthenticated"):
        with pytest.raises(NativeScratchPadError) as caught:
            await client(
                Connection(message(b"", {"code": code, "message": "test refusal"}))
            ).reference_info()
        assert caught.value.code == code
    with pytest.raises(NativeScratchPadError):
        await client(Connection(RuntimeError("transport lost"))).reference_info()


def test_go_json_escaping_at_exact_reference_intent_bound() -> None:
    reference = INTENT_VECTOR["reference"]
    assert p.go_json(reference) == INTENT_VECTOR["go_json"]
    assert len(INTENT_VECTOR["go_json"].encode()) == 3072
    r.validate_reference_spec(reference)
    below = {**reference, "paths": [reference["paths"][0], reference["paths"][1][:-1]]}
    assert len(p.go_json(below).encode()) == 3071
    r.validate_reference_spec(below)
    above = {**reference, "paths": [reference["paths"][0], reference["paths"][1] + "x"]}
    assert len(p.go_json(above).encode()) == 3073
    with pytest.raises(NativeScratchPadError, match="byte bound"):
        r.validate_reference_spec(above)


async def test_referenced_receipts_match_the_complete_intent_and_reads_are_not_mutations() -> None:
    nc = Connection(message(RESULT))
    transport = client(nc)
    assert await transport.reference_publish(REQUEST) == RESULT
    assert await transport.reference_receipt(REQUEST) == RESULT
    assert [call[0] for call in nc.calls] == [
        p.SUBJECT_PREFIX + "reference.publish",
        p.SUBJECT_PREFIX + "reference.receipt",
    ]
    for changed in (
        {"creator": "another", "paths": [REF["path"]]},
        {"creator": REF["creator"], "paths": ["/other"]},
    ):
        with pytest.raises(NativeScratchPadError) as caught:
            await transport.reference_receipt({**REQUEST, "reference": changed})
        assert caught.value.code == "corrupt" and not caught.value.unknown
        with pytest.raises(NativeScratchPadError) as caught:
            await transport.reference_publish({**REQUEST, "reference": changed})
        assert caught.value.unknown
    with pytest.raises(NativeScratchPadError) as caught:
        await client(
            Connection(message(b"", {"code": "not_found", "message": "test refusal"}))
        ).reference_receipt(REQUEST)
    assert caught.value.code == "not_found" and not caught.value.unknown


async def test_every_short_read_checks_current_authority_even_with_empty_file_or_warm_cache() -> (
    None
):
    digest = hashlib.sha256(b"").hexdigest()
    stat = {
        "type": "file",
        "object": c.file_object_id(
            c.encode_file_object({"size": 0, "digest": digest, "chunks": []})
        ),
        "size": 0,
        "sha256": digest,
        "executable": False,
    }
    nc = Connection(message(PAIR))
    reader = ScratchPadReader(client(nc), PRINCIPAL)
    assert await reader.resolve_reference(PAIR["short"]) == REF
    nc.reply = message({"reference": PAIR, "stat": stat})
    assert await reader.read_bytes(PAIR["short"]) == b""
    nc.reply = message(b"", {"code": "denied", "message": "test refusal"})
    with pytest.raises(NativeScratchPadError) as caught:
        await reader.read_bytes(PAIR["short"])
    assert caught.value.code == "denied"
    assert [call[0] for call in nc.calls] == [
        p.SUBJECT_PREFIX + verb
        for verb in ("reference.resolve", "reference.stat", "reference.stat")
    ]
    nc.reply = message({"reference": PAIR, "stat": stat})
    assert await ScratchPadReader(client(nc), PRINCIPAL).read_bytes(PAIR["short"]) == b""


async def test_fresh_workspace_recovers_short_reference_without_payload_or_expansion_cache(
    tmp_path: Path,
) -> None:
    state = {
        "version": 1,
        "principal": PRINCIPAL,
        "volume": REF["target"]["volume"],
        "creator": REF["creator"],
        "creation": {"operation_id": "created", "trace": {}},
        "target": REF["target"],
        "writer": COMMAND["writer"],
        "next": 1,
        "grants": [],
        "pending": {
            "kind": "publish",
            "command": COMMAND,
            "path": REF["path"],
            "ttl": 600,
            "reference": REQUEST["reference"],
        },
    }
    store = WorkspaceStore.open(tmp_path)
    store.save(state)
    store.close()
    nc = Connection()
    changed = True

    async def respond() -> Msg:
        subject, body, _ = nc.calls[-1]
        if subject.endswith(".info"):
            return message(
                {
                    "principal": PRINCIPAL,
                    "scopes": [
                        {"volume": REF["target"]["volume"], "objects": 64, "bytes": 8 * 1024 * 1024}
                    ],
                    "limits": p.PUBLIC_LIMITS,
                }
            )
        assert subject == p.SUBJECT_PREFIX + "reference.receipt"
        assert json.loads(body) == REQUEST
        return message(
            {
                "receipt": RECEIPT,
                "references": [{**PAIR, "expanded": {**REF, "creator": "changed"}}],
            }
            if changed
            else RESULT
        )

    nc.on_request = respond
    first = await native_scratchpad(
        nc=cast(NATS, nc), dir=tmp_path, volume=REF["target"]["volume"], creator=REF["creator"]
    )
    with pytest.raises(NativeScratchPadError) as caught:
        await first.recover()
    assert caught.value.code == "corrupt" and not caught.value.unknown
    await first.close()
    changed = False
    reopened = await native_scratchpad(
        nc=cast(NATS, nc), dir=tmp_path, volume=REF["target"]["volume"], creator=REF["creator"]
    )
    assert await reopened.recover() == {
        "kind": "publish",
        "reference": PAIR["short"],
        "receipt": RECEIPT,
    }
    await reopened.close()
    again = await native_scratchpad(
        nc=cast(NATS, nc), dir=tmp_path, volume=REF["target"]["volume"], creator=REF["creator"]
    )
    assert await again.recover() == {
        "kind": "ready",
        "reference": PAIR["short"],
        "receipt": RECEIPT,
    }
    await again.close()
    assert len([call for call in nc.calls if call[0].endswith("reference.receipt")]) == 2


@pytest.mark.parametrize("token", [PAIR["short"], VECTOR["full_token"]])
async def test_deadline_after_ranges_and_final_yields(
    token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock, overrun = REF["expires_at"] - 1, False
    monkeypatch.setattr(time, "time", lambda: clock)
    data = b"a"
    digest = hashlib.sha256(data).hexdigest()
    stat = {
        "type": "file",
        "size": 1,
        "sha256": digest,
        "executable": False,
        "object": c.file_object_id(
            c.encode_file_object(
                {"size": 1, "digest": digest, "chunks": [{"id": c.chunk_id(data), "length": 1}]}
            )
        ),
    }
    nc = Connection()

    async def respond() -> Msg:
        nonlocal clock
        verb = nc.calls[-1][0].removeprefix(p.SUBJECT_PREFIX)
        if verb == "reference.stat":
            return message({"reference": PAIR, "stat": stat})
        if verb == "content.stat":
            return message(stat)
        assert verb == "content.read"
        if overrun:
            clock = REF["expires_at"]
        return message(
            data, {"code": "ok", "message": "", "range": {"stat": stat, "offset": 0, "length": 1}}
        )

    nc.on_request = respond
    reader = ScratchPadReader(client(nc), PRINCIPAL)
    stream = reader.read_stream(token, limit_bytes=1)
    assert await anext(stream) == data
    clock = REF["expires_at"]
    with pytest.raises(NativeScratchPadError) as caught:
        await anext(stream)
    assert caught.value.code == "expired"
    clock -= 1
    overrun = True
    with pytest.raises(NativeScratchPadError) as caught:
        await reader.read_bytes(token)
    assert caught.value.code == "expired"


@pytest.mark.parametrize("token", [PAIR["short"], VECTOR["full_token"]])
async def test_empty_file_stat_cannot_cross_deadline(
    token: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = REF["expires_at"] - 1
    monkeypatch.setattr(time, "time", lambda: clock)
    digest = hashlib.sha256(b"").hexdigest()
    stat = {
        "type": "file",
        "size": 0,
        "sha256": digest,
        "executable": False,
        "object": c.file_object_id(
            c.encode_file_object({"size": 0, "digest": digest, "chunks": []})
        ),
    }
    nc = Connection()

    async def respond() -> Msg:
        nonlocal clock
        clock = REF["expires_at"]
        return message(
            {"reference": PAIR, "stat": stat}
            if nc.calls[-1][0].endswith("reference.stat")
            else stat
        )

    nc.on_request = respond
    with pytest.raises(NativeScratchPadError) as caught:
        await ScratchPadReader(client(nc), PRINCIPAL).read_bytes(token)
    assert caught.value.code == "expired" and len(nc.calls) == 1
