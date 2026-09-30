"""Durable reference wire shapes. Metadata resolution never grants content access."""

from __future__ import annotations

import base64
import hashlib
import re

from . import protocol as p
from .codec import validate_reference
from .protocol import Wire

SHORT_REFERENCE_PREFIX = "sp-r1:"
SHORT_REFERENCE_BYTES = 66
REFERENCE_PATHS = 8
MAX_REFERENCE_INTENT_BYTES = 3072
MAX_REFERENCE_METADATA_BYTES = 32768
_PAYLOAD_BYTES = 45
_PACKED_SLOTS_BOUND = 64


def decode_short_reference(token: str) -> Wire:
    """Decode a locator only; the service verifies its metadata verifier."""
    p.text(token, SHORT_REFERENCE_BYTES, SHORT_REFERENCE_BYTES)
    p.check(re.fullmatch(r"sp-r1:[A-Za-z0-9_-]{60}", token), "malformed short reference")
    data = base64.urlsafe_b64decode(token[len(SHORT_REFERENCE_PREFIX) :])
    p.check(
        len(data) == _PAYLOAD_BYTES and data[32] < _PACKED_SLOTS_BOUND,
        "invalid short reference slots",
    )
    generation = p.uint(int.from_bytes(data[24:32], "big"), minimum=1)
    result = {
        "route": data[:8].hex(),
        "creation_id": data[8:24].hex(),
        "retention": {"slot": data[32] >> 3, "generation": generation},
        "path_index": data[32] & 7,
    }
    p.validate_target({"volume": "Reference", "creation_id": result["creation_id"]})
    return result


def reference_route(account: str, volume: str) -> str:
    return (
        hashlib.sha256(f"scratchpad-reference-volume-v1\0{account}\0{volume}".encode())
        .digest()[:8]
        .hex()
    )


def validate_reference_spec(value: object) -> Wire:
    v = p.record(value, ("creator", "paths"))
    p.text(v["creator"], 512, 1)
    p.check(
        isinstance(v["paths"], list) and 0 < len(v["paths"]) <= REFERENCE_PATHS,
        "reference paths exceed bound",
    )
    previous = ""
    for path in v["paths"]:
        p.validate_path(path, 256)
        p.check(previous.encode() < path.encode(), "reference paths must be distinct and sorted")
        previous = path
    p.check(
        len(p.go_json({"creator": v["creator"], "paths": v["paths"]}).encode())
        <= MAX_REFERENCE_INTENT_BYTES,
        "reference intent exceeds byte bound",
    )
    return v


def validate_resolved_reference(value: object) -> Wire:
    v = p.record(value, ("short", "expanded"))
    locator = decode_short_reference(v["short"])
    ref = validate_reference(v["expanded"])
    p.check(
        locator["route"] == reference_route(ref["account"], ref["target"]["volume"])
        and locator["creation_id"] == ref["target"]["creation_id"]
        and locator["retention"] == ref["retention"],
        "short reference binding differs",
    )
    return v


def validate_reference_capabilities(value: object) -> Wire:
    v = p.record(
        value,
        (
            "enabled",
            "version",
            "prefix",
            "token_bytes",
            "paths_per_retention",
            "max_intent_bytes",
            "max_metadata_bytes",
        ),
    )
    expected = {
        "enabled": v["enabled"],
        "version": 1,
        "prefix": SHORT_REFERENCE_PREFIX,
        "token_bytes": SHORT_REFERENCE_BYTES,
        "paths_per_retention": REFERENCE_PATHS,
        "max_intent_bytes": MAX_REFERENCE_INTENT_BYTES,
        "max_metadata_bytes": MAX_REFERENCE_METADATA_BYTES,
    }
    p.check(
        type(v["enabled"]) is bool
        and v == expected
        and all(
            type(v[key]) is int
            for key in (
                "version",
                "token_bytes",
                "paths_per_retention",
                "max_intent_bytes",
                "max_metadata_bytes",
            )
        ),
        "unsupported reference capability",
    )
    return v


def validate_reference_publish_request(value: object) -> Wire:
    v = p.record(value, ("target", "command", "reference"))
    target = p.validate_target(v["target"])
    command = p.validate_command(v["command"])
    p.check(
        target["creation_id"] == command["creation_id"]
        and command["retention"]["enabled"]
        and command["retention"]["until"] > 0,
        "referenced publication requires finite retention and matching target",
    )
    validate_reference_spec(v["reference"])
    return v


def validate_reference_publish_result(value: object) -> Wire:
    v = p.record(value, ("receipt", "references"))
    receipt = p.validate_receipt(v["receipt"])
    p.check(
        receipt["command"]["retention"]["enabled"]
        and isinstance(v["references"], list)
        and 0 < len(v["references"]) <= REFERENCE_PATHS,
        "invalid referenced receipt",
    )
    previous, creator = "", None
    for index, pair in enumerate(v["references"]):
        validate_resolved_reference(pair)
        ref = pair["expanded"]
        if creator is None:
            creator = ref["creator"]
        p.check(
            decode_short_reference(pair["short"])["path_index"] == index
            and ref["creator"] == creator
            and previous.encode() < ref["path"].encode()
            and ref["account"] == receipt["principal"]["account"]
            and ref["target"]["volume"] == receipt["volume"]
            and ref["target"]["creation_id"] == receipt["command"]["creation_id"]
            and ref["root"] == receipt["head"]["root"]
            and ref["generation"] == receipt["head"]["generation"]
            and ref["retention"] == receipt["retention"]
            and ref["expires_at"] == receipt["command"]["retention"]["until"],
            "reference differs from receipt",
        )
        previous = ref["path"]
    return v


def validate_reference_stat_result(value: object) -> Wire:
    v = p.record(value, ("reference", "stat"))
    validate_resolved_reference(v["reference"])
    p.validate_stat(v["stat"])
    return v


def validate_reference_retain_request(value: object) -> Wire:
    v = p.record(value, ("retain", "reference"))
    retain = p.record(v["retain"], ("target", "slot", "generation", "root", "until", "action"))
    p.validate_target(retain["target"])
    p.uint(retain["slot"], p.RETENTION_SLOTS - 1)
    p.uint(retain["generation"])
    p.validate_content_id(retain["root"])
    p.uint(retain["until"], minimum=1)
    p.validate_action(retain["action"])
    validate_reference_spec(v["reference"])
    return v


def validate_reference_retain_result(value: object) -> Wire:
    v = p.record(value, ("volume", "references"))
    volume = p.validate_volume_view(v["volume"])
    p.check(
        isinstance(v["references"], list) and 0 < len(v["references"]) <= REFERENCE_PATHS,
        "invalid retained references",
    )
    first, previous = None, ""
    for index, pair in enumerate(v["references"]):
        validate_resolved_reference(pair)
        ref = pair["expanded"]
        if first is None:
            first = ref
        retained = volume["retentions"][ref["retention"]["slot"]]
        p.check(
            decode_short_reference(pair["short"])["path_index"] == index
            and previous.encode() < ref["path"].encode()
            and ref["creator"] == first["creator"]
            and ref["root"] == first["root"]
            and ref["generation"] == first["generation"]
            and ref["retention"] == first["retention"]
            and ref["expires_at"] == first["expires_at"]
            and ref["target"] == volume["target"]
            and ref["account"] == volume["owner"]["account"]
            and retained["generation"] == ref["retention"]["generation"]
            and retained.get("pin", {}).get("root") == ref["root"]
            and retained["pin"]["until"] == ref["expires_at"],
            "reference differs from retained root",
        )
        previous = ref["path"]
    return v
