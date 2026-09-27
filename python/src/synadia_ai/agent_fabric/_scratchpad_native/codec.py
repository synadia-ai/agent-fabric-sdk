"""Canonical content bytes and exact v2 references (ADR-0004 and ADR-0040)."""

from __future__ import annotations

import base64
import hashlib
import inspect
import re
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable, Iterable, Sequence
from itertools import pairwise
from typing import Any, NoReturn, NotRequired, TypedDict, cast

from . import protocol as p
from .errors import invalid
from .protocol import (
    CHUNK_SIZE,
    MAX_CHUNKS,
    MAX_DEPTH,
    MAX_NODE_BYTES,
    MAX_TREE_ENTRIES,
    ZERO_CONTENT_ID,
    Wire,
)


class ChunkRef(TypedDict):
    id: str
    length: int


class FileObject(TypedDict):
    size: int
    digest: str
    chunks: list[ChunkRef]


class TreeEntry(TypedDict):
    name: str
    type: str
    object: NotRequired[str]
    executable: NotRequired[bool]
    link_target: NotRequired[str]


class DirectoryEntry(TreeEntry):
    child: NotRequired[Directory]


class Directory(TypedDict):
    entries: list[DirectoryEntry]


Reference = Wire
REFERENCE_VERSION = 2
_MAX_NAME_BYTES = 255
_MAX_TARGET_BYTES = 4096
_DIGEST_BYTES = 32
_CHUNK_REF_FIELDS = 2
_ENTRY_SYMLINK = 2
_CBOR_INLINE_LIMIT = 24
_CBOR_INDEFINITE = 31
_CBOR_MAX_LENGTH_TAG = 27
_CBOR_MAX_DEPTH = 8
_CBOR_BYTES = 2
_CBOR_TEXT = 3
_CBOR_ARRAY = 4


class CodecError(ValueError):
    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


def _reject(reason: str, message: str) -> NoReturn:
    raise CodecError(reason, message)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _id_bytes(value: str) -> bytes:
    p.validate_content_id(value)
    return base64.urlsafe_b64decode(value + "=")


def _hash(tag: str, data: bytes) -> str:
    return _b64(hashlib.sha256(tag.encode() + b"\0" + data).digest())


def chunk_id(data: bytes) -> str:
    return _hash("scratchpad:v1:chunk", data)


def file_object_id(data: bytes) -> str:
    return _hash("scratchpad:v1:file", data)


def tree_node_id(data: bytes) -> str:
    return _hash("scratchpad:v1:tree", data)


async def _parts(source: AsyncIterable[bytes] | Iterable[bytes]) -> AsyncIterator[bytes]:
    if isinstance(source, AsyncIterable):
        async for part in source:
            yield part
    else:
        for part in source:
            yield part


async def chunk_stream(
    source: AsyncIterable[bytes] | Iterable[bytes],
    emit: Callable[[int, Wire, bytes], Awaitable[None] | None],
) -> FileObject:
    """Emit immutable fixed-size chunks; retain only bounded chunk metadata."""
    file: FileObject = {"size": 0, "digest": "", "chunks": []}
    digest = hashlib.sha256()
    buffer = bytearray()

    async def flush() -> None:
        if len(file["chunks"]) >= MAX_CHUNKS:
            _reject("chunk-shape", "file exceeds chunk count bound")
        data = bytes(buffer)
        identity = chunk_id(data)
        digest.update(data)
        file["size"] += len(data)
        file["chunks"].append({"id": identity, "length": len(data)})
        result = emit(len(file["chunks"]) - 1, {"kind": "chnk", "id": identity}, data)
        if inspect.isawaitable(result):
            await result
        buffer.clear()

    async for part in _parts(source):
        p.check(isinstance(part, bytes | bytearray | memoryview), "stream must yield bytes")
        offset = 0
        while offset < len(part):
            length = min(CHUNK_SIZE - len(buffer), len(part) - offset)
            buffer.extend(part[offset : offset + length])
            offset += length
            if len(buffer) == CHUNK_SIZE:
                await flush()
    if buffer:
        await flush()
    file["digest"] = digest.hexdigest()
    return file


def _head(major: int, value: int) -> bytes:
    p.uint(value)
    if value < _CBOR_INLINE_LIMIT:
        return bytes([(major << 5) | value])
    for tag, size in ((24, 1), (25, 2), (26, 4), (27, 8)):
        if value < 1 << (size * 8):
            return bytes([(major << 5) | tag]) + value.to_bytes(size, "big")
    raise AssertionError("validated integer must fit CBOR")


def _bytes(data: bytes) -> bytes:
    return _head(2, len(data)) + data


def _text(value: str) -> bytes:
    data = value.encode()
    return _head(3, len(data)) + data


def _validate_file(file: FileObject) -> None:
    p.uint(file["size"])
    p.check(
        re.fullmatch(r"[0-9a-f]{64}", p.text(file["digest"], 64)), "invalid logical file digest"
    )
    if not isinstance(file["chunks"], list) or len(file["chunks"]) > MAX_CHUNKS:
        _reject("chunk-shape", "chunk count exceeds bound")
    total = 0
    for index, chunk in enumerate(file["chunks"]):
        p.validate_content_id(chunk["id"])
        length = p.uint(chunk["length"])
        if not 0 < length <= CHUNK_SIZE or (
            index != len(file["chunks"]) - 1 and length != CHUNK_SIZE
        ):
            _reject("chunk-shape", "invalid fixed chunk length")
        total += length
    if total != file["size"]:
        _reject("chunk-shape", "chunk lengths differ from file size")


def encode_file_object(file: FileObject) -> bytes:
    _validate_file(file)
    parts = [_head(5, 3), _text("c"), _head(4, len(file["chunks"]))]
    for chunk in file["chunks"]:
        parts.extend((_head(4, 2), _bytes(_id_bytes(chunk["id"])), _head(0, chunk["length"])))
    parts.extend(
        (_text("d"), _bytes(bytes.fromhex(file["digest"])), _text("s"), _head(0, file["size"]))
    )
    return b"".join(parts)


def _entry_name(name: str) -> None:
    try:
        data = name.encode("utf-8")
    except (AttributeError, UnicodeError):
        _reject("utf8", "invalid entry name UTF-8")
    if not 0 < len(data) <= _MAX_NAME_BYTES:
        _reject("name-length", "entry name length exceeds bound")
    if name in {".", ".."} or re.search(r"[\x00-\x1f\x7f/]", name):
        _reject("name-forbidden", "forbidden entry name")
    if p.normalize_unicode15(name) != name:
        _reject("not-nfc", "entry name is not NFC")


def _validate_entry(entry: TreeEntry) -> None:
    _entry_name(entry["name"])
    if entry["type"] == "symlink":
        if (
            entry.get("executable", False)
            or entry.get("object", ZERO_CONTENT_ID) != ZERO_CONTENT_ID
        ):
            _reject("type-invalid", "symlink has file fields")
        target = entry.get("link_target", "")
        try:
            data = target.encode("utf-8")
        except (AttributeError, UnicodeError):
            _reject("utf8", "invalid symlink UTF-8")
        if not 0 < len(data) <= _MAX_TARGET_BYTES or "\0" in target:
            _reject("target-invalid", "invalid symlink target")
    else:
        if entry["type"] not in {"file", "directory"}:
            _reject("type-invalid", "unknown entry type")
        p.validate_content_id(entry.get("object"))
        if entry.get("link_target") or (entry["type"] == "directory" and entry.get("executable")):
            _reject("type-invalid", "entry has fields of another type")


def encode_tree_node(entries: Sequence[TreeEntry]) -> bytes:
    for entry in entries:
        _validate_entry(entry)
    ordered = sorted(entries, key=lambda entry: entry["name"].encode())
    if any(a["name"] == b["name"] for a, b in pairwise(ordered)):
        _reject("duplicate-name", "duplicate tree entry")
    if len(entries) > MAX_TREE_ENTRIES:
        _reject("entry-count", "tree entry count exceeds bound")
    parts = [_head(5, 1), _text("e"), _head(4, len(entries))]
    size = sum(map(len, parts))
    for entry in ordered:
        fields = [_head(5, 4 if entry.get("executable") else 3)]
        if entry["type"] == "symlink":
            fields.extend((_text("l"), _text(entry["link_target"])))
        else:
            fields.extend((_text("i"), _bytes(_id_bytes(entry["object"]))))
        fields.extend(
            (
                _text("n"),
                _text(entry["name"]),
                _text("t"),
                _head(0, {"file": 0, "directory": 1, "symlink": 2}[entry["type"]]),
            )
        )
        if entry.get("executable"):
            fields.extend((_text("x"), _head(0, 1)))
        size += sum(map(len, fields))
        if size > MAX_NODE_BYTES:
            _reject("node-size", "tree node byte count exceeds bound")
        parts.extend(fields)
    return b"".join(parts)


EMPTY_ROOT = tree_node_id(encode_tree_node([]))


def encode_directory(directory: Directory) -> tuple[str, dict[str, bytes]]:
    nodes: dict[str, bytes] = {}

    def walk(value: Directory, depth: int) -> str:
        if depth > MAX_DEPTH:
            _reject("depth", "directory exceeds depth bound")
        entries: list[TreeEntry] = []
        for entry in value["entries"]:
            item = cast(TreeEntry, dict(entry))
            if entry["type"] == "directory":
                if "child" not in entry:
                    _reject("type-invalid", "directory entry has no child")
                item["object"] = walk(entry["child"], depth + 1)
            entries.append(item)
        data = encode_tree_node(entries)
        identity = tree_node_id(data)
        nodes[identity] = data
        return identity

    return walk(directory, 1), nodes


def _decode_cbor(data: bytes) -> Any:  # noqa: PLR0915 -- explicit bounded CBOR grammar
    cursor = 0

    def take(length: int) -> bytes:
        nonlocal cursor
        if length > len(data) - cursor:
            _reject("type-mismatch", "truncated CBOR")
        result = data[cursor : cursor + length]
        cursor += length
        return result

    def item(depth: int = 0) -> Any:  # noqa: PLR0912 -- one case per permitted CBOR major type
        if depth > _CBOR_MAX_DEPTH:
            _reject("type-mismatch", "CBOR nesting exceeds object shape")
        first = take(1)[0]
        major, additional = first >> 5, first & 31
        if additional == _CBOR_INDEFINITE:
            _reject("indefinite-length", "indefinite CBOR length")
        if major not in (0, 2, 3, 4, 5):
            _reject("forbidden-item", "forbidden CBOR item")
        value = additional
        if additional >= _CBOR_INLINE_LIMIT:
            if additional > _CBOR_MAX_LENGTH_TAG:
                _reject("forbidden-item", "reserved CBOR length")
            value = int.from_bytes(take(2 ** (additional - 24)), "big")
            if value < (24, 256, 65536, 4294967296)[additional - 24]:
                _reject("non-shortest", "CBOR integer is not shortest")
            if value > p.MAX_SAFE_INTEGER:
                _reject("type-mismatch", "CBOR integer exceeds exact shared range")
        if major == 0:
            return value
        if major == _CBOR_BYTES:
            return take(value)
        if major == _CBOR_TEXT:
            try:
                return take(value).decode("utf-8")
            except UnicodeDecodeError:
                _reject("utf8", "CBOR text is not UTF-8")
        if value > len(data) - cursor:
            _reject("type-mismatch", "CBOR item count exceeds input")
        if major == _CBOR_ARRAY:
            return [item(depth + 1) for _ in range(value)]
        result: dict[str, Any] = {}
        last: bytes | None = None
        for _ in range(value):
            start = cursor
            try:
                key = item(depth + 1)
            except CodecError as error:
                if error.reason == "utf8":
                    _reject("key-unknown", "invalid UTF-8 map key cannot be a schema key")
                raise
            encoded = data[start:cursor]
            if not isinstance(key, str):
                _reject("type-mismatch", "CBOR map key must be text")
            if last is not None and last >= encoded:
                _reject("key-order", "CBOR keys are not strictly ordered")
            last = encoded
            result[key] = item(depth + 1)
        return result

    result = item()
    if cursor != len(data):
        _reject("trailing-bytes", "trailing CBOR bytes")
    return result


def _map(value: object, keys: Sequence[str]) -> Wire:
    if not isinstance(value, dict):
        _reject("type-mismatch", "expected CBOR map")
    if any(key not in keys for key in value):
        _reject("key-unknown", "unknown object key")
    if any(key not in value for key in keys):
        _reject("key-missing", "missing object key")
    return cast(Wire, value)


def _bytes32(value: object) -> bytes:
    if not isinstance(value, bytes) or len(value) != _DIGEST_BYTES:
        _reject("type-mismatch", "expected 32-byte digest")
    return value


def _integer(value: object) -> int:
    if type(value) is not int:
        _reject("type-mismatch", "expected unsigned integer")
    return value


def decode_file_object(data: bytes) -> FileObject:
    fields = _map(_decode_cbor(data), ("c", "d", "s"))
    refs = fields["c"]
    if not isinstance(refs, list):
        _reject("type-mismatch", "chunks must be an array")
    file: FileObject = {
        "size": _integer(fields["s"]),
        "digest": _bytes32(fields["d"]).hex(),
        "chunks": [],
    }
    for ref in refs:
        if not isinstance(ref, list) or len(ref) != _CHUNK_REF_FIELDS:
            _reject("type-mismatch", "chunk reference must have two fields")
        file["chunks"].append({"id": _b64(_bytes32(ref[0])), "length": _integer(ref[1])})
    _validate_file(file)
    return file


def decode_tree_node(data: bytes) -> list[TreeEntry]:  # noqa: PLR0912 -- mirror canonical refusal cases
    if len(data) > MAX_NODE_BYTES:
        _reject("node-size", "tree node exceeds byte bound")
    entries = _map(_decode_cbor(data), ("e",))["e"]
    if not isinstance(entries, list):
        _reject("type-mismatch", "entries must be an array")
    if len(entries) > MAX_TREE_ENTRIES:
        _reject("entry-count", "tree entry count exceeds bound")
    result: list[TreeEntry] = []
    previous: str | None = None
    for item in entries:
        if not isinstance(item, dict):
            _reject("type-mismatch", "entry must be a map")
        if any(key not in ("i", "l", "n", "t", "x") for key in item):
            _reject("key-unknown", "unknown entry key")
        if "n" not in item or "t" not in item:
            _reject("key-missing", "missing entry name or type")
        name, kind = item["n"], _integer(item["t"])
        if not isinstance(name, str):
            _reject("type-mismatch", "entry name must be text")
        if kind > _ENTRY_SYMLINK:
            _reject("type-invalid", "unknown entry type")
        if ("l" if kind == _ENTRY_SYMLINK else "i") not in item:
            _reject("key-missing", "missing entry target")
        if ("i" if kind == _ENTRY_SYMLINK else "l") in item:
            _reject("type-invalid", "entry has other target type")
        if "x" in item and _integer(item["x"]) != 1:
            _reject("type-invalid", "executable flag must be one")
        entry: TreeEntry = {"name": name, "type": ("file", "directory", "symlink")[kind]}
        if "x" in item:
            entry["executable"] = True
        if kind == _ENTRY_SYMLINK:
            if not isinstance(item["l"], str):
                _reject("type-mismatch", "symlink target must be text")
            entry["link_target"] = item["l"]
        else:
            entry["object"] = _b64(_bytes32(item["i"]))
        _validate_entry(entry)
        if previous is not None:
            if previous == name:
                _reject("duplicate-name", "duplicate tree entry")
            if previous.encode() > name.encode():
                _reject("entry-order", "entries are not sorted")
        previous = name
        result.append(entry)
    return result


def verify_object(obj: Wire, data: bytes) -> None:
    p.validate_content_object(obj)
    kind = obj["kind"]
    if kind == "chnk":
        if not 0 < len(data) <= CHUNK_SIZE:
            _reject("chunk-shape", "chunk length outside bound")
        identity = chunk_id(data)
    elif kind == "fobj":
        if encode_file_object(decode_file_object(data)) != data:
            _reject("type-invalid", "file bytes are not canonical")
        identity = file_object_id(data)
    else:
        if encode_tree_node(decode_tree_node(data)) != data:
            _reject("type-invalid", "tree bytes are not canonical")
        identity = tree_node_id(data)
    if identity != obj["id"]:
        _reject("id-mismatch", "object identity differs")


def validate_reference(value: object) -> Reference:
    v = p.record(
        value,
        (
            "version",
            "creator",
            "account",
            "target",
            "root",
            "generation",
            "path",
            "retention",
            "expires_at",
        ),
    )
    p.check(p.uint(v["version"]) == REFERENCE_VERSION, "reference version must be two")
    p.text(v["creator"], 512, 1)
    p.validate_public_key(v["account"], "account")
    p.validate_target(v["target"])
    p.validate_content_id(v["root"])
    p.uint(v["generation"], minimum=1)
    p.validate_path(v["path"], 256)
    p.validate_retention_handle(v["retention"])
    p.uint(v["expires_at"], minimum=1)
    return v


def encode_reference(reference: Reference) -> str:
    validate_reference(reference)
    ordered = {
        "version": 2,
        "creator": reference["creator"],
        "account": reference["account"],
        "target": {
            "volume": reference["target"]["volume"],
            "creation_id": reference["target"]["creation_id"],
        },
        "root": reference["root"],
        "generation": reference["generation"],
        "path": reference["path"],
        "retention": {
            "slot": reference["retention"]["slot"],
            "generation": reference["retention"]["generation"],
        },
        "expires_at": reference["expires_at"],
    }
    token = "sp-ref:" + _b64(p.go_json(ordered, escape_html=False).encode())
    p.check(len(token) <= 16 * 1024, "reference exceeds byte bound")
    return token


def decode_reference(token: str) -> Reference:
    p.text(token, 16 * 1024)
    p.check(token.startswith("sp-ref:"), "reference prefix is absent")
    encoded = token[7:]
    p.check(re.fullmatch(r"[A-Za-z0-9_-]+", encoded), "reference is not unpadded base64url")
    try:
        data = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
    except ValueError as error:
        raise invalid("reference base64url is malformed", error) from error
    p.check(_b64(data) == encoded, "reference base64url has stray bits")
    reference = validate_reference(p.parse_strict_json(data, 16 * 1024))
    p.check(encode_reference(reference) == token, "reference JSON is not canonical")
    return reference
