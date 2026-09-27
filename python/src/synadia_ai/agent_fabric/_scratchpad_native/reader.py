"""Authenticated immutable reads; buffered bytes are verified before return."""

from __future__ import annotations

import hashlib
import time
from collections.abc import AsyncIterator
from copy import deepcopy
from typing import Any

from nats.aio.client import Client as NatsClient

from ..scratchpad import TraceIds
from .codec import FileObject, chunk_id, decode_reference, encode_file_object, file_object_id
from .errors import NativeScratchPadError
from .protocol import CHUNK_SIZE, MAX_VOLUME_BYTES, check, uint, validate_trace
from .transport import ScratchPadTransport

DEFAULT_READ_LIMIT_BYTES = 16 * 1024 * 1024


def wire_trace(trace: TraceIds | None = None, tool_call_id: str | None = None) -> dict[str, Any]:
    labels = {"thread_id": trace.thread_id, "root_id": trace.root_id} if trace else {}
    if tool_call_id:
        labels["tool_call_id"] = tool_call_id
    validate_trace(labels)
    return {key: value for key, value in labels.items() if value != ""}


class ScratchPadReader:
    """Reads with the caller's own connection; no writer directory or credentials are stored."""

    def __init__(self, transport: ScratchPadTransport, principal: dict[str, Any]) -> None:
        self._transport = transport
        self._principal = deepcopy(principal)

    @property
    def principal(self) -> dict[str, Any]:
        return deepcopy(self._principal)

    def _reference(self, token: str) -> dict[str, Any]:
        reference = decode_reference(token)
        if reference["account"] != self._principal["account"]:
            raise NativeScratchPadError(
                "denied", "reference belongs to another account", local=True
            )
        if reference["expires_at"] <= int(time.time()):
            raise NativeScratchPadError("expired", "reference has expired", local=True)
        return dict(reference)

    async def _open_file(
        self, token: str, limit: int, trace: TraceIds | None
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        reference = self._reference(token)
        uint(limit, MAX_VOLUME_BYTES)
        request = {
            "target": reference["target"],
            "root": reference["root"],
            "path": reference["path"],
            "trace": wire_trace(trace),
        }
        metadata = await self._transport.stat(request)
        check(metadata["type"] == "file", "reference does not name a file")
        if metadata["size"] > limit:
            raise NativeScratchPadError(
                "capacity", f"file has {metadata['size']} bytes; read limit is {limit}", local=True
            )
        return request, metadata

    async def _chunks(
        self, request: dict[str, Any], metadata: dict[str, Any]
    ) -> AsyncIterator[bytes]:
        file: FileObject = {"size": metadata["size"], "digest": "", "chunks": []}
        digest = hashlib.sha256()
        for offset in range(0, metadata["size"], CHUNK_SIZE):
            length = min(CHUNK_SIZE, metadata["size"] - offset)
            result = await self._transport.read({**request, "offset": offset, "length": length})
            data = result["data"]
            if result["stat"] != metadata or result["offset"] != offset or len(data) != length:
                raise NativeScratchPadError("corrupt", "read range differs from immutable file")
            digest.update(data)
            file["chunks"].append({"id": chunk_id(data), "length": length})
            yield data
        file["digest"] = digest.hexdigest()
        if (
            file["digest"] != metadata["sha256"]
            or file_object_id(encode_file_object(file)) != metadata["object"]
        ):
            raise NativeScratchPadError(
                "corrupt", "file bytes differ from their digest or identity"
            )

    async def read_bytes(
        self,
        reference: str,
        *,
        limit_bytes: int = DEFAULT_READ_LIMIT_BYTES,
        trace: TraceIds | None = None,
    ) -> bytes:
        """Return complete bytes only after digest and canonical file identity verification."""
        request, metadata = await self._open_file(reference, limit_bytes, trace)
        output = bytearray(metadata["size"])
        offset = 0
        async for chunk in self._chunks(request, metadata):
            output[offset : offset + len(chunk)] = chunk
            offset += len(chunk)
        return bytes(output)

    async def read_stream(
        self, reference: str, *, limit_bytes: int, trace: TraceIds | None = None
    ) -> AsyncIterator[bytes]:
        """Bytes remain provisional until iteration completes. Early cancellation is unverified."""
        request, metadata = await self._open_file(reference, limit_bytes, trace)
        async for chunk in self._chunks(request, metadata):
            yield chunk

    async def read(self, reference: str, trace: TraceIds | None = None) -> str:
        return (await self.read_bytes(reference, trace=trace)).decode("utf-8", errors="strict")


async def scratchpad_reader(*, nc: NatsClient, timeout_s: float = 10) -> ScratchPadReader:
    transport = ScratchPadTransport(nc, timeout_s=timeout_s)
    info = await transport.info()
    return ScratchPadReader(transport, info["principal"])
