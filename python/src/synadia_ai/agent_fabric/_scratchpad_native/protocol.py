"""Bounded api/v2 values shared with the native TypeScript client.

Wire dictionaries are validated before transmission and after strict decoding.
Identity fields are data; the existing NATS connection authenticates the caller.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
import sys
import unicodedata
from bisect import bisect_right
from collections.abc import Sequence
from typing import Any, TypeAlias, cast

from .errors import invalid
from .unicode15 import UNASSIGNED_RANGES

Wire: TypeAlias = dict[str, Any]
SUBJECT_PREFIX = "sp.v1.api.v2."
METADATA_HEADER = "ScratchPad-Metadata"
REPLY_HEADER = "ScratchPad-Reply"
CHUNK_SIZE = 512 * 1024
MAX_NODE_BYTES = 900 * 1024
MAX_CHUNKS = 20480
MAX_TREE_ENTRIES = 8192
MAX_DEPTH = 128
MAX_CONTROL_BYTES = 16 * 1024
MAX_REPLY_BYTES = 128 * 1024
MAX_HEADER_BYTES = 8 * 1024
MAX_READ_BYTES = CHUNK_SIZE
MAX_PREPARE_OBJECTS = 64
MAX_VOLUME_OBJECTS = 65536
MAX_VOLUME_BYTES = 8 * 2**30
WRITER_SLOTS = 8
RETENTION_SLOTS = 8
GRANT_SLOTS = 16
MAX_GRANT_SECONDS = 3600
MAX_TOOL_CALL_RUNES = 256
MAX_OPERATION_RUNES = 64
MAX_SCOPES = 16
MAX_LIST_ENTRIES = 64
MAX_SAFE_INTEGER = 2**53 - 1
ZERO_CONTENT_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
_PUBLIC_KEY_BYTES = 35
_PUBLIC_KEY_DATA_BYTES = 33
_MAX_JSON_DEPTH = 64
_UNASSIGNED_STARTS = tuple(begin for begin, _ in UNASSIGNED_RANGES)
CODES = frozenset(
    {
        "ok",
        "invalid",
        "unauthenticated",
        "denied",
        "not_found",
        "exists",
        "conflict",
        "fenced",
        "generation_retired",
        "intent_changed",
        "capacity",
        "summary_limit",
        "closed",
        "epoch_changed",
        "expired",
        "corrupt",
        "incomplete",
        "busy",
        "unknown",
        "unavailable",
        "internal",
    }
)
PUBLIC_LIMITS = {
    "object_bytes": MAX_NODE_BYTES,
    "read_bytes": MAX_READ_BYTES,
    "control_bytes": MAX_CONTROL_BYTES,
    "reply_bytes": MAX_REPLY_BYTES,
    "writers": WRITER_SLOTS,
    "retentions": RETENTION_SLOTS,
    "grants": GRANT_SLOTS,
    "grant_seconds": MAX_GRANT_SECONDS,
}


def check(condition: object, message: str) -> None:
    if not condition:
        raise invalid(message)


def require_native_runtime() -> None:
    check(sys.version_info >= (3, 12), "native ScratchPad requires Python 3.12 or later")
    check(
        tuple(map(int, unicodedata.unidata_version.split("."))) >= (15, 0, 0),
        "native ScratchPad requires Unicode 15 or later normalization tables",
    )


def record(value: object, required: Sequence[str], optional: Sequence[str] = ()) -> Wire:
    check(isinstance(value, dict), "expected JSON object")
    result = cast(Wire, value)
    check(all(key in result for key in required), "required field is absent")
    check(all(key in required or key in optional for key in result), "unknown field")
    return result


def uint(value: object, maximum: int = MAX_SAFE_INTEGER, minimum: int = 0) -> int:
    check(type(value) is int and minimum <= value <= maximum, "integer outside its bound")
    return cast(int, value)


def boolean(value: object) -> bool:
    check(type(value) is bool, "expected boolean")
    return cast(bool, value)


def text(value: object, maximum: int, minimum: int = 0) -> str:
    check(isinstance(value, str), "expected Unicode text")
    result = cast(str, value)
    try:
        length = len(result.encode("utf-8"))
    except UnicodeEncodeError as error:
        raise invalid("invalid Unicode text", error) from error
    check(minimum <= length <= maximum, "text outside its byte bound")
    return result


def normalize_unicode15(value: str) -> str:
    require_native_runtime()
    result: list[str] = []
    assigned: list[str] = []
    for point in value:
        code = ord(point)
        index = bisect_right(_UNASSIGNED_STARTS, code) - 1
        if index >= 0 and code < UNASSIGNED_RANGES[index][1]:
            result.extend((unicodedata.normalize("NFC", "".join(assigned)), point))
            assigned.clear()
        else:
            assigned.append(point)
    result.append(unicodedata.normalize("NFC", "".join(assigned)))
    return "".join(result)


def validate_content_id(value: object) -> str:
    value = text(value, 43, 43)
    check(re.fullmatch(r"[A-Za-z0-9_-]{43}", value), "invalid content identity")
    data = base64.urlsafe_b64decode(value + "=")
    check(
        base64.urlsafe_b64encode(data).decode().rstrip("=") == value,
        "noncanonical content identity",
    )
    return value


def validate_public_key(value: object, kind: str) -> str:
    value = text(value, 56, 56)
    check(re.fullmatch(r"[A-Z2-7]{56}", value), "invalid public NKEY")
    data = base64.b32decode(value)
    check(kind in {"account", "user"}, "unknown public NKEY kind")
    check(
        len(data) == _PUBLIC_KEY_BYTES and data[0] == (0 if kind == "account" else 160),
        "wrong NKEY kind",
    )
    checksum = binascii.crc_hqx(data[:_PUBLIC_KEY_DATA_BYTES], 0)
    check(data[_PUBLIC_KEY_DATA_BYTES:] == checksum.to_bytes(2, "little"), "NKEY checksum differs")
    return value


def validate_principal(value: object) -> Wire:
    v = record(value, ("account", "user"))
    validate_public_key(v["account"], "account")
    validate_public_key(v["user"], "user")
    return v


def validate_name(value: object) -> str:
    value = text(value, 255, 1)
    check(
        value not in {".", ".."} and not re.search(r"[\x00-\x1f\x7f/]", value),
        "forbidden entry name",
    )
    check(normalize_unicode15(value) == value, "entry name is not NFC")
    return value


def validate_path(value: object, max_bytes: int = 4096) -> str:
    value = text(value, max_bytes, 1)
    check(value.startswith("/"), "path must be absolute")
    if value != "/":
        names = value[1:].split("/")
        check(len(names) <= MAX_DEPTH, "path exceeds depth bound")
        for name in names:
            validate_name(name)
    return value


def validate_volume(value: object) -> str:
    value = text(value, 64, 1)
    check(re.fullmatch(r"[0-9A-Za-z]{1,64}", value), "invalid volume name")
    return value


def validate_target(value: object) -> Wire:
    v = record(value, ("volume", "creation_id"))
    validate_volume(v["volume"])
    check(
        re.fullmatch(r"[0-9a-f]{32}", text(v["creation_id"], 32)),
        "invalid volume creation identity",
    )
    return v


def validate_trace(value: object) -> Wire:
    v = record(value, (), ("thread_id", "root_id", "tool_call_id"))
    for field in ("thread_id", "root_id"):
        if field in v:
            text(v[field], 32)
    if "tool_call_id" in v:
        check(
            len(text(v["tool_call_id"], 1024)) <= MAX_TOOL_CALL_RUNES, "tool-call label is too long"
        )
    if any(v.values()):
        for field in ("thread_id", "root_id"):
            check(re.fullmatch(r"[0-9a-f]{32}", text(v.get(field), 32)), "invalid trace identity")
    return v


def validate_action(value: object) -> Wire:
    v = record(value, ("operation_id", "trace"))
    check(
        len(text(v["operation_id"], 256, 1)) <= MAX_OPERATION_RUNES,
        "operation identity is too long",
    )
    validate_trace(v["trace"])
    return v


def validate_head(value: object) -> Wire:
    v = record(value, ("generation", "root"))
    uint(v["generation"], minimum=1)
    validate_content_id(v["root"])
    return v


def _handle(value: object, slots: int) -> Wire:
    v = record(value, ("slot", "generation"))
    uint(v["slot"], slots - 1)
    uint(v["generation"], minimum=1)
    return v


def validate_writer(value: object) -> Wire:
    return _handle(value, WRITER_SLOTS)


def validate_retention_handle(value: object) -> Wire:
    return _handle(value, RETENTION_SLOTS)


def validate_grant_handle(value: object) -> Wire:
    return _handle(value, GRANT_SLOTS)


def validate_command(value: object) -> Wire:
    v = record(
        value,
        ("creation_id", "writer", "number", "operation_id", "base", "root", "trace", "retention"),
        ("remove_path",),
    )
    validate_target({"volume": "v", "creation_id": v["creation_id"]})
    validate_writer(v["writer"])
    uint(v["number"], minimum=1)
    validate_action({"operation_id": v["operation_id"], "trace": v["trace"]})
    validate_head(v["base"])
    validate_content_id(v["root"])
    r = record(v["retention"], ("enabled", "slot", "generation", "until"))
    boolean(r["enabled"])
    uint(r["slot"], RETENTION_SLOTS - 1)
    uint(r["generation"])
    uint(r["until"])
    check(
        r["enabled"] or (r["slot"] == r["generation"] == r["until"] == 0),
        "disabled retention must be zero",
    )
    if "remove_path" in v:
        validate_path(v["remove_path"])
        check(v["remove_path"] != "/" and not r["enabled"], "removal cannot retain or remove root")
    return v


def validate_receipt(value: object) -> Wire:
    v = record(value, ("volume", "principal", "command", "head", "retention"))
    validate_volume(v["volume"])
    validate_principal(v["principal"])
    command = validate_command(v["command"])
    head = validate_head(v["head"])
    check(
        head["root"] == command["root"] and head["generation"] - command["base"]["generation"] == 1,
        "receipt head differs from command",
    )
    if command["retention"]["enabled"]:
        retention = validate_retention_handle(v["retention"])
        check(
            retention["slot"] == command["retention"]["slot"]
            and retention["generation"] > command["retention"]["generation"],
            "receipt retention differs from command",
        )
    else:
        r = record(v["retention"], ("slot", "generation"))
        uint(r["slot"], 0)
        uint(r["generation"], 0)
    return v


def _writer_slots(v: Wire) -> None:
    slots = v["writers"]
    check(isinstance(slots, list) and len(slots) == WRITER_SLOTS, "wrong writer slot count")
    for index, raw in enumerate(slots):
        slot = record(raw, ("generation", "number", "write"), ("principal", "receipt"))
        uint(slot["generation"], v["revision"], 1)
        uint(slot["number"])
        boolean(slot["write"])
        if "principal" in slot:
            principal = validate_principal(slot["principal"])
            check(
                principal["account"] == v["owner"]["account"], "writer belongs to another account"
            )
        else:
            check(not slot["write"], "writer identity absent")
        if slot["number"] == 0:
            check("receipt" not in slot, "unused writer has a receipt")
        else:
            receipt = validate_receipt(slot.get("receipt"))
            command = receipt["command"]
            check(
                (
                    ("principal" not in slot and not slot["write"])
                    or (slot["write"] and receipt["principal"] == slot.get("principal"))
                )
                and receipt["principal"]["account"] == v["owner"]["account"]
                and receipt["volume"] == v["target"]["volume"]
                and command["creation_id"] == v["target"]["creation_id"]
                and command["writer"] == {"slot": index, "generation": slot["generation"]}
                and command["number"] == slot["number"]
                and receipt["head"]["generation"] <= v["head"]["generation"],
                "writer receipt differs from slot",
            )


def _retention_slots(v: Wire) -> None:
    slots = v["retentions"]
    check(isinstance(slots, list) and len(slots) == RETENTION_SLOTS, "wrong retention slot count")
    for raw in slots:
        slot = record(raw, ("generation",), ("pin",))
        uint(slot["generation"], v["revision"])
        if "pin" in slot:
            check(slot["generation"] > 0, "retention pin has zero generation")
            pin = record(slot["pin"], ("root", "until", "origin"))
            validate_content_id(pin["root"])
            uint(pin["until"])
            origin = record(pin["origin"], ("writer", "number"))
            uint(origin["number"])
            if origin["number"] == 0:
                writer = record(origin["writer"], ("slot", "generation"))
                uint(writer["slot"], 0)
                uint(writer["generation"], 0)
            else:
                writer = validate_writer(origin["writer"])
                check(
                    writer["generation"] < slot["generation"], "invalid retention origin generation"
                )


def _grant_slots(v: Wire) -> None:
    slots = v["grants"]
    check(isinstance(slots, list) and len(slots) == GRANT_SLOTS, "wrong grant slot count")
    for raw in slots:
        slot = record(raw, ("generation",), ("grant",))
        uint(slot["generation"], v["revision"])
        if "grant" in slot:
            check(slot["generation"] > 0, "grant has zero generation")
            grant = record(
                slot["grant"], ("principal", "root", "path", "directory", "retention", "until")
            )
            principal = validate_principal(grant["principal"])
            validate_content_id(grant["root"])
            validate_path(grant["path"], 256)
            boolean(grant["directory"])
            retention = validate_retention_handle(grant["retention"])
            uint(grant["until"], minimum=1)
            check(
                principal["account"] == v["owner"]["account"]
                and retention["generation"] < slot["generation"],
                "invalid grant principal or retention generation",
            )


def validate_volume_view(value: object) -> Wire:
    v = record(
        value,
        (
            "target",
            "owner",
            "head",
            "revision",
            "closed",
            "epoch",
            "objects",
            "bytes",
            "writers",
            "retentions",
            "grants",
        ),
        ("lifetime",),
    )
    if "lifetime" in v:
        validate_lifetime_view(v["lifetime"])
    validate_target(v["target"])
    validate_principal(v["owner"])
    head = validate_head(v["head"])
    uint(v["revision"], minimum=1)
    boolean(v["closed"])
    uint(v["epoch"], v["revision"])
    uint(v["objects"], MAX_VOLUME_OBJECTS)
    uint(v["bytes"], MAX_VOLUME_BYTES)
    check(
        head["generation"] <= v["revision"] and (not v["closed"] or v["epoch"] == v["revision"]),
        "inconsistent volume revision",
    )
    _writer_slots(v)
    _retention_slots(v)
    _grant_slots(v)
    return v


def validate_info(value: object) -> Wire:
    v = record(value, ("principal", "scopes", "limits"))
    validate_principal(v["principal"])
    limits = record(v["limits"], tuple(PUBLIC_LIMITS))
    for key, expected in PUBLIC_LIMITS.items():
        check(uint(limits[key]) == expected, "service limits differ from client contract")
    check(
        isinstance(v["scopes"], list) and len(v["scopes"]) <= MAX_SCOPES,
        "scope count exceeds bound",
    )
    seen: set[str] = set()
    for raw in v["scopes"]:
        scope = record(raw, ("volume", "objects", "bytes"), ("admission",))
        if "admission" in scope:
            validate_admission_binding(scope["admission"])
        name = validate_volume(scope["volume"])
        uint(scope["objects"], MAX_VOLUME_OBJECTS, 1)
        uint(scope["bytes"], MAX_VOLUME_BYTES, 4)
        check(name not in seen, "duplicate scope")
        seen.add(name)
    return v


def validate_admission_binding(value: object) -> Wire:
    v = record(value, ("slot", "generation", "operation_id"))
    uint(v["slot"], 255)
    uint(v["generation"], minimum=1)
    validate_action({"operation_id": v["operation_id"], "trace": {}})
    return v


def validate_lifetime_view(value: object) -> Wire:
    v = record(
        value,
        (
            "admission",
            "phase",
            "expires_at",
            "grace_until",
            "max_lease_seconds",
            "grace_seconds",
            "recovery_reads",
            "reserve_objects",
            "reserve_bytes",
        ),
    )
    validate_admission_binding(v["admission"])
    for key in ("expires_at", "grace_until", "max_lease_seconds", "grace_seconds"):
        uint(v[key])
    boolean(v["recovery_reads"])
    uint(v["reserve_objects"], 128)
    uint(v["reserve_bytes"], 8 * 2**20)
    check((v["reserve_objects"] == 0) == (v["reserve_bytes"] == 0), "incomplete metadata reserve")
    check(v["phase"] in ("active", "shrinking", "expiring"), "invalid lifetime phase")
    if v["phase"] == "expiring":
        check(
            v["expires_at"] > 0 and (v["grace_until"] == 0 or v["grace_until"] >= v["expires_at"]),
            "invalid lifetime grace",
        )
    else:
        check(v["grace_until"] == 0, "invalid lifetime grace")
    if v["expires_at"] == 0:
        check(v["grace_seconds"] == 0, "invalid durable policy")
    else:
        check(v["max_lease_seconds"] > 0 and v["grace_seconds"] > 0, "invalid lease policy")
    return v


def validate_renew_request(value: object) -> Wire:
    v = record(value, ("target", "until"))
    validate_target(v["target"])
    uint(v["until"], minimum=1)
    return v


def validate_removal_request(value: object) -> Wire:
    v = record(value, ("target", "command"))
    validate_target(v["target"])
    validate_command(v["command"])
    check(
        v["command"].get("remove_path")
        and v["command"]["creation_id"] == v["target"]["creation_id"],
        "invalid removal command",
    )
    return v


def validate_removal_plan(value: object) -> Wire:
    v = record(
        value,
        ("target", "slot", "generation", "sequence", "command", "added_objects", "added_bytes"),
    )
    validate_removal_request({"target": v["target"], "command": v["command"]})
    uint(v["slot"], 255)
    uint(v["generation"], minimum=1)
    uint(v["sequence"], minimum=1)
    uint(v["added_objects"], 128)
    uint(v["added_bytes"], 8 * 2**20)
    return v


def validate_volume_release_request(value: object) -> Wire:
    v = record(value, ("target", "operation_id", "end_promises"))
    validate_target(v["target"])
    validate_action({"operation_id": v["operation_id"], "trace": {}})
    boolean(v["end_promises"])
    return v


def validate_volume_release_plan(value: object) -> Wire:
    v = record(
        value, ("request", "incarnation", "slot", "generation", "sequence", "head", "effects")
    )
    validate_volume_release_request(v["request"])
    text(v["incarnation"], 64, 64)
    check(re.fullmatch(r"[0-9a-f]{64}", v["incarnation"]), "invalid release incarnation")
    uint(v["slot"], 255)
    uint(v["generation"], minimum=1)
    uint(v["sequence"], minimum=1)
    validate_head(v["head"])
    effects = record(
        v["effects"],
        ("objects", "bytes", "retentions", "read_grants", "access_slots", "references"),
    )
    for key, maximum in (
        ("objects", MAX_VOLUME_OBJECTS),
        ("bytes", MAX_VOLUME_BYTES),
        ("retentions", RETENTION_SLOTS),
        ("read_grants", GRANT_SLOTS),
        ("access_slots", WRITER_SLOTS),
        ("references", RETENTION_SLOTS),
    ):
        uint(effects[key], maximum)
    return v


def validate_volume_release_result(value: object) -> Wire:
    v = record(
        value, ("target", "slot", "generation", "operation_id", "disposed", "capacity_returned")
    )
    validate_target(v["target"])
    uint(v["slot"], 255)
    uint(v["generation"], minimum=1)
    validate_action({"operation_id": v["operation_id"], "trace": {}})
    boolean(v["disposed"])
    boolean(v["capacity_returned"])
    check(not v["capacity_returned"] or v["disposed"], "capacity returned before disposal")
    return v


def validate_content_object(value: object) -> Wire:
    v = record(value, ("kind", "id"))
    validate_content_id(v["id"])
    check(v["kind"] in ("chnk", "fobj", "tree"), "unsupported object kind")
    return v


def validate_object_spec(value: object) -> Wire:
    v = record(value, ("object", "length"))
    obj = validate_content_object(v["object"])
    uint(v["length"], CHUNK_SIZE if obj["kind"] == "chnk" else MAX_NODE_BYTES, 1)
    return v


def _progress(value: object, preparation: bool) -> Wire:
    v = record(value, ("object", "length", "state", "next", "code"))
    validate_object_spec({"object": v["object"], "length": v["length"]})
    uint(v["next"])
    if v["state"] == "refused":
        check(preparation and v["next"] == 0 and v["code"] == "capacity", "invalid refusal state")
    else:
        check(v["code"] == "ok", "invalid progress code")
        if v["state"] in ("reserved", "verified"):
            check(v["next"] == 0, "unexpected progress cursor")
        else:
            check(
                v["state"] == "verifying" and v["object"]["kind"] != "chnk",
                "invalid progress state",
            )
            uint(
                v["next"],
                (MAX_TREE_ENTRIES if v["object"]["kind"] == "tree" else MAX_CHUNKS) - 1,
                1,
            )
    return v


def _progress_result(value: object, preparation: bool) -> Wire:
    v = record(value, ("epoch", "objects"))
    uint(v["epoch"])
    check(
        isinstance(v["objects"], list) and 0 < len(v["objects"]) <= MAX_PREPARE_OBJECTS,
        "invalid progress count",
    )
    seen: set[tuple[str, str]] = set()
    for raw in v["objects"]:
        obj = _progress(raw, preparation)["object"]
        key = (obj["kind"], obj["id"])
        check(key not in seen, "duplicate object progress")
        seen.add(key)
    return v


def validate_prepare_result(value: object) -> Wire:
    return _progress_result(value, True)


def validate_verify_result(value: object) -> Wire:
    return _progress_result(value, False)


def _entry_body(v: Wire) -> None:
    validate_content_id(v["object"])
    boolean(v["executable"])
    if v["type"] == "symlink":
        target = text(v.get("link_target"), 4096, 1)
        check(
            "\0" not in target and not v["executable"] and v["object"] == ZERO_CONTENT_ID,
            "invalid symlink metadata",
        )
    else:
        check(v["type"] in ("file", "directory"), "invalid entry type")
        check(v.get("link_target", "") == "", "unexpected symlink target")
        check(v["type"] == "file" or not v["executable"], "directory is executable")


def validate_stat(value: object) -> Wire:
    v = record(value, ("type", "object", "size", "sha256", "executable"), ("link_target",))
    _entry_body(v)
    uint(v["size"], MAX_VOLUME_BYTES)
    if v["type"] == "file":
        check(re.fullmatch(r"[0-9a-f]{64}", text(v["sha256"], 64)), "invalid file digest")
    else:
        check(v["size"] == 0 and v["sha256"] == "", "non-file metadata contains file bytes")
    return v


def validate_list_result(value: object) -> Wire:
    v = record(value, ("entries", "next", "done"))
    uint(v["next"], MAX_TREE_ENTRIES)
    boolean(v["done"])
    check(
        isinstance(v["entries"], list)
        and len(v["entries"]) <= MAX_LIST_ENTRIES
        and len(v["entries"]) <= v["next"]
        and (v["done"] or v["entries"]),
        "invalid list window",
    )
    last, size = b"", 0
    for raw in v["entries"]:
        entry = record(raw, ("name", "type", "object", "executable"), ("link_target",))
        name = validate_name(entry["name"]).encode()
        _entry_body(entry)
        check(last < name, "list names are not strictly ordered")
        last = name
        size += len(go_json(entry).encode()) + 1
    check(size <= 64 * 1024, "list bytes exceed bound")
    return v


def validate_reply_metadata(value: object) -> Wire:
    v = record(value, ("code", "message"), ("range",))
    check(isinstance(v["code"], str) and v["code"] in CODES, "unknown reply code")
    text(v["message"], 256)
    if v["code"] != "ok":
        check(v["message"] != "" and "range" not in v, "invalid error reply")
    else:
        check(v["message"] == "", "success reply has error message")
        if "range" in v:
            r = record(v["range"], ("stat", "offset", "length"))
            stat = validate_stat(r["stat"])
            check(stat["type"] == "file", "range is not a file")
            uint(r["offset"], stat["size"])
            uint(r["length"], MAX_READ_BYTES)
            check(r["length"] <= stat["size"] - r["offset"], "range exceeds file")
    return v


def validate_collection_report(value: object) -> Wire:
    v = record(
        value,
        (
            "inventory_objects",
            "inventory_bytes",
            "live_objects",
            "live_bytes",
            "candidate_objects",
            "candidate_bytes",
            "delete_objects",
        ),
    )
    uint(v["inventory_objects"], MAX_VOLUME_OBJECTS)
    uint(v["inventory_bytes"], MAX_VOLUME_BYTES)
    uint(v["live_objects"], v["inventory_objects"])
    uint(v["live_bytes"], v["inventory_bytes"])
    for key in ("candidate_objects", "candidate_bytes", "delete_objects"):
        uint(v[key])
    check(
        v["candidate_objects"] == v["inventory_objects"] - v["live_objects"]
        and v["candidate_bytes"] == v["inventory_bytes"] - v["live_bytes"]
        and v["delete_objects"] <= v["candidate_objects"],
        "collection counters differ",
    )
    return v


def validate_collection_result(value: object) -> Wire:
    v = record(value, ("volume", "collection"))
    volume = validate_volume_view(v["volume"])
    report = validate_collection_report(v["collection"])
    check(
        not volume["closed"]
        and volume["objects"] == report["live_objects"]
        and volume["bytes"] == report["live_bytes"],
        "collection does not match reopened volume",
    )
    return v


def validate_empty(value: object) -> Wire:
    return record(value, ())


def go_json(value: object, escape_html: bool = True) -> str:
    result = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    result = result.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")
    if escape_html:
        result = result.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    return result


def parse_strict_json(data: bytes | str, limit: int) -> Any:
    encoded = data.encode("utf-8") if isinstance(data, str) else data
    check(len(encoded) <= limit, "JSON exceeds byte bound")

    def pairs(items: list[tuple[str, Any]]) -> Wire:
        result: Wire = {}
        for key, value in items:
            check(key not in result, "duplicate JSON key")
            result[key] = value
        return result

    def integer(value: str) -> int:
        check(
            len(value.lstrip("-")) <= len(str(MAX_SAFE_INTEGER)) and value != "-0",
            "unsafe or noncanonical JSON integer",
        )
        number = int(value)
        check(abs(number) <= MAX_SAFE_INTEGER, "unsafe JSON integer")
        return number

    def forbidden(value: str) -> Any:
        raise invalid("non-integral JSON number: " + value[:32])

    def walk(value: Any, depth: int = 0) -> None:
        check(depth <= _MAX_JSON_DEPTH, "JSON nesting exceeds bound")
        if isinstance(value, str):
            text(value, limit)
        elif isinstance(value, list):
            for child in value:
                walk(child, depth + 1)
        elif isinstance(value, dict):
            for key, child in value.items():
                text(key, limit)
                walk(child, depth + 1)

    try:
        result = json.loads(
            encoded.decode("utf-8"),
            object_pairs_hook=pairs,
            parse_int=integer,
            parse_float=forbidden,
            parse_constant=forbidden,
        )
        walk(result)
        return result
    except (ValueError, UnicodeError, RecursionError) as error:
        raise invalid("malformed JSON", error) from error
