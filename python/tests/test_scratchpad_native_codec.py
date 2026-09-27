"""The shared Go/TypeScript fixtures pin canonical bytes and exact refusals."""

from __future__ import annotations

import base64
import hashlib
import json
from array import array
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast

import pytest

from synadia_ai.agent_fabric._scratchpad_native import codec as c
from synadia_ai.agent_fabric._scratchpad_native import protocol as p
from synadia_ai.agent_fabric._scratchpad_native.errors import NativeScratchPadError

FIXTURES = Path(__file__).resolve().parents[2] / "test-fixtures" / "scratchpad"
MANIFEST = (FIXTURES / "codec" / "manifest.txt").read_text().splitlines()
VECTORS = [json.loads((FIXTURES / "codec" / name).read_text()) for name in MANIFEST]


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def entry(raw: dict[str, Any]) -> c.TreeEntry:
    name = raw.get("name", "")
    if "name_hex" in raw:
        try:
            name = bytes.fromhex(raw["name_hex"]).decode("utf-8")
        except UnicodeDecodeError:
            name = "\ud800"
    result: c.TreeEntry = {
        "name": name,
        "type": "directory" if raw["type"] == "dir" else raw["type"],
    }
    if "id_hex" in raw:
        result["object"] = b64(bytes.fromhex(raw["id_hex"]))
    if "target" in raw:
        result["link_target"] = raw["target"]
    if "executable" in raw:
        result["executable"] = raw["executable"]
    return result


async def run_vector(vector: dict[str, Any]) -> tuple[bytes, str]:
    kind = {"chunk": "chnk", "file": "fobj"}.get(vector["kind"], "tree")
    if vector.get("mode") == "decode":
        data, identity = bytes.fromhex(vector["encoded_hex"]), b64(bytes.fromhex(vector["id"]))
        c.verify_object({"kind": kind, "id": identity}, data)
        return data, identity
    obj = vector["object"]
    if vector["kind"] in {"chunk", "file"}:
        raw = (
            bytes.fromhex(obj["content_hex"])
            if "content_hex" in obj
            else bytes.fromhex(obj["content_repeat"]["byte_hex"]) * obj["content_repeat"]["count"]
        )
        if vector["kind"] == "chunk":
            identity = c.chunk_id(raw)
            c.verify_object({"kind": "chnk", "id": identity}, raw)
            return raw, identity
        file = await c.chunk_stream([raw], lambda *_: None)
        data = c.encode_file_object(file)
        return data, c.file_object_id(data)
    if vector["kind"] == "deep_tree":
        directory: c.Directory = {"entries": [cast(c.DirectoryEntry, entry(obj["leaf"]))]}
        for _ in range(1, obj["depth"]):
            directory = {
                "entries": [{"name": obj["dir_name"], "type": "directory", "child": directory}]
            }
        root, nodes = c.encode_directory(directory)
        return nodes[root], root
    if vector["kind"] == "wide_tree":
        entries: list[c.TreeEntry] = [
            {
                "name": obj["name_prefix"] + str(index).zfill(obj.get("pad", 4)),
                "type": "file",
                "object": b64(bytes.fromhex(obj["id_hex"])),
            }
            for index in range(obj["count"])
        ]
        if obj.get("extra_name"):
            entries.append(
                {
                    "name": obj["extra_name"],
                    "type": "file",
                    "object": b64(bytes.fromhex(obj["id_hex"])),
                }
            )
    else:
        entries = [entry(raw) for raw in obj["entries"]]
    data = c.encode_tree_node(entries)
    return data, c.tree_node_id(data)


def test_manifest_is_exact() -> None:
    assert len(MANIFEST) == 47
    assert sorted(path.name for path in (FIXTURES / "codec").glob("*.json")) == sorted(MANIFEST)


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
async def test_shared_codec_vector(vector: dict[str, Any]) -> None:
    if "reject" in vector:
        with pytest.raises(c.CodecError) as caught:
            await run_vector(vector)
        assert caught.value.reason == vector["reject"]
        return
    data, identity = await run_vector(vector)
    expected = vector["expect"]
    assert base64.urlsafe_b64decode(identity + "=").hex() == expected["id"]
    assert len(data) == expected["canonical_length"]
    assert hashlib.sha256(data).hexdigest() == expected["canonical_sha256"]
    if "canonical_hex" in expected:
        assert data.hex() == expected["canonical_hex"]
    kind = {"chunk": "chnk", "file": "fobj"}.get(vector["kind"], "tree")
    c.verify_object({"kind": kind, "id": identity}, data)
    changed = data[:-1] + bytes([data[-1] ^ 1])
    with pytest.raises((c.CodecError, NativeScratchPadError)):
        c.verify_object({"kind": kind, "id": identity}, changed)


async def test_stream_boundaries_and_immutable_emission() -> None:
    raw = bytes([0xA3]) * (p.CHUNK_SIZE * 2 + 19)
    emitted: list[bytes] = []

    async def source() -> AsyncIterator[bytes]:
        yield raw[:3]
        yield raw[3 : p.CHUNK_SIZE + 7]
        yield raw[p.CHUNK_SIZE + 7 :]

    async def emit(index: int, obj: p.Wire, data: bytes) -> None:
        assert index == len(emitted)
        assert obj == {"kind": "chnk", "id": c.chunk_id(data)}
        emitted.append(data)

    file = await c.chunk_stream(source(), emit)
    assert [ref["length"] for ref in file["chunks"]] == [p.CHUNK_SIZE, p.CHUNK_SIZE, 19]
    assert file["digest"] == hashlib.sha256(raw).hexdigest()
    assert b"".join(emitted) == raw


async def test_stream_counts_multibyte_memoryview_bytes() -> None:
    values = array("I", range(p.CHUNK_SIZE // 4 + 1))
    assert values.itemsize == 4
    part = memoryview(values)
    raw = part.tobytes()
    emitted: list[bytes] = []
    file = await c.chunk_stream([part], lambda _index, _obj, data: emitted.append(data))
    assert [len(data) for data in emitted] == [p.CHUNK_SIZE, 4]
    assert [ref["length"] for ref in file["chunks"]] == [p.CHUNK_SIZE, 4]
    assert b"".join(emitted) == raw
    assert file["size"] == len(raw)
    assert file["digest"] == hashlib.sha256(raw).hexdigest()
    assert c.decode_file_object(c.encode_file_object(file)) == file


async def test_stream_rejects_noncontiguous_memoryview() -> None:
    with pytest.raises(NativeScratchPadError, match="contiguous"):
        await c.chunk_stream([memoryview(b"abcdef")[::2]], lambda *_: None)


async def test_spool_error_propagates_without_prepared_file() -> None:
    def emit(_index: int, _obj: p.Wire, _data: bytes) -> None:
        raise OSError("disk full")

    with pytest.raises(OSError, match="disk full"):
        await c.chunk_stream([b"x" * (p.CHUNK_SIZE + 1)], emit)


def test_unicode15_unassigned_boundaries_and_nfc() -> None:
    sentinel = "q\u0301\U00010efd"
    assert p.normalize_unicode15(sentinel) != sentinel
    later_assignment = "q\u0301\U000113ce"
    assert p.normalize_unicode15(later_assignment) == later_assignment
    assert p.normalize_unicode15("e\u0301") == "é"


def test_exact_go_reference_vector_and_noncanonical_refusals() -> None:
    vector = json.loads((FIXTURES / "reference-v2.json").read_text())
    assert c.encode_reference(vector["reference"]) == vector["token"]
    assert c.decode_reference(vector["token"]) == vector["reference"]
    payload = vector["canonical_json"]
    assert "\\u2028" in payload and "\\u2029" in payload and "<reply>&" in payload
    for bad in (
        vector["token"] + "=",
        vector["token"][7:],
        "sp-ref:" + b64(payload.replace('"version":2', '"version": 2').encode()),
        "sp-ref:" + b64(payload.replace('"version":2', '"version":2,"version":2').encode()),
    ):
        with pytest.raises(NativeScratchPadError):
            c.decode_reference(bad)


@pytest.mark.parametrize("value", [True, False, 1.0, -1, 2**53, "1", None])
def test_integer_validation_refuses_python_bool_and_unsafe_values(value: object) -> None:
    with pytest.raises(NativeScratchPadError):
        p.uint(value)


@pytest.mark.parametrize(
    "encoded",
    [
        b'{"v":9007199254740993}',
        b'{"v":1.0}',
        b'{"v":NaN}',
        b'{"v":1,"v":2}',
        b'{"v":"\\ud800"}',
        b"{}{}",
        b'{"v":-0}',
        b'{"v":"\xff"}',
    ],
)
def test_strict_json_refuses_ambiguous_or_invalid_data(encoded: bytes) -> None:
    with pytest.raises(NativeScratchPadError):
        p.parse_strict_json(encoded, 1024)
