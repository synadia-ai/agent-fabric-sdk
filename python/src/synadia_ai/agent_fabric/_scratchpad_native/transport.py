"""One-shot public NATS requests with conservative mutation outcomes."""

from __future__ import annotations

import asyncio
import copy
import math
from collections.abc import Callable

from nats import NATS

from . import protocol as p
from .codec import verify_object
from .errors import NativeScratchPadError, failed, invalid
from .protocol import Wire

_MAX_TIMEOUT_S = 300
_HEADER_FRAME_BYTES = 12


def _path_request(v: Wire) -> None:
    p.validate_target(v["target"])
    p.validate_content_id(v["root"])
    p.validate_path(v["path"])
    p.validate_trace(v["trace"])


def _object_request(value: object, *, prepare: bool) -> None:
    fields = ("target", "objects") if prepare else ("target", "epoch", "objects")
    v = p.record(value, fields)
    p.validate_target(v["target"])
    if not prepare:
        p.uint(v["epoch"])
    p.check(
        isinstance(v["objects"], list) and 0 < len(v["objects"]) <= p.MAX_PREPARE_OBJECTS,
        "invalid object count",
    )
    seen: set[tuple[str, str]] = set()
    for raw in v["objects"]:
        obj = p.validate_object_spec(raw)["object"] if prepare else p.validate_content_object(raw)
        key = (obj["kind"], obj["id"])
        p.check(key not in seen, "duplicate object")
        seen.add(key)


# Keep each current Go verb's field contract visible in one flat dispatch.
def _validate_request(verb: str, value: object) -> None:  # noqa: PLR0912, PLR0915
    if verb == "info":
        p.validate_empty(value)
    elif verb == "volume.create":
        v = p.record(value, ("volume", "action"))
        p.validate_volume(v["volume"])
        p.validate_action(v["action"])
    elif verb == "volume.get":
        p.validate_target(p.record(value, ("target",))["target"])
    elif verb in ("object.prepare", "object.verify"):
        _object_request(value, prepare=verb == "object.prepare")
    elif verb == "object.put":
        v = p.record(value, ("target", "object", "epoch"))
        p.validate_target(v["target"])
        p.validate_content_object(v["object"])
        p.uint(v["epoch"])
    elif verb == "checkpoint.publish":
        v = p.record(value, ("target", "command"))
        target = p.validate_target(v["target"])
        command = p.validate_command(v["command"])
        p.check(
            target["creation_id"] == command["creation_id"],
            "command names another creation identity",
        )
    elif verb == "writer.reset":
        v = p.record(value, ("target", "writer"))
        p.validate_target(v["target"])
        p.validate_writer(v["writer"])
    elif verb == "root.retain":
        v = p.record(value, ("target", "slot", "generation", "root", "until", "action"))
        p.validate_target(v["target"])
        p.uint(v["slot"], p.RETENTION_SLOTS - 1)
        p.uint(v["generation"])
        p.validate_content_id(v["root"])
        p.uint(v["until"])
        p.validate_action(v["action"])
    elif verb == "root.release":
        v = p.record(value, ("target", "handle"))
        p.validate_target(v["target"])
        p.validate_retention_handle(v["handle"])
    elif verb == "grant.issue":
        v = p.record(
            value,
            (
                "target",
                "slot",
                "generation",
                "principal",
                "root",
                "path",
                "retention",
                "until",
                "action",
            ),
        )
        p.validate_target(v["target"])
        p.uint(v["slot"], p.GRANT_SLOTS - 1)
        p.uint(v["generation"])
        p.validate_principal(v["principal"])
        p.validate_content_id(v["root"])
        p.validate_path(v["path"], 256)
        p.validate_retention_handle(v["retention"])
        p.uint(v["until"], minimum=1)
        p.validate_action(v["action"])
    elif verb == "grant.revoke":
        v = p.record(value, ("target", "handle", "action"))
        p.validate_target(v["target"])
        p.validate_grant_handle(v["handle"])
        p.validate_action(v["action"])
    elif verb in ("content.stat", "content.read", "content.list"):
        extras = {
            "content.stat": (),
            "content.read": ("offset", "length"),
            "content.list": ("offset", "limit"),
        }[verb]
        v = p.record(value, ("target", "root", "path", "trace", *extras))
        _path_request(v)
        if verb == "content.read":
            p.uint(v["offset"])
            p.uint(v["length"], p.MAX_READ_BYTES, 1)
        elif verb == "content.list":
            p.uint(v["offset"], 0xFFFFFFFF)
            p.uint(v["limit"], 64, 1)
    elif verb in ("maintenance.close", "maintenance.plan", "maintenance.apply"):
        v = p.record(value, ("target", "revision"))
        p.validate_target(v["target"])
        p.uint(v["revision"], minimum=1)
    else:
        raise invalid("unknown ScratchPad verb")


class ScratchPadTransport:
    """Borrow the caller's connection; never reconnect, retry, or change identity."""

    def __init__(self, nc: NATS, timeout_s: float = 10) -> None:
        p.require_native_runtime()
        self.nc = nc
        p.check(
            type(timeout_s) in (int, float)
            and math.isfinite(timeout_s)
            and 0 < timeout_s <= _MAX_TIMEOUT_S,
            "timeout must be positive and at most 300 seconds",
        )
        self.timeout_s = timeout_s
        self._ready(p.MAX_NODE_BYTES + p.MAX_HEADER_BYTES)

    def _ready(self, required: int) -> None:
        p.check(
            self.nc.is_connected and not self.nc.is_closed and not self.nc.is_draining,
            "an open connected NATS connection is required",
        )
        p.check(self.nc.max_payload >= required, "request exceeds current NATS payload bound")

    async def _exchange(
        self, verb: str, body: bytes, *, mutation: bool, ranged: bool, metadata: str | None = None
    ) -> tuple[Wire, bytes]:
        headers = None
        header_bytes = 0
        if metadata is not None:
            header_bytes = _HEADER_FRAME_BYTES + len(p.METADATA_HEADER) + 4 + len(metadata.encode())
            p.check(
                header_bytes <= p.MAX_HEADER_BYTES
                and not any(char in metadata for char in "\r\n\0"),
                "invalid request header",
            )
            headers = {p.METADATA_HEADER: metadata}
        deadline = asyncio.get_running_loop().time() + self.timeout_s
        try:
            self._ready(len(body) + header_bytes)
            await asyncio.wait_for(self.nc.flush(), self.timeout_s)
            self._ready(len(body) + header_bytes)
            remaining = deadline - asyncio.get_running_loop().time()
            p.check(remaining > 0, "deadline ended before transmission")
        except Exception as cause:
            raise NativeScratchPadError(
                "unavailable", "request not transmitted", local=True, cause=cause
            ) from cause
        try:
            # No await separates the readiness check from invoking request.
            # The workflow keeps its durable intent if cancellation propagates.
            # Other request failures, including NoResponders, are ambiguous.
            reply = await asyncio.wait_for(
                self.nc.request(p.SUBJECT_PREFIX + verb, body, timeout=remaining, headers=headers),
                remaining,
            )
        except Exception as cause:
            raise NativeScratchPadError(
                "unknown" if mutation else "unavailable",
                "request returned no trustworthy reply",
                unknown=mutation,
                cause=cause,
            ) from cause
        try:
            count, size, value = 0, _HEADER_FRAME_BYTES, ""
            # nats-py exposes a decoded dictionary, not the raw header block.
            # Same-case duplicates and original invalid UTF-8 are not observable.
            for key, item in (reply.headers or {}).items():
                p.text(key, p.MAX_HEADER_BYTES)
                p.text(item, p.MAX_HEADER_BYTES)
                size += len(key.encode()) + 4 + len(item.encode())
                if key.lower() == p.REPLY_HEADER.lower():
                    count += 1
                    value = item
            p.check(
                size <= p.MAX_HEADER_BYTES and count == 1,
                "reply must expose one bounded ScratchPad-Reply header",
            )
            meta = p.validate_reply_metadata(p.parse_strict_json(value, p.MAX_HEADER_BYTES))
            if meta["code"] != "ok":
                p.check(not reply.data, "error reply has a body")
                raise NativeScratchPadError(
                    meta["code"],
                    meta["message"],
                    unknown=mutation and meta["code"] in {"unknown", "unavailable", "internal"},
                )
            p.check(ranged == ("range" in meta), "reply range does not match verb")
            p.check(
                len(reply.data) <= (p.MAX_READ_BYTES if ranged else p.MAX_REPLY_BYTES),
                "reply body exceeds bound",
            )
            return meta, reply.data
        except NativeScratchPadError as cause:
            if not cause.local:
                raise
            raise failed(mutation, "reply metadata is malformed", cause) from cause
        except Exception as cause:
            raise failed(mutation, "reply metadata is malformed", cause) from cause

    async def _control(
        self, verb: str, request: Wire, validate: Callable[[object], Wire], *, mutation: bool
    ) -> Wire:
        _validate_request(verb, request)
        body = p.go_json(request).encode()
        p.check(len(body) <= p.MAX_CONTROL_BYTES, "control request exceeds bound")
        _, reply = await self._exchange(verb, body, mutation=mutation, ranged=False)
        try:
            return validate(p.parse_strict_json(reply, p.MAX_REPLY_BYTES))
        except Exception as cause:
            raise failed(mutation, "reply body is malformed", cause) from cause

    @staticmethod
    def _matching(condition: bool, *, mutation: bool, detail: str) -> None:
        if not condition:
            raise failed(mutation, detail)

    async def _view(self, verb: str, target: Wire, request: Wire, *, mutation: bool) -> Wire:
        result = await self._control(verb, request, p.validate_volume_view, mutation=mutation)
        self._matching(
            result["target"] == target,
            mutation=mutation,
            detail="reply names another volume incarnation",
        )
        return result

    async def info(self) -> Wire:
        return await self._control("info", {}, p.validate_info, mutation=False)

    async def create_volume(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control(
            "volume.create", request, p.validate_volume_view, mutation=True
        )
        self._matching(
            result["target"]["volume"] == request["volume"],
            mutation=True,
            detail="reply names another volume",
        )
        return result

    async def get_volume(self, target: Wire) -> Wire:
        target = copy.deepcopy(target)
        return await self._view("volume.get", target, {"target": target}, mutation=False)

    async def prepare(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control(
            "object.prepare", request, p.validate_prepare_result, mutation=True
        )
        self._matching(
            len(result["objects"]) == len(request["objects"])
            and all(
                item["object"] == expected["object"] and item["length"] == expected["length"]
                for item, expected in zip(result["objects"], request["objects"], strict=False)
            ),
            mutation=True,
            detail="preparation reply names other objects",
        )
        return result

    async def put_prepared(self, request: Wire, data: bytes) -> None:
        request, data = copy.deepcopy(request), bytes(data)
        _validate_request("object.put", request)
        p.check(0 < len(data) <= p.MAX_NODE_BYTES, "object bytes exceed bound")
        try:
            verify_object(request["object"], data)
        except Exception as cause:
            raise invalid("object bytes differ from canonical identity", cause) from cause
        _, reply = await self._exchange(
            "object.put", data, mutation=True, ranged=False, metadata=p.go_json(request)
        )
        try:
            p.validate_empty(p.parse_strict_json(reply, p.MAX_REPLY_BYTES))
        except Exception as cause:
            raise failed(True, "put reply body is malformed", cause) from cause

    async def verify(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control(
            "object.verify", request, p.validate_verify_result, mutation=True
        )
        self._matching(
            result["epoch"] == request["epoch"]
            and len(result["objects"]) == len(request["objects"])
            and all(
                item["object"] == expected
                for item, expected in zip(result["objects"], request["objects"], strict=False)
            ),
            mutation=True,
            detail="verification reply names other objects or epoch",
        )
        return result

    async def publish(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control(
            "checkpoint.publish", request, p.validate_receipt, mutation=True
        )

        def normalize(command: Wire) -> Wire:
            return {
                **command,
                "trace": {key: value for key, value in command["trace"].items() if value != ""},
            }

        self._matching(
            result["volume"] == request["target"]["volume"]
            and normalize(result["command"]) == normalize(request["command"]),
            mutation=True,
            detail="receipt names another command",
        )
        return result

    async def reset_writer(self, target: Wire, writer: Wire) -> Wire:
        request = copy.deepcopy({"target": target, "writer": writer})
        result = await self._control("writer.reset", request, p.validate_writer, mutation=True)
        self._matching(
            result["slot"] == request["writer"]["slot"]
            and result["generation"] > request["writer"]["generation"],
            mutation=True,
            detail="reset reply names another writer generation",
        )
        return result

    async def retain(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        return await self._view("root.retain", request["target"], request, mutation=True)

    async def release(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        return await self._view("root.release", request["target"], request, mutation=True)

    async def issue_grant(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control("grant.issue", request, p.validate_grant_handle, mutation=True)
        self._matching(
            result["slot"] == request["slot"] and result["generation"] > request["generation"],
            mutation=True,
            detail="grant reply names another slot generation",
        )
        return result

    async def revoke_grant(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        return await self._view("grant.revoke", request["target"], request, mutation=True)

    async def stat(self, request: Wire) -> Wire:
        return await self._control(
            "content.stat", copy.deepcopy(request), p.validate_stat, mutation=False
        )

    async def list(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control(
            "content.list", request, p.validate_list_result, mutation=False
        )
        self._matching(
            len(result["entries"]) <= request["limit"]
            and result["next"] == request["offset"] + len(result["entries"]),
            mutation=False,
            detail="list result differs from requested window",
        )
        return result

    async def read(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        _validate_request("content.read", request)
        data = p.go_json(request).encode()
        p.check(len(data) <= p.MAX_CONTROL_BYTES, "read request exceeds bound")
        meta, body = await self._exchange("content.read", data, mutation=False, ranged=True)
        r = meta["range"]
        self._matching(
            r["offset"] == request["offset"]
            and r["length"] == min(request["length"], r["stat"]["size"] - r["offset"])
            and len(body) == r["length"],
            mutation=False,
            detail="range result differs from request",
        )
        return {"stat": r["stat"], "offset": r["offset"], "data": body}

    async def close_volume(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        return await self._view("maintenance.close", request["target"], request, mutation=True)

    async def plan_collection(self, request: Wire) -> Wire:
        return await self._control(
            "maintenance.plan", copy.deepcopy(request), p.validate_collection_report, mutation=False
        )

    async def apply_collection(self, request: Wire) -> Wire:
        request = copy.deepcopy(request)
        result = await self._control(
            "maintenance.apply", request, p.validate_collection_result, mutation=True
        )
        self._matching(
            result["volume"]["target"] == request["target"],
            mutation=True,
            detail="collection names another volume incarnation",
        )
        return result
