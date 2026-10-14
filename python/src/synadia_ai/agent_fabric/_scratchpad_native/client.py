"""Durable native writer and Fabric port on the caller's authenticated NATS connection."""

from __future__ import annotations

import asyncio
import os
import re
import time
import uuid
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Iterable, Mapping
from contextlib import asynccontextmanager
from copy import deepcopy
from typing import Any, NoReturn

from nats.aio.client import Client as NatsClient

from ..scratchpad import Grantee, GrantKind, TraceIds, _resolve
from .codec import (
    chunk_stream,
    decode_reference,
    encode_file_object,
    encode_reference,
    encode_tree_node,
    file_object_id,
    tree_node_id,
)
from .errors import NativeScratchPadError
from .protocol import (
    GRANT_SLOTS,
    MAX_GRANT_SECONDS,
    MAX_PREPARE_OBJECTS,
    check,
    record,
    text,
    uint,
    validate_action,
    validate_admission_binding,
    validate_command,
    validate_path,
    validate_principal,
    validate_receipt,
    validate_removal_plan,
    validate_renew_request,
    validate_retention_handle,
    validate_target,
    validate_volume,
    validate_volume_release_plan,
    validate_volume_release_result,
    validate_writer,
)
from .reader import ScratchPadReader, wire_trace
from .references import (
    SHORT_REFERENCE_PREFIX,
    validate_reference_publish_result,
    validate_reference_spec,
    validate_resolved_reference,
)
from .store import WorkspaceStore
from .transport import ScratchPadTransport


def now() -> int:
    return int(time.time())


def refuse(code: str, message: str) -> NoReturn:
    raise NativeScratchPadError(code, message, local=True)


def unknown(cause: BaseException | None, message: str) -> NativeScratchPadError:
    code = cause.code if isinstance(cause, NativeScratchPadError) else "unknown"
    return NativeScratchPadError(code, message, unknown=True, cause=cause)


def validate_grant(value: Any) -> None:
    grant = record(
        value,
        [
            "target",
            "slot",
            "generation",
            "principal",
            "root",
            "path",
            "retention",
            "until",
            "action",
        ],
    )
    validate_target(grant["target"])
    uint(grant["slot"], 15)
    uint(grant["generation"])
    validate_principal(grant["principal"])
    validate_path(grant["path"], 256)
    validate_retention_handle(grant["retention"])
    uint(grant["until"], minimum=1)
    validate_action(grant["action"])
    text(grant["root"], 43, 43)


def validate_state(value: Any) -> None:  # noqa: PLR0912, PLR0915 -- one case per saved state
    state = record(
        value,
        ["version", "principal", "volume", "creator", "creation", "next", "grants"],
        [
            "target",
            "writer",
            "pending",
            "last",
            "admission",
            "removal",
            "disposal",
            "renewal",
            "disposal_plan",
            "release_acceptance_unknown",
        ],
    )
    check(state["version"] == 1, "unsupported workspace version")
    validate_principal(state["principal"])
    validate_volume(state["volume"])
    text(state["creator"], 512, 1)
    validate_action(state["creation"])
    if "admission" in state:
        validate_admission_binding(state["admission"])
    if "removal" in state:
        removal = validate_receipt(state["removal"])
        check(
            removal["command"].get("remove_path")
            and removal["volume"] == state["volume"]
            and removal["principal"] == state["principal"]
            and removal["command"]["creation_id"] == state.get("target", {}).get("creation_id"),
            "saved removal differs from workspace",
        )
    if "disposal" in state:
        disposal = validate_volume_release_result(state["disposal"])
        check(
            disposal["capacity_returned"]
            and "pending" not in state
            and disposal["target"] == state.get("target")
            and disposal["slot"] == state.get("admission", {}).get("slot")
            and disposal["generation"] == state.get("admission", {}).get("generation"),
            "unfinished or foreign disposal",
        )
    if "disposal_plan" in state:
        plan = validate_volume_release_plan(state["disposal_plan"])
        disposal = state.get("disposal", {})
        check(
            plan["request"]["target"] == disposal.get("target")
            and all(plan[key] == disposal.get(key) for key in ("slot", "generation"))
            and plan["request"]["operation_id"] == disposal.get("operation_id"),
            "completed release plan differs from disposal",
        )
    if "release_acceptance_unknown" in state:
        check(
            state["release_acceptance_unknown"] is True and "disposal" in state,
            "invalid release acceptance marker",
        )
    uint(state["next"], minimum=1)
    if "target" in state:
        validate_target(state["target"])
        check(state["target"]["volume"] == state["volume"], "workspace target differs from volume")
    if "writer" in state:
        validate_writer(state["writer"])
        check(state["writer"]["slot"] == 0 and "target" in state, "invalid workspace writer")
    if "renewal" in state:
        validate_renew_request(state["renewal"])
        check(
            state.get("admission")
            and state["renewal"]["target"] == state.get("target")
            and "disposal" not in state
            and state.get("pending", {}).get("kind") not in ("renew", "volume_release"),
            "saved renewal conflicts with the workspace lifetime",
        )
    check(
        isinstance(state["grants"], list) and len(state["grants"]) <= GRANT_SLOTS,
        "workspace grant ledger exceeds bound",
    )
    for raw in state["grants"]:
        grant = record(raw, ["request", "handle", "kind"])
        check(grant["kind"] in ("first-hand", "on-request"), "invalid grant provenance")
        validate_grant(grant["request"])
        handle = record(grant["handle"], ["slot", "generation"])
        uint(handle["slot"], 15)
        uint(handle["generation"], minimum=1)
    if "last" in state:
        last = record(state["last"], ["reference", "receipt", "path", "ttl"], ["resolved"])
        validate_receipt(last["receipt"])
        text(last["reference"], 8192, 1)
        if last["reference"].startswith(SHORT_REFERENCE_PREFIX):
            pair = validate_resolved_reference(last.get("resolved"))
            validate_reference_publish_result({"receipt": last["receipt"], "references": [pair]})
            check(pair["short"] == last["reference"], "saved short reference differs")
            reference = pair["expanded"]
        else:
            check("resolved" not in last, "full reference has unexpected expansion")
            reference = decode_reference(last["reference"])
        validate_path(last["path"], 256)
        uint(last["ttl"], MAX_GRANT_SECONDS, 1)
        check(
            last["receipt"]["principal"] == state["principal"]
            and reference["target"] == state.get("target")
            and reference["root"] == last["receipt"]["head"]["root"]
            and reference["path"] == last["path"]
            and reference["retention"] == last["receipt"]["retention"],
            "saved receipt differs from workspace",
        )
    if "pending" not in state:
        return
    check("target" in state, "pending operation has no target")
    pending = state["pending"]
    check(isinstance(pending, dict), "invalid pending operation")
    kind = pending.get("kind")
    if kind == "renew":
        record(pending, ["kind", "request"])
        validate_renew_request(pending["request"])
    elif kind == "remove":
        record(pending, ["kind", "plan"])
        plan = validate_removal_plan(pending["plan"])
        check(
            plan["target"] == state["target"]
            and plan["command"]["writer"] == state.get("writer")
            and plan["command"]["number"] == state["next"],
            "saved removal writer differs",
        )
    elif kind == "volume_release":
        record(pending, ["kind", "plan"], ["fence_accepted"])
        if "fence_accepted" in pending:
            check(pending["fence_accepted"] is True, "invalid release fence marker")
        plan = validate_volume_release_plan(pending["plan"])
        check(plan["request"]["target"] == state["target"], "saved disposal names another target")
    elif kind == "publish":
        record(pending, ["kind", "command", "path", "ttl"], ["expiry_revision", "reference"])
        if "reference" in pending:
            spec = validate_reference_spec(pending["reference"])
            check(
                spec["creator"] == state["creator"] and spec["paths"] == [pending["path"]],
                "saved reference intent differs from publication",
            )
        validate_command(pending["command"])
        validate_path(pending["path"], 256)
        uint(pending["ttl"], MAX_GRANT_SECONDS, 1)
        if "expiry_revision" in pending:
            uint(pending["expiry_revision"], minimum=1)
        check(
            pending["command"]["creation_id"] == state["target"]["creation_id"]
            and pending["command"]["writer"] == state.get("writer")
            and pending["command"]["number"] == state["next"],
            "pending writer position differs",
        )
    elif kind == "reset":
        record(pending, ["kind", "writer"])
        validate_writer(pending["writer"])
    elif kind == "grant":
        record(pending, ["kind", "request", "provenance"])
        validate_grant(pending["request"])
        check(pending["provenance"] in ("first-hand", "on-request"), "invalid grant provenance")
    elif kind == "release":
        record(pending, ["kind", "request"])
        record(pending["request"], ["target", "handle"])
        validate_target(pending["request"]["target"])
        validate_retention_handle(pending["request"]["handle"])
    elif kind in ("close", "apply"):
        record(pending, ["kind", "request"])
        record(pending["request"], ["target", "revision"])
        validate_target(pending["request"]["target"])
        uint(pending["request"]["revision"], minimum=1)
    else:
        check(False, "unknown workspace pending operation")
    if "request" in pending:
        check(pending["request"]["target"] == state["target"], "pending target differs")
    if kind in ("remove", "volume_release"):
        check(
            state.get("admission")
            and all(
                pending["plan"][key] == state["admission"][key] for key in ("slot", "generation")
            ),
            "saved plan names another lifetime",
        )


class NativeScratchPad(ScratchPadReader):
    """One writer workspace, serialized on one event loop; call close before shutdown."""

    def __init__(
        self,
        transport: ScratchPadTransport,
        store: WorkspaceStore,
        state: dict[str, Any],
        scope: dict[str, Any] | None,
        ttl: int,
    ) -> None:
        super().__init__(transport, state["principal"])
        self._store = store
        self._state = state
        self._scope = scope
        self._ttl = ttl
        self._lock = asyncio.Lock()
        self._closing = False

    @asynccontextmanager
    async def _mutation(
        self, *, allow_renewal: bool = False, allow_disposed: bool = False
    ) -> AsyncIterator[None]:
        if self._closing:
            refuse("closed", "native client is closed")
        async with self._lock:
            if self._state.get("renewal") and not allow_renewal:
                refuse("busy", "recover the saved renewal before another mutation")
            if self._state.get("disposal") and not allow_disposed:
                refuse("fenced", "this workspace lifetime has been released")
            yield

    def _save(
        self, state: dict[str, Any], *, remote: bool = False, clear_objects: bool = False
    ) -> None:
        try:
            validate_state(state)
            self._store.save(state, after_remote=remote, clear_objects=clear_objects)
            self._state = state
        except Exception as cause:
            if remote:
                raise unknown(
                    cause, "remote effect may be accepted; close and reopen before recovery"
                ) from cause
            raise

    def _change(self, pending: dict[str, Any]) -> None:
        self._save({**self._state, "pending": pending})

    def _target(self) -> dict[str, Any]:
        check("target" in self._state, "workspace has no volume")
        target: dict[str, Any] = self._state["target"]
        return target

    async def _ensure_target(self) -> dict[str, Any]:
        if "target" not in self._state:
            view = await self._transport.create_volume(
                {
                    "volume": self._state["volume"],
                    "action": self._state["creation"],
                    **(
                        {"admission": self._state["admission"]}
                        if "admission" in self._state
                        else {}
                    ),
                }
            )
            if view["owner"] != self._principal:
                raise unknown(None, "volume creation names another owner")
            self._save({**self._state, "target": view["target"]}, remote=True)
            return view
        view = await self._transport.get_volume(self._target())
        check(view["owner"] == self._principal, "workspace principal is no longer the volume owner")
        check(
            view.get("lifetime", {}).get("admission") == self._state.get("admission"),
            "workspace lifetime differs from volume",
        )
        return view

    async def _initialize(self) -> None:
        if "writer" in self._state:
            return
        view = await self._ensure_target()
        if self._state.get("pending"):
            refuse(
                "fenced", "writer reset needs an explicit reset_writer with the observed generation"
            )
        slot = view["writers"][0]
        if slot["number"] != 0:
            refuse(
                "fenced",
                "writer has accepted commands without this journal; inspect and reset explicitly",
            )
        await self._reset({"slot": 0, "generation": slot["generation"]})

    async def _reset(self, writer: dict[str, Any]) -> dict[str, Any]:
        previous = self._state
        self._change({"kind": "reset", "writer": writer})
        try:
            result = await self._transport.reset_writer(self._target(), writer)
        except NativeScratchPadError as error:
            if not error.unknown:
                self._save(previous, remote=True)
            raise
        state = {**self._state, "writer": result, "next": 1}
        state.pop("pending", None)
        state.pop("last", None)
        state.pop("removal", None)
        self._save(state, remote=True, clear_objects=True)
        return deepcopy(result)

    async def reset_writer(
        self, *, expected_generation: int, target: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Explicitly abandon recovery by fencing the exact observed writer generation."""
        async with self._mutation():
            uint(expected_generation, minimum=1)
            if target is not None:
                target = deepcopy(target)
                validate_target(target)
                check(
                    target["volume"] == self._state["volume"], "reset target names another volume"
                )
                if "target" in self._state:
                    check(target == self._target(), "reset target differs from workspace")
                else:
                    view = await self._transport.get_volume(target)
                    check(view["owner"] == self._principal, "reset target has another owner")
                    self._save({**self._state, "target": view["target"]})
            await self._ensure_target()
            pending = self._state.get("pending")
            if pending and pending["kind"] not in ("reset", "publish"):
                refuse("busy", "recover the pending control request before resetting the writer")
            return await self._reset({"slot": 0, "generation": expected_generation})

    async def describe(self) -> dict[str, Any]:
        async with self._mutation(allow_renewal=True, allow_disposed=True):
            view = await self._ensure_target()
            pending = self._state.get("pending")
            kind = pending["kind"] if pending else "renew" if self._state.get("renewal") else None
            return {"volume": view, **({"pending": kind} if kind else {})}

    async def renew_lease(self, until: int) -> dict[str, Any]:
        """Persist one absolute deadline; retries never extend it implicitly."""
        async with self._mutation(allow_renewal=True):
            request = {"target": self._target(), "until": until}
            validate_renew_request(request)
            if "disposal" in self._state:
                refuse("fenced", "this workspace lifetime has been released")
            pending = self._state.get("pending", {})
            if pending.get("kind") == "volume_release":
                refuse("busy", "the saved volume release must settle before renewal")
            # Keep exact replay of workspaces with the former pending renewal shape.
            if pending.get("kind") == "renew":
                if pending["request"] != request:
                    refuse("busy", "recover the saved renewal before changing its deadline")
                volume: dict[str, Any] = (await self._lifecycle(pending, fresh=False))["volume"]
                return volume
            saved = self._state.get("renewal")
            if saved and saved != request:
                refuse("busy", "recover the saved renewal before changing its deadline")
            if not saved:
                self._save({**self._state, "renewal": request})
            return await self._resume_renewal(request, fresh=not saved)

    async def _resume_renewal(self, request: dict[str, Any], *, fresh: bool) -> dict[str, Any]:
        try:
            volume = await self._transport.renew_lease(request)
            if volume.get("lifetime", {}).get("admission") != self._state.get("admission"):
                raise unknown(None, "renewal names another lifetime")
        except Exception as error:
            if (
                isinstance(error, NativeScratchPadError)
                and not error.unknown
                and (fresh or error.code == "expired")
            ):
                state = dict(self._state)
                state.pop("renewal", None)
                self._save(state, remote=True)
                raise
            raise unknown(error, "the saved renewal stays pending; call recover()") from error
        state = dict(self._state)
        state.pop("renewal", None)
        self._save(state, remote=True)
        return deepcopy(volume)

    async def plan_removal(
        self, path: str, *, operation_id: str, trace: TraceIds | None = None
    ) -> dict[str, Any]:
        """Read-only plan for the caller's chosen path on an initialized writer."""
        async with self._mutation():
            if self._state.get("pending"):
                refuse("busy", "recover the pending operation before planning removal")
            check(
                self._state.get("writer") and self._state.get("admission"),
                "removal requires an initialized reusable writer",
            )
            view = await self._ensure_target()
            return await self._transport.plan_removal(
                {
                    "target": self._target(),
                    "command": {
                        "creation_id": self._target()["creation_id"],
                        "writer": self._state["writer"],
                        "number": self._state["next"],
                        "operation_id": operation_id,
                        "base": view["head"],
                        "root": view["head"]["root"],
                        "trace": wire_trace(trace),
                        "remove_path": path,
                        "retention": {"enabled": False, "slot": 0, "generation": 0, "until": 0},
                    },
                }
            )

    async def apply_removal(self, plan: dict[str, Any]) -> dict[str, Any]:
        saved = deepcopy(plan)
        async with self._mutation():
            validate_removal_plan(saved)
            check(
                saved["target"] == self._target()
                and all(
                    saved[key] == self._state.get("admission", {}).get(key)
                    for key in ("slot", "generation")
                ),
                "removal plan names another lifetime",
            )
            if (
                not self._state.get("pending")
                and self._state.get("removal", {}).get("command") == saved["command"]
            ):
                result: dict[str, Any] = deepcopy(self._state["removal"])
                return result
            result = (await self._begin_lifecycle({"kind": "remove", "plan": saved}))["receipt"]
            return result

    async def plan_volume_release(
        self, *, operation_id: str, end_promises: bool = False
    ) -> dict[str, Any]:
        """List affected promises. Ending them requires explicit end_promises=True."""
        async with self._mutation():
            if self._state.get("pending"):
                refuse("busy", "recover the pending operation before planning release")
            check(self._state.get("admission"), "volume release requires a reusable lifetime")
            return await self._transport.plan_volume_release(
                {
                    "target": self._target(),
                    "operation_id": operation_id,
                    "end_promises": end_promises,
                }
            )

    async def apply_volume_release(self, plan: dict[str, Any]) -> dict[str, Any]:
        saved = deepcopy(plan)
        async with self._mutation(allow_disposed=True):
            validate_volume_release_plan(saved)
            if not self._state.get("pending") and "disposal" in self._state:
                check(
                    self._state.get("disposal_plan") == saved,
                    "completed release differs from plan",
                )
                return self._release_outcome()
            result: dict[str, Any] = (
                await self._begin_lifecycle({"kind": "volume_release", "plan": saved})
            )["release"]
            return result

    async def _begin_lifecycle(self, pending: dict[str, Any]) -> dict[str, Any]:
        if "disposal" in self._state:
            refuse("fenced", "this workspace lifetime has been released")
        if self._state.get("pending"):
            saved = self._state["pending"]
            intent = {key: value for key, value in saved.items() if key != "fence_accepted"}
            if intent != pending:
                refuse("busy", "recover the saved operation before changing intent")
            return await self._lifecycle(saved, fresh=False)
        self._change(pending)
        return await self._lifecycle(pending, fresh=True)

    async def _lifecycle(self, pending: dict[str, Any], *, fresh: bool) -> dict[str, Any]:
        kind = pending["kind"]
        try:
            if kind == "renew":
                volume = await self._transport.renew_lease(pending["request"])
                if volume.get("lifetime", {}).get("admission") != self._state.get("admission"):
                    raise unknown(None, "renewal names another lifetime")
                result = {"kind": kind, "volume": volume}
            elif kind == "remove":
                receipt = await self._transport.apply_removal(pending["plan"])
                if receipt["principal"] != self._principal:
                    raise unknown(None, "removal names another principal")
                result = {"kind": kind, "receipt": receipt}
            else:
                result = {
                    "kind": kind,
                    "release": await self._transport.apply_volume_release(pending["plan"]),
                }
        except Exception as error:
            if (
                kind == "volume_release"
                and isinstance(error, NativeScratchPadError)
                and error.code == "generation_retired"
                and not error.unknown
            ):
                plan = pending["plan"]
                release = {
                    "target": plan["request"]["target"],
                    "slot": plan["slot"],
                    "generation": plan["generation"],
                    "operation_id": plan["request"]["operation_id"],
                    "disposed": True,
                    "capacity_returned": True,
                }
                return self._finish_release(
                    plan, release, acceptance_unknown=not pending.get("fence_accepted", False)
                )
            if (
                kind == "volume_release"
                and not fresh
                and not pending.get("fence_accepted", False)
                and isinstance(error, NativeScratchPadError)
                and not error.unknown
                and error.code == "conflict"
                and await self._release_fenced(pending["plan"])
            ):
                state = dict(self._state)
                state.pop("pending", None)
                self._save(state, remote=True)
                refuse("fenced", "the saved release cannot take effect; review a new release plan")
            if (
                isinstance(error, NativeScratchPadError)
                and not error.unknown
                and (fresh or (kind == "renew" and error.code == "expired"))
            ):
                state = dict(self._state)
                state.pop("pending", None)
                self._save(state, remote=True)
                raise
            raise unknown(
                error, f"the saved {kind} request stays pending; call recover()"
            ) from error
        if kind == "volume_release" and "release" in result:
            if result["release"]["capacity_returned"]:
                return self._finish_release(
                    pending["plan"], result["release"], acceptance_unknown=False
                )
            self._save({**self._state, "pending": {**pending, "fence_accepted": True}}, remote=True)
            return deepcopy(result)
        state = dict(self._state)
        state.pop("pending", None)
        if "receipt" in result:
            state["removal"] = result["receipt"]
            state["next"] = result["receipt"]["command"]["number"] + 1
        self._save(state, remote=True)
        return deepcopy(result)

    async def _release_fenced(self, plan: dict[str, Any]) -> bool:
        try:
            current = await self._transport.plan_volume_release(plan["request"])
        except Exception:
            # A failed read supplies no evidence about the saved fence.
            return False
        # A plan describes an ordinary, nonterminal lifetime. A greater native
        # position for that same lifetime stops every delayed old CAS.
        return bool(
            current["request"] == plan["request"]
            and current["incarnation"] == plan["incarnation"]
            and current["slot"] == plan["slot"]
            and current["generation"] == plan["generation"]
            and current["sequence"] > plan["sequence"]
        )

    def _release_outcome(self) -> dict[str, Any]:
        check(self._state.get("disposal"), "workspace has no completed release")
        result: dict[str, Any] = deepcopy(self._state["disposal"])
        if self._state.get("release_acceptance_unknown"):
            result["acceptance_unknown"] = True
        return result

    def _finish_release(
        self, plan: dict[str, Any], disposal: dict[str, Any], *, acceptance_unknown: bool
    ) -> dict[str, Any]:
        state = {**self._state, "disposal": disposal, "disposal_plan": plan}
        state.pop("pending", None)
        if acceptance_unknown:
            state["release_acceptance_unknown"] = True
        self._save(state, remote=True)
        return {"kind": "volume_release", "release": self._release_outcome()}

    async def recover(self) -> dict[str, Any]:
        async with self._mutation(allow_renewal=True, allow_disposed=True):
            return await self._recover_pending()

    async def _recover_pending(self) -> dict[str, Any]:  # noqa: PLR0911 -- one result per durable continuation
        if self._state.get("renewal"):
            return {
                "kind": "renew",
                "volume": await self._resume_renewal(self._state["renewal"], fresh=False),
            }
        lifecycle = self._state.get("pending")
        if lifecycle and lifecycle["kind"] in ("renew", "remove", "volume_release"):
            return await self._lifecycle(lifecycle, fresh=False)
        if "disposal" in self._state:
            return {"kind": "volume_release", "release": self._release_outcome()}
        if self._state.get("pending", {}).get("kind") == "reset":
            refuse(
                "fenced",
                "reset outcome needs an explicit reset_writer with the observed generation",
            )
        await self._initialize()
        pending = self._state.get("pending")
        if pending and pending["kind"] == "publish":
            try:
                return {"kind": "publish", **await self._resume_publish(pending)}
            except NativeScratchPadError as error:
                if error.code == "expired" and not error.unknown and not self._state.get("pending"):
                    return {"kind": "expired"}
                raise
        if pending:
            await self._control(pending, fresh=False)
            return {"kind": pending["kind"]}
        last = self._state.get("last")
        return {
            "kind": "ready",
            **(
                deepcopy({"reference": last["reference"], "receipt": last["receipt"]})
                if last
                else {}
            ),
        }

    async def publish_bytes(
        self,
        data: bytes,
        path: str,
        *,
        operation_id: str,
        ttl_seconds: int | None = None,
        trace: TraceIds | None = None,
    ) -> dict[str, Any]:
        return await self.publish_stream(
            [bytes(data)], path, operation_id=operation_id, ttl_seconds=ttl_seconds, trace=trace
        )

    async def publish_stream(
        self,
        source: AsyncIterable[bytes] | Iterable[bytes],
        path: str,
        *,
        operation_id: str,
        ttl_seconds: int | None = None,
        trace: TraceIds | None = None,
    ) -> dict[str, Any]:
        """Replace the head with one file; a repeated operation ID reuses its saved bytes."""
        return await self._publish(source, path, operation_id, ttl_seconds, trace, recover=False)

    async def _publish(  # noqa: PLR0912, PLR0915 -- one saved publication transition
        self,
        source: AsyncIterable[bytes] | Iterable[bytes],
        path: str,
        operation_id: str,
        ttl_seconds: int | None,
        trace: TraceIds | None,
        *,
        recover: bool,
    ) -> dict[str, Any]:
        async with self._mutation():
            validate_path(path, 256)
            check(path != "/", "a file path is required")
            labels = wire_trace(trace)
            ttl = self._ttl if ttl_seconds is None else ttl_seconds
            uint(ttl, MAX_GRANT_SECONDS, 1)
            validate_action({"operation_id": operation_id, "trace": labels})
            if recover:
                await self._recover_pending()
            await self._initialize()
            scope = self._scope
            if (
                scope is None
                or scope.get("admission") != self._state.get("admission")
                or "disposal" in self._state
            ):
                refuse("fenced", "workspace has no matching current reservation")
            pending = self._state.get("pending")
            if pending:
                if (
                    pending["kind"] != "publish"
                    or pending["command"]["operation_id"] != operation_id
                ):
                    refuse("busy", "recover the pending operation before publishing another one")
                self._same_publication(pending, path, ttl, labels)
                return await self._resume_publish(pending)
            last = self._state.get("last")
            if last and last["receipt"]["command"]["operation_id"] == operation_id:
                self._same_publication(
                    {
                        "command": last["receipt"]["command"],
                        "path": last["path"],
                        "ttl": last["ttl"],
                    },
                    path,
                    ttl,
                    labels,
                )
                return deepcopy({"reference": last["reference"], "receipt": last["receipt"]})
            capabilities = await self._transport.reference_info()
            reference = (
                {"creator": self._state["creator"], "paths": [path]}
                if capabilities and capabilities["enabled"]
                else None
            )
            if reference:
                validate_reference_spec(reference)
            self._store.clear_objects()
            ordinal, total_bytes = 0, 0

            def put(content: dict[str, Any], data: bytes) -> None:
                nonlocal ordinal, total_bytes
                total_bytes += len(data)
                if total_bytes > scope["bytes"] or ordinal + 1 > scope["objects"]:
                    refuse("capacity", "artifact exceeds this volume's configured capacity")
                self._store.put_object(ordinal, content, data)
                ordinal += 1

            try:
                file = await chunk_stream(source, lambda _index, content, data: put(content, data))
                encoded = encode_file_object(file)
                root = file_object_id(encoded)
                put({"kind": "fobj", "id": root}, encoded)
                kind = "file"
                for name in reversed(path[1:].split("/")):
                    encoded = encode_tree_node([{"name": name, "type": kind, "object": root}])
                    root = tree_node_id(encoded)
                    put({"kind": "tree", "id": root}, encoded)
                    kind = "directory"
                objects = self._store.objects()
                view = await self._transport.get_volume(self._target())
                clock = now()
                full = all(entry.get("pin") for entry in view["retentions"])
                can_release = any(
                    entry.get("pin")
                    and 0 < entry["pin"]["until"] <= clock
                    and not any(
                        grant.get("grant")
                        and grant["grant"]["until"] > clock
                        and grant["grant"]["retention"]
                        == {"slot": index, "generation": entry["generation"]}
                        for grant in view["grants"]
                    )
                    for index, entry in enumerate(view["retentions"])
                )
                if full and not can_release:
                    refuse(
                        "capacity",
                        "all retention slots hold live or protected handoffs; "
                        "cleanup cannot free a slot",
                    )
                artifact_bytes = sum(item["length"] for item in objects)
                if (
                    full
                    or view["objects"] + len(objects) > scope["objects"]
                    or view["bytes"] + artifact_bytes > scope["bytes"]
                ):
                    view = await self._maintain_internal()
                slot = next(
                    (
                        index
                        for index, entry in enumerate(view["retentions"])
                        if not entry.get("pin")
                    ),
                    -1,
                )
                if slot < 0:
                    refuse(
                        "capacity",
                        "all retention slots are occupied; release handoffs or wait for expiry",
                    )
                if (
                    view["objects"] + len(objects) > scope["objects"]
                    or view["bytes"] + artifact_bytes > scope["bytes"]
                ):
                    refuse("capacity", "live roots and this artifact exceed the volume's capacity")
                writer = self._state["writer"]
                actual = view["writers"][writer["slot"]]
                if (
                    actual["generation"] != writer["generation"]
                    or actual["number"] + 1 != self._state["next"]
                ):
                    refuse("fenced", "remote writer position differs from the durable workspace")
                if view["closed"]:
                    refuse("closed", "volume is closed by another maintenance interval")
                deadline_clock = now()
                until = min(
                    deadline_clock + ttl,
                    view.get("lifetime", {}).get("expires_at") or deadline_clock + ttl,
                )
                if until <= deadline_clock:
                    refuse("expired", "the observed lifetime has no remaining retention window")
                command = {
                    "creation_id": self._target()["creation_id"],
                    "writer": writer,
                    "number": self._state["next"],
                    "operation_id": operation_id,
                    "base": view["head"],
                    "root": root,
                    "trace": labels,
                    "retention": {
                        "enabled": True,
                        "slot": slot,
                        "generation": view["retentions"][slot]["generation"],
                        "until": until,
                    },
                }
                publication = {"kind": "publish", "command": command, "path": path, "ttl": ttl}
                if reference:
                    publication["reference"] = reference
                self._change(publication)
                return await self._resume_publish(publication)
            except BaseException:
                # Cancellation before an intent is saved leaves no remote artifact mutation.
                if not self._state.get("pending"):
                    self._store.clear_objects()
                raise

    @staticmethod
    def _same_publication(
        publication: dict[str, Any], path: str, ttl: int, trace: dict[str, Any]
    ) -> None:
        if (
            publication["path"] != path
            or publication["ttl"] != ttl
            or publication["command"]["trace"] != trace
        ):
            refuse(
                "intent_changed",
                "operation ID is bound to another publication; recovery uses saved bytes",
            )

    async def _resume_publish(self, publication: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0912 -- exact receipt and expiry recovery branches
        if "reference" in publication:
            try:
                result = await self._transport.reference_receipt(
                    {
                        "target": self._target(),
                        "command": publication["command"],
                        "reference": publication["reference"],
                    }
                )
                if result["receipt"]["principal"] != self._principal:
                    raise unknown(None, "referenced receipt names another principal")
                return self._accept(publication, result["receipt"], result["references"][0])
            except NativeScratchPadError as error:
                if error.code != "not_found" or error.unknown:
                    raise
        view = await self._transport.get_volume(self._target())
        command = publication["command"]
        slot = view["writers"][command["writer"]["slot"]]
        receipt = slot.get("receipt")
        if (
            "reference" not in publication
            and receipt
            and receipt["command"] == command
            and receipt["principal"] == self._principal
        ):
            return self._accept(publication, receipt)
        if (
            slot["generation"] != command["writer"]["generation"]
            or slot["number"] >= command["number"]
        ):
            refuse("fenced", "saved writer position has been fenced; inspect and reset explicitly")
        if "expiry_revision" in publication:
            await self._fence_expired(publication, view)
            raise NativeScratchPadError("expired", "saved publication expired without acceptance")
        # Receipt replay precedes expiry. An expired refusal still needs a
        # durable revision fence against an earlier in-flight publication CAS.
        if command["retention"]["until"] > now():
            await self._upload()
        try:
            resolved = None
            if "reference" in publication:
                result = await self._transport.reference_publish(
                    {
                        "target": self._target(),
                        "command": command,
                        "reference": publication["reference"],
                    }
                )
                receipt, resolved = result["receipt"], result["references"][0]
            else:
                receipt = await self._transport.publish(
                    {"target": self._target(), "command": command}
                )
        except NativeScratchPadError as error:
            if error.code == "expired" and not error.unknown:
                await self._fence_expired(publication, view)
            raise
        if receipt["command"] != command or receipt["principal"] != self._principal:
            raise unknown(None, "publish receipt differs from the saved command")
        return self._accept(publication, receipt, resolved)

    async def _fence_expired(self, publication: dict[str, Any], view: dict[str, Any]) -> None:
        revision = publication.get("expiry_revision")
        if revision is None:
            if view["closed"]:
                refuse("closed", "another maintenance interval owns this closed volume")
            revision = view["revision"]
            publication = {**publication, "expiry_revision": revision}
            self._change(publication)
        if not (view["closed"] and view["revision"] == revision + 1):
            if view["revision"] != revision:
                pending = dict(publication)
                del pending["expiry_revision"]
                self._change(pending)
                raise NativeScratchPadError(
                    "conflict", "expiry fence changed; recover the saved publication again"
                )
            view = await self._transport.close_volume(
                {"target": self._target(), "revision": revision}
            )
        slot = view["writers"][publication["command"]["writer"]["slot"]]
        if (
            not view["closed"]
            or view["revision"] != revision + 1
            or slot["generation"] != publication["command"]["writer"]["generation"]
            or slot["number"] != publication["command"]["number"] - 1
        ):
            raise unknown(None, "expiry fence has not established publication absence")
        # The close advanced publication's metadata record, fencing older CAS
        # writes. Persist collection's continuation before discarding the intent.
        continuation = {
            "kind": "apply",
            "request": {"target": self._target(), "revision": view["revision"]},
        }
        self._save({**self._state, "pending": continuation}, remote=True, clear_objects=True)
        await self._control(continuation, fresh=True)

    def _accept(
        self,
        publication: dict[str, Any],
        receipt: dict[str, Any],
        resolved: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        check(
            ("reference" in publication) == (resolved is not None),
            "referenced publication lost its descriptor",
        )
        reference = (
            resolved["short"]
            if resolved
            else encode_reference(
                {
                    "version": 2,
                    "creator": self._state["creator"],
                    "account": self._principal["account"],
                    "target": self._target(),
                    "root": receipt["head"]["root"],
                    "generation": receipt["head"]["generation"],
                    "path": publication["path"],
                    "retention": receipt["retention"],
                    "expires_at": publication["command"]["retention"]["until"],
                }
            )
        )
        state = {
            **self._state,
            "next": receipt["command"]["number"] + 1,
            "last": {
                "reference": reference,
                "receipt": receipt,
                "path": publication["path"],
                "ttl": publication["ttl"],
                **({"resolved": resolved} if resolved else {}),
            },
        }
        state.pop("pending", None)
        self._save(state, remote=True, clear_objects=True)
        if resolved:
            self._cache_reference(resolved)
        return deepcopy({"reference": reference, "receipt": receipt})

    async def _upload(self) -> None:
        objects = self._store.objects()
        check(bool(objects), "saved publication payload is missing")
        ordered = sorted(objects, key=lambda item: (item["object"]["kind"], item["object"]["id"]))
        verified: set[tuple[str, str]] = set()
        epoch = None
        for start in range(0, len(ordered), MAX_PREPARE_OBJECTS):
            result = await self._transport.prepare(
                {"target": self._target(), "objects": ordered[start : start + MAX_PREPARE_OBJECTS]}
            )
            if epoch is not None and epoch != result["epoch"]:
                raise unknown(
                    None, "upload preparation changed epoch; recover the saved publication"
                )
            epoch = result["epoch"]
            for item in result["objects"]:
                if item["state"] == "refused":
                    refuse(
                        "capacity", "object reservation refused; saved publication remains pending"
                    )
                if item["state"] == "verified":
                    verified.add((item["object"]["kind"], item["object"]["id"]))
        check(epoch is not None, "publication contains no objects")
        for spec in objects:
            content = spec["object"]
            if (content["kind"], content["id"]) in verified:
                continue
            await self._transport.put_prepared(
                {"target": self._target(), "object": content, "epoch": epoch},
                self._store.bytes(content),
            )
            next_offset = -1
            while True:
                result = await self._transport.verify(
                    {"target": self._target(), "epoch": epoch, "objects": [content]}
                )
                progress = result["objects"][0]
                if progress["state"] == "verified":
                    break
                if progress["state"] != "verifying" or progress["next"] <= next_offset:
                    raise unknown(None, "object verification did not advance")
                next_offset = progress["next"]

    async def commit(self, text: str, path: str, trace: TraceIds | None = None) -> str:
        result = await self._publish(
            [text.encode("utf-8")],
            path if path.startswith("/") else "/" + path,
            str(uuid.uuid4()),
            None,
            trace,
            recover=True,
        )
        reference: str = result["reference"]
        return reference

    def owns(self, reference: str) -> bool | Awaitable[bool]:
        def matches(ref: dict[str, Any]) -> bool:
            return bool(
                ref["creator"] == self._state["creator"]
                and ref["target"] == self._state.get("target")
            )

        async def resolved() -> bool:
            try:
                return matches(await self.resolve_reference(reference))
            except (NativeScratchPadError, ValueError):
                return False

        if reference.startswith(SHORT_REFERENCE_PREFIX):
            return resolved()
        try:
            return matches(self._reference(reference))
        except (NativeScratchPadError, ValueError):
            return False

    def granted(
        self, reference: str, grantee: Grantee
    ) -> GrantKind | Awaitable[GrantKind | None] | None:
        def find(ref: dict[str, Any]) -> GrantKind | None:
            if ref["creator"] != self._state["creator"] or ref["target"] != self._state.get(
                "target"
            ):
                return None
            kind: GrantKind | None = None
            for entry in self._state["grants"]:
                request = entry["request"]
                if (
                    request["until"] > now()
                    and request["principal"] == {"account": grantee.account, "user": grantee.user}
                    and request["root"] == ref["root"]
                    and request["path"] == ref["path"]
                    and request["retention"] == ref["retention"]
                ):
                    if entry["kind"] == "first-hand":
                        return "first-hand"
                    kind = "on-request"
            return kind

        async def resolved() -> GrantKind | None:
            try:
                return find(await self.resolve_reference(reference))
            except (NativeScratchPadError, ValueError):
                return None

        if reference.startswith(SHORT_REFERENCE_PREFIX):
            return resolved()
        try:
            return find(self._reference(reference))
        except (NativeScratchPadError, ValueError):
            return None

    async def grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None = None,
        tool_call_id: str | None = None,
        kind: GrantKind = "first-hand",
    ) -> None:
        async with self._mutation():
            principal = {"account": grantee.account, "user": grantee.user}
            validate_principal(principal)
            check(kind in ("first-hand", "on-request"), "invalid grant provenance")
            labels = wire_trace(trace, tool_call_id)
            if (
                not await _resolve(self.owns(reference))
                or grantee.account != self._principal["account"]
            ):
                refuse("denied", "only the owner can grant this same-account reference")
            ref = await self.resolve_reference(reference, trace)
            if self._state.get("pending"):
                await self._recover_pending()
            view = await self._transport.get_volume(self._target())
            clock = now()
            held = view["retentions"][ref["retention"]["slot"]]
            pin = held.get("pin")
            if (
                held["generation"] != ref["retention"]["generation"]
                or not pin
                or pin["root"] != ref["root"]
            ):
                refuse("expired", "reference retention is no longer held")
            until = min(clock + self._ttl, ref["expires_at"], pin["until"] or ref["expires_at"])
            if until <= clock:
                refuse("expired", "reference retention has expired")
            old = next(
                (
                    entry
                    for entry in self._state["grants"]
                    if entry["request"]["until"] >= until
                    and entry["request"]["principal"] == principal
                    and entry["request"]["root"] == ref["root"]
                    and entry["request"]["path"] == ref["path"]
                    and entry["request"]["retention"] == ref["retention"]
                    and view["grants"][entry["handle"]["slot"]]["generation"]
                    == entry["handle"]["generation"]
                ),
                None,
            )
            if old:
                if kind == "first-hand" and old["kind"] != kind:
                    grants = [
                        {**entry, "kind": kind} if entry is old else entry
                        for entry in self._state["grants"]
                    ]
                    self._save({**self._state, "grants": grants})
                return
            slot = next(
                (
                    index
                    for index, entry in enumerate(view["grants"])
                    if not entry.get("grant") or entry["grant"]["until"] <= clock
                ),
                -1,
            )
            if slot < 0:
                refuse("capacity", "all read-grant slots hold live grants")
            control = {
                "kind": "grant",
                "provenance": kind,
                "request": {
                    "target": self._target(),
                    "slot": slot,
                    "generation": view["grants"][slot]["generation"],
                    "principal": principal,
                    "root": ref["root"],
                    "path": ref["path"],
                    "retention": ref["retention"],
                    "until": until,
                    "action": {"operation_id": str(uuid.uuid4()), "trace": labels},
                },
            }
            self._change(control)
            await self._control(control, fresh=True)

    async def release(self, reference: str) -> None:
        """Release a completed handoff only when no live grant still uses it."""
        async with self._mutation():
            if self._state.get("pending"):
                refuse("busy", "recover the pending operation before release")
            ref = (
                await self.resolve_reference(reference)
                if reference.startswith(SHORT_REFERENCE_PREFIX)
                else decode_reference(reference)
            )
            if ref["account"] != self._principal["account"] or ref["target"] != self._state.get(
                "target"
            ):
                refuse("denied", "reference belongs to another workspace")
            view = await self._transport.get_volume(self._target())
            if any(
                entry.get("grant")
                and entry["grant"]["until"] > now()
                and entry["grant"]["retention"] == ref["retention"]
                for entry in view["grants"]
            ):
                refuse("busy", "a live read grant still uses this retention")
            control = {
                "kind": "release",
                "request": {"target": self._target(), "handle": ref["retention"]},
            }
            self._change(control)
            await self._control(control, fresh=True)

    async def maintain(self) -> dict[str, Any]:
        async with self._mutation():
            return await self._maintain_internal()

    async def _maintain_internal(self) -> dict[str, Any]:
        if self._state.get("pending"):
            refuse("busy", "recover the pending operation before collection")
        view = await self._ensure_target()
        if view["closed"]:
            refuse("closed", "another maintenance interval owns this closed volume")
        clock = now()
        for slot, held in enumerate(view["retentions"]):
            pin = held.get("pin")
            if not pin or pin["until"] == 0 or pin["until"] > clock:
                continue
            handle = {"slot": slot, "generation": held["generation"]}
            if any(
                entry.get("grant")
                and entry["grant"]["until"] > clock
                and entry["grant"]["retention"] == handle
                for entry in view["grants"]
            ):
                continue
            control = {"kind": "release", "request": {"target": self._target(), "handle": handle}}
            self._change(control)
            await self._control(control, fresh=True)
        view = await self._transport.get_volume(self._target())
        control = {
            "kind": "close",
            "request": {"target": self._target(), "revision": view["revision"]},
        }
        self._change(control)
        await self._control(control, fresh=True)
        return await self._transport.get_volume(self._target())

    async def _control(self, control: dict[str, Any], *, fresh: bool) -> None:  # noqa: PLR0912, PLR0915
        if control["kind"] == "apply" and self._state.get("admission"):
            try:
                observed = await self._transport.get_volume(control["request"]["target"])
            except Exception as error:
                raise unknown(
                    error, "private collection completion has not been observed"
                ) from error
            if observed["epoch"] > control["request"]["revision"]:
                state = dict(self._state)
                state.pop("pending", None)
                self._save(state, remote=True)
                refuse("fenced", "a later collection epoch superseded the saved interval")
            if observed["epoch"] < control["request"]["revision"]:
                raise unknown(None, "saved collection epoch has not been observed")
            if observed["closed"]:
                refuse("closed", "the private worker has not reopened the saved interval")
            state = dict(self._state)
            state.pop("pending", None)
            self._save(state, remote=True)
            return
        failure: BaseException | None = None
        view = None
        handle = None
        settled = False
        kind, request = control["kind"], control["request"]
        try:
            if kind == "grant":
                handle = await self._transport.issue_grant(request)
            elif kind == "release":
                view = await self._transport.release(request)
            elif kind == "close":
                view = await self._transport.close_volume(request)
            else:
                view = (await self._transport.apply_collection(request))["volume"]
            settled = True
        except Exception as error:
            failure = error
            if kind != "release":
                try:
                    view = await self._transport.get_volume(self._target())
                    if kind == "grant":
                        observed = view["grants"][request["slot"]]
                        grant = observed.get("grant")
                        if (
                            observed["generation"] > request["generation"]
                            and grant
                            and all(
                                grant[key] == request[key]
                                for key in ("principal", "root", "path", "retention", "until")
                            )
                        ):
                            handle = {"slot": request["slot"], "generation": observed["generation"]}
                            failure, settled = None, True
                    elif kind == "close":
                        exact = (
                            view["epoch"] == request["revision"] + 1
                            if self._state.get("admission")
                            else view["closed"] and view["revision"] == request["revision"] + 1
                        )
                        if exact:
                            failure, settled = None, True
                        elif view["revision"] != request["revision"]:
                            settled = True
                            failure = NativeScratchPadError(
                                "fenced" if self._state.get("admission") else "conflict",
                                "saved close is fenced by another revision",
                            )
                    elif not view["closed"]:
                        failure, settled = None, True
                except Exception:
                    # An unavailable observation does not establish absence of an effect.
                    pass
            if (
                isinstance(error, NativeScratchPadError)
                and not error.unknown
                and (fresh or kind == "release" or (kind == "grant" and error.code == "expired"))
            ):
                settled = True
        if (
            kind == "close"
            and self._state.get("admission")
            and view
            and view["epoch"] > request["revision"] + 1
        ):
            state = dict(self._state)
            state.pop("pending", None)
            self._save(state, remote=True)
            refuse("fenced", "a later collection epoch superseded the saved close")
        if not settled:
            raise unknown(failure, f"the saved {kind} request stays pending; call recover()")
        if (
            not failure
            and kind == "close"
            and (
                not view
                or (
                    view["epoch"] != request["revision"] + 1
                    if self._state.get("admission")
                    else not view["closed"] or view["revision"] != request["revision"] + 1
                )
            )
        ):
            raise unknown(None, "close returned another maintenance interval")
        state = dict(self._state)
        state.pop("pending", None)
        if not failure and kind == "grant":
            check(handle is not None, "grant acceptance has no handle")
            assert handle is not None
            state["grants"] = [
                entry
                for entry in state["grants"]
                if entry["request"]["until"] > now() and entry["handle"]["slot"] != handle["slot"]
            ]
            state["grants"].append(
                {"request": request, "handle": handle, "kind": control["provenance"]}
            )
        if (
            not failure
            and kind == "close"
            and (not self._state.get("admission") or (view and view["closed"]))
        ):
            assert view is not None
            state["pending"] = {
                "kind": "apply",
                "request": {
                    "target": self._target(),
                    "revision": request["revision"] + 1
                    if self._state.get("admission")
                    else view["revision"],
                },
            }
        self._save(state, remote=True)
        if failure:
            raise failure
        if state.get("pending", {}).get("kind") == "apply":
            await self._control(state["pending"], fresh=True)

    async def close(self) -> None:
        """Close the workspace after queued mutations. The caller retains its NATS connection."""
        self._closing = True
        async with self._lock:
            self._store.close()


async def native_scratchpad(
    *,
    nc: NatsClient,
    volume: str,
    dir: str | os.PathLike[str],
    creator: str,
    timeout_s: float = 10,
    ttl_seconds: int = 600,
) -> NativeScratchPad:
    """Construct a native writer; create its remote volume only on first use."""
    validate_volume(volume)
    text(creator, 512, 1)
    uint(ttl_seconds, MAX_GRANT_SECONDS, 1)
    transport = ScratchPadTransport(nc, timeout_s=timeout_s)
    info = await transport.info()
    scope = next((scope for scope in info["scopes"] if scope["volume"] == volume), None)
    store = WorkspaceStore.open(dir)
    try:
        state = store.load()
        if state is None:
            if scope is None:
                refuse(
                    "denied", "authenticated principal owns no provisioned scope for this volume"
                )
            state = {
                "version": 1,
                "principal": info["principal"],
                "volume": volume,
                "creator": creator,
                "creation": {"operation_id": str(uuid.uuid4()), "trace": {}},
                **({"admission": deepcopy(scope["admission"])} if "admission" in scope else {}),
                "next": 1,
                "grants": [],
            }
            store.save(state)
        validate_state(state)
        if "target" not in state and (
            scope is None or state.get("admission") != scope.get("admission")
        ):
            refuse("fenced", "saved creation cannot adopt a new lifetime")
        check(
            state["principal"] == info["principal"]
            and state["volume"] == volume
            and state["creator"] == creator,
            "workspace is bound to another principal, volume, or creator",
        )
        return NativeScratchPad(transport, store, state, scope, ttl_seconds)
    except BaseException:
        store.close()
        raise


async def native_scratchpad_from_env(
    env: Mapping[str, str] | None = None, *, nc: NatsClient, creator: str, timeout_s: float = 10
) -> NativeScratchPad | None:
    """Use the configured volume on the existing connection; an unset volume disables the client."""
    env = os.environ if env is None else env
    volume = env.get("SCRATCHPAD_VOLUME")
    if not volume:
        return None
    directory = env.get("SCRATCHPAD_DIR")
    check(bool(directory), "SCRATCHPAD_DIR must name a persistent private directory")
    assert directory is not None
    value = env.get("SCRATCHPAD_GRANT_TTL_S")
    check(
        value is None or bool(re.fullmatch(r"[0-9]+", value)),
        "SCRATCHPAD_GRANT_TTL_S must be an integer",
    )
    return await native_scratchpad(
        nc=nc,
        volume=volume,
        dir=directory,
        creator=creator,
        timeout_s=timeout_s,
        ttl_seconds=600 if value is None else int(value),
    )
