"""Saved lifecycle intents survive real SQLite workspace restarts."""

from __future__ import annotations

import json
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import pytest
from nats import NATS
from nats.aio.msg import Msg

from synadia_ai.agent_fabric._scratchpad_native import protocol as p
from synadia_ai.agent_fabric._scratchpad_native.client import native_scratchpad
from synadia_ai.agent_fabric._scratchpad_native.errors import NativeScratchPadError
from synadia_ai.agent_fabric._scratchpad_native.store import WorkspaceStore
from synadia_ai.agent_fabric._scratchpad_native.transport import ScratchPadTransport

from .test_scratchpad_native_transport import PRINCIPAL, ROOT, TARGET, message

ADMISSION = {"slot": 0, "generation": 7, "operation_id": "admit-7"}


def initial() -> p.Wire:
    return {
        "target": TARGET,
        "owner": PRINCIPAL,
        "head": {"generation": 1, "root": ROOT},
        "revision": 1,
        "closed": False,
        "epoch": 0,
        "objects": 1,
        "bytes": 4,
        "writers": [
            {
                "generation": 1,
                "number": 0,
                "write": slot == 0,
                **({"principal": PRINCIPAL} if slot == 0 else {}),
            }
            for slot in range(8)
        ],
        "retentions": [{"generation": 0} for _ in range(8)],
        "grants": [{"generation": 0} for _ in range(16)],
        "lifetime": {
            "admission": ADMISSION,
            "phase": "active",
            "expires_at": 1900000000,
            "grace_until": 0,
            "max_lease_seconds": 3600,
            "grace_seconds": 60,
            "recovery_reads": True,
            "reserve_objects": 128,
            "reserve_bytes": 8 * 2**20,
        },
    }


class Service:
    """Only the external public NATS API is replaced; workspace persistence is real."""

    def __init__(self) -> None:
        self.scope: p.Wire | None = {
            "volume": TARGET["volume"],
            "objects": 100,
            "bytes": 1 << 20,
            "admission": ADMISSION,
        }
        self.view = initial()
        self.calls: list[tuple[str, p.Wire]] = []
        self.drop = self.changed_reply = ""
        self.block = ""
        self.deny = ""
        self.drop_followup = ""
        self.capacity_returned = False
        self.release_code = ""
        self.renew_code = ""
        self.release_plan_override: p.Wire = {}
        self.is_connected, self.is_closed, self.is_draining = True, False, False
        self.max_payload = 1 << 20

    async def flush(self) -> None:
        pass

    async def request(  # noqa: PLR0912, PLR0915 -- one case per public verb and response fault
        self, subject: str, data: bytes, *, timeout: float, headers: dict[str, str] | None
    ) -> Msg:
        assert timeout > 0 and headers is None
        verb, body = subject.removeprefix(p.SUBJECT_PREFIX), json.loads(data)
        self.calls.append((verb, body))
        if self.block == verb:
            raise OSError("request withheld before acceptance")
        if self.deny == verb:
            return message(b"", {"code": "closed", "message": "lifetime closed"})
        if verb == "volume.release.apply" and self.release_code:
            return message(b"", {"code": self.release_code, "message": "release status"})
        if verb == "volume.renew" and self.renew_code:
            return message(b"", {"code": self.renew_code, "message": "renewal status"})
        value: Any
        if verb == "reference.info":
            return message(b"", {"code": "invalid", "message": "unsupported"})
        if verb == "object.prepare":
            value = {
                "epoch": self.view["epoch"],
                "objects": [
                    {**obj, "state": "verified", "next": 0, "code": "ok"} for obj in body["objects"]
                ],
            }
        elif verb == "checkpoint.publish":
            command = body["command"]
            value = {
                "volume": TARGET["volume"],
                "principal": PRINCIPAL,
                "command": command,
                "head": {"generation": command["base"]["generation"] + 1, "root": command["root"]},
                "retention": {"slot": command["retention"]["slot"], "generation": 3},
            }
        elif verb == "maintenance.close":
            if body["revision"] != self.view["revision"]:
                return message(b"", {"code": "conflict", "message": "revision changed"})
            self.view["revision"] += 1
            self.view["closed"] = True
            self.view["epoch"] = self.view["revision"]
            value = self.view
        elif verb == "info":
            value = {
                "principal": PRINCIPAL,
                "scopes": [self.scope] if self.scope else [],
                "limits": p.PUBLIC_LIMITS,
            }
        elif verb in ("volume.create", "volume.get"):
            value = self.view
        elif verb == "writer.reset":
            self.view["revision"] = 2
            self.view["writers"][0]["generation"] = 2
            value = {"slot": 0, "generation": 2}
        elif verb == "volume.renew":
            self.view["lifetime"]["expires_at"] = body["until"]
            self.view["lifetime"]["phase"] = "active"
            self.view["lifetime"]["grace_until"] = 0
            value = self.view
        elif verb == "volume.remove.plan":
            value = {
                **body,
                "slot": 0,
                "generation": 7,
                "sequence": 42,
                "added_objects": 1,
                "added_bytes": 4,
            }
        elif verb == "volume.remove.apply":
            command = body["command"]
            value = {
                "volume": TARGET["volume"],
                "principal": PRINCIPAL,
                "command": command,
                "head": {"generation": command["base"]["generation"] + 1, "root": command["root"]},
                "retention": {"slot": 0, "generation": 0},
            }
        elif verb == "volume.release.plan":
            value = {
                "request": body,
                "incarnation": "ab" * 32,
                "slot": 0,
                "generation": 7,
                "sequence": 43,
                "head": self.view["head"],
                "effects": {
                    "objects": 1,
                    "bytes": 4,
                    "retentions": 1,
                    "read_grants": 1,
                    "access_slots": 1,
                    "references": 1,
                },
                **self.release_plan_override,
            }
        elif verb == "volume.release.apply":
            value = {
                "target": TARGET,
                "slot": 0,
                "generation": 7,
                "operation_id": body["request"]["operation_id"],
                "disposed": True,
                "capacity_returned": self.capacity_returned,
            }
        else:
            raise AssertionError(f"unexpected request {verb}")
        if self.drop == verb:
            self.drop, self.drop_followup = self.drop_followup, ""
            raise OSError("accepted response withheld")
        if self.changed_reply == verb:
            value = deepcopy(value)
            if verb == "volume.create":
                value["lifetime"]["admission"]["generation"] += 1
            elif verb == "volume.remove.apply":
                value["command"]["remove_path"] = "/other"
            else:
                value["generation"] = 8
        if "command" in value:
            value = deepcopy(value)
            value["command"]["trace"] = {
                key: entry for key, entry in value["command"]["trace"].items() if entry != ""
            }
        return message(value)

    async def open(self, directory: Path) -> Any:
        return await native_scratchpad(
            nc=cast(NATS, self), volume=TARGET["volume"], creator="agents.writer", dir=directory
        )


async def test_creation_binding_persisted_and_exact_after_restart(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    service.drop = "volume.create"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    assert store.load()["admission"] == ADMISSION
    store.close()
    client = await service.open(tmp_path)
    await client.recover()
    await client.close()
    creates = [call for call in service.calls if call[0] == "volume.create"]
    assert len(creates) == 2 and creates[0] == creates[1]


@pytest.mark.parametrize("legacy", [False, True])
async def test_saved_creation_never_adopts_successor(tmp_path: Path, legacy: bool) -> None:
    service = Service()
    if legacy:
        assert service.scope
        service.scope.pop("admission")
        service.view.pop("lifetime")
    client = await service.open(tmp_path)
    service.drop = "volume.create"
    with pytest.raises(NativeScratchPadError):
        await client.recover()
    await client.close()
    service.scope = {
        "volume": TARGET["volume"],
        "objects": 100,
        "bytes": 1 << 20,
        "admission": {**ADMISSION, "generation": 8},
    }
    with pytest.raises(NativeScratchPadError) as failure:
        await service.open(tmp_path)
    assert failure.value.code == "fenced" and failure.value.local
    assert len([call for call in service.calls if call[0] == "volume.create"]) == 1


async def test_absolute_renewal_recovery_and_changed_intent_refusal(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    service.drop = "volume.renew"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000300)
    assert failure.value.unknown
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000400)
    assert failure.value.code == "busy"
    await client.close()
    client = await service.open(tmp_path)
    assert (await client.recover())["volume"]["lifetime"]["expires_at"] == 1900000300
    await client.close()
    renewals = [call for call in service.calls if call[0] == "volume.renew"]
    assert len(renewals) == 2 and renewals[0] == renewals[1]


@pytest.mark.parametrize("blocked", ["writer.reset", "maintenance.close"])
async def test_independent_renewal_preserves_unknown_operation_across_restart(  # noqa: PLR0915 -- one restart schedule with both saved intents
    tmp_path: Path, blocked: str
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    if blocked == "maintenance.close":
        await client.recover()
    service.block = blocked
    with pytest.raises(NativeScratchPadError) as failure:
        if blocked == "writer.reset":
            await client.recover()
        else:
            await client.maintain()
    assert failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    original = store.load()
    assert original["target"] == TARGET
    if blocked == "writer.reset":
        assert "writer" not in original
    original_bytes = json.dumps(original["pending"])
    store.close()
    service.view["lifetime"]["phase"] = "expiring"
    service.view["lifetime"]["grace_until"] = 1900000060
    client = await service.open(tmp_path)
    service.deny = "volume.renew"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000299)
    assert failure.value.code == "closed" and not failure.value.unknown
    service.deny = ""
    service.drop = "volume.renew"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000300)
    assert failure.value.unknown
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000400)
    assert failure.value.code == "busy"
    before_mutation = len(service.calls)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.reset_writer(expected_generation=2)
    assert failure.value.code == "busy" and len(service.calls) == before_mutation
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    saved = store.load()
    assert json.dumps(saved["pending"]) == original_bytes
    assert saved["renewal"] == {"target": TARGET, "until": 1900000300}
    store.close()
    client = await service.open(tmp_path)
    before_recovery = len(service.calls)
    assert (await client.recover())["kind"] == "renew"
    assert [call[0] for call in service.calls[before_recovery:]] == ["volume.renew"]
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    after = store.load()
    assert json.dumps(after["pending"]) == original_bytes and "renewal" not in after
    store.close()
    assert [
        call[1]
        for call in service.calls
        if call[0] == "volume.renew" and call[1]["until"] == 1900000300
    ] == [
        {"target": TARGET, "until": 1900000300},
        {"target": TARGET, "until": 1900000300},
    ]


async def test_renew_saved_target_after_lost_creation_and_refused_initializer_reset(
    tmp_path: Path,
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    service.drop = "volume.create"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.unknown
    await client.close()
    service.view["lifetime"]["phase"] = "expiring"
    service.view["lifetime"]["grace_until"] = 1900000060
    service.deny = "writer.reset"
    client = await service.open(tmp_path)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.code == "closed" and not failure.value.unknown
    before = len(service.calls)
    assert (await client.renew_lease(1900000300))["lifetime"]["phase"] == "active"
    assert [call[0] for call in service.calls[before:]] == ["volume.renew"]
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    state = store.load()
    assert state["target"] == TARGET and state["admission"] == ADMISSION and "writer" not in state
    store.close()
    creates = [call for call in service.calls if call[0] == "volume.create"]
    assert len(creates) == 2 and creates[0] == creates[1]


async def test_former_pending_renewal_replays_without_replacing_deadline(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    service.drop = "volume.renew"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000300)
    assert failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    state = store.load()
    state["pending"] = {"kind": "renew", "request": state.pop("renewal")}
    store.save(state)
    store.close()
    client = await service.open(tmp_path)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000400)
    assert failure.value.code == "busy"
    assert (await client.recover())["volume"]["lifetime"]["expires_at"] == 1900000300
    await client.close()
    renewals = [call for call in service.calls if call[0] == "volume.renew"]
    assert len(renewals) == 2 and renewals[0] == renewals[1]


async def test_expired_unaccepted_renewal_preserves_ordinary_pending(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    service.block = "maintenance.close"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.maintain()
    assert failure.value.unknown
    service.block = "volume.renew"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000300)
    assert failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    original = store.load()
    pending_bytes = json.dumps(original["pending"])
    store.close()
    service.block, service.renew_code = "", "invalid"
    client = await service.open(tmp_path)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.unknown
    service.renew_code = "expired"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.code == "expired" and not failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    expired = store.load()
    assert "renewal" not in expired and json.dumps(expired["pending"]) == pending_bytes
    store.close()
    service.renew_code = ""
    client = await service.open(tmp_path)
    assert (await client.renew_lease(1900000400))["lifetime"]["expires_at"] == 1900000400
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    assert json.dumps(store.load()["pending"]) == pending_bytes
    store.close()
    assert len([call for call in service.calls if call[0] == "maintenance.close"]) == 1
    assert [call[1] for call in service.calls if call[0] == "volume.renew"] == [
        original["renewal"],
        original["renewal"],
        original["renewal"],
        {"target": TARGET, "until": 1900000400},
    ]


async def test_expired_renewal_in_former_pending_shape_settles(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    service.block = "volume.renew"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000300)
    assert failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    saved = store.load()
    saved["pending"] = {"kind": "renew", "request": saved.pop("renewal")}
    store.save(saved)
    store.close()
    service.block, service.renew_code = "", "expired"
    client = await service.open(tmp_path)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.code == "expired" and not failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    assert "pending" not in store.load()
    store.close()


async def test_newer_nonterminal_plan_fences_unaccepted_release(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    plan = await client.plan_volume_release(operation_id="release-fenced", end_promises=True)
    service.block = "volume.release.apply"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.apply_volume_release(plan)
    assert failure.value.unknown
    await client.close()
    service.block, service.release_code = "", "conflict"
    service.release_plan_override = {"sequence": plan["sequence"] + 1}
    client = await service.open(tmp_path)
    before = len(service.calls)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.code == "fenced" and not failure.value.unknown
    assert [call[0] for call in service.calls[before:]] == [
        "volume.release.apply",
        "volume.release.plan",
    ]
    assert service.calls[-1][1] == plan["request"]
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    assert "pending" not in store.load() and "disposal" not in store.load()
    store.close()
    client = await service.open(tmp_path)
    assert (await client.renew_lease(1900000400))["lifetime"]["expires_at"] == 1900000400
    fresh = await client.plan_volume_release(operation_id="release-replanned", end_promises=True)
    assert fresh["sequence"] == plan["sequence"] + 1
    await client.close()


@pytest.mark.parametrize(
    "missing",
    ["same-position", "incarnation", "slot", "generation", "target", "unavailable", "accepted"],
)
async def test_release_keeps_intent_without_exact_newer_nonterminal_proof(
    tmp_path: Path, missing: str
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    plan = await client.plan_volume_release(operation_id="release-proof", end_promises=True)
    if missing == "accepted":
        await client.apply_volume_release(plan)
    else:
        service.block = "volume.release.apply"
        with pytest.raises(NativeScratchPadError) as failure:
            await client.apply_volume_release(plan)
        assert failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    original = json.dumps(store.load()["pending"])
    store.close()
    service.block = "volume.release.plan" if missing == "unavailable" else ""
    service.release_code = "conflict"
    service.release_plan_override = {"sequence": plan["sequence"] + 1}
    if missing == "same-position":
        service.release_plan_override["sequence"] = plan["sequence"]
    if missing == "incarnation":
        service.release_plan_override["incarnation"] = "cd" * 32
    if missing == "slot":
        service.release_plan_override["slot"] = plan["slot"] + 1
    if missing == "generation":
        service.release_plan_override["generation"] = plan["generation"] + 1
    if missing == "target":
        service.release_plan_override["request"] = {
            **plan["request"],
            "target": {**TARGET, "creation_id": "cd" * 16},
        }
    client = await service.open(tmp_path)
    before = len(service.calls)
    with pytest.raises(NativeScratchPadError) as failure:
        await client.recover()
    assert failure.value.unknown
    if missing == "accepted":
        assert [call[0] for call in service.calls[before:]] == ["volume.release.apply"]
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    assert json.dumps(store.load()["pending"]) == original and "disposal" not in store.load()
    store.close()


async def test_removal_is_planned_read_only_and_recovers_exact_receipt(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    before = len(service.calls)
    plan = await client.plan_removal("/obsolete", operation_id="remove-1")
    assert [call[0] for call in service.calls[before:]] == ["volume.get", "volume.remove.plan"]
    service.drop = "volume.remove.apply"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.apply_removal(plan)
    assert failure.value.unknown
    with pytest.raises(NativeScratchPadError) as failure:
        await client.apply_removal({**plan, "sequence": plan["sequence"] + 1})
    assert failure.value.code == "busy"
    await client.close()
    client = await service.open(tmp_path)
    recovered = await client.recover()
    assert recovered["receipt"]["command"] == plan["command"] and "reference" not in recovered
    assert await client.apply_removal(plan) == recovered["receipt"]
    await client.close()
    applies = [call for call in service.calls if call[0] == "volume.remove.apply"]
    assert len(applies) == 2 and applies[0] == applies[1]


async def test_release_waits_for_capacity_and_reopens_without_owned_scope(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    assert not (await client.plan_volume_release(operation_id="release-1"))["request"][
        "end_promises"
    ]
    plan = await client.plan_volume_release(operation_id="release-1", end_promises=True)
    service.drop = "volume.release.apply"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.apply_volume_release(plan)
    assert failure.value.unknown
    await client.close()
    service.scope = None
    client = await service.open(tmp_path)
    result = (await client.recover())["release"]
    assert result["disposed"] and not result["capacity_returned"]
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000500)
    assert failure.value.code == "busy"
    await client.close()
    service.capacity_returned = True
    client = await service.open(tmp_path)
    assert (await client.recover())["release"]["capacity_returned"]
    before = len(service.calls)
    assert (await client.apply_volume_release(plan))["capacity_returned"]
    assert len(service.calls) == before
    await client.close()
    applies = [call for call in service.calls if call[0] == "volume.release.apply"]
    assert len(applies) == 3 and all(call[1] == plan for call in applies)


@pytest.mark.parametrize("accepted", [False, True])
async def test_release_recovers_retired_generation_with_saved_acceptance(  # noqa: PLR0915 -- one restart schedule with exact terminal evidence
    tmp_path: Path, accepted: bool
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    plan = await client.plan_volume_release(operation_id="release-reuse", end_promises=True)
    if accepted:
        assert not (await client.apply_volume_release(plan))["capacity_returned"]
    else:
        service.drop = "volume.release.apply"
        with pytest.raises(NativeScratchPadError) as failure:
            await client.apply_volume_release(plan)
        assert failure.value.unknown
    with pytest.raises(NativeScratchPadError) as failure:
        await client.apply_volume_release({**plan, "incarnation": "cd" * 32})
    assert failure.value.code == "busy"
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    saved = store.load()
    assert saved["pending"].get("fence_accepted") is (True if accepted else None)
    store.close()
    assert service.scope is not None
    service.scope["admission"] = {**ADMISSION, "generation": ADMISSION["generation"] + 1}
    client = await service.open(tmp_path)
    for code in ("fenced", "denied", "not_found", "corrupt"):
        service.release_code = code
        with pytest.raises(NativeScratchPadError) as failure:
            await client.recover()
        assert failure.value.code == code and failure.value.unknown
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    assert store.load()["pending"] == saved["pending"]
    assert "disposal" not in store.load()
    store.close()
    service.release_code = "generation_retired"
    client = await service.open(tmp_path)
    recovered = (
        await client.apply_volume_release(plan) if accepted else (await client.recover())["release"]
    )
    assert recovered == {
        "target": TARGET,
        "slot": ADMISSION["slot"],
        "generation": ADMISSION["generation"],
        "operation_id": "release-reuse",
        "disposed": True,
        "capacity_returned": True,
        **({"acceptance_unknown": True} if not accepted else {}),
    }
    await client.close()
    client = await service.open(tmp_path)
    before = len(service.calls)
    assert (await client.recover())["release"] == recovered
    assert await client.apply_volume_release(plan) == recovered
    for changed in ({"incarnation": "cd" * 32}, {"sequence": plan["sequence"] + 1}):
        with pytest.raises(NativeScratchPadError) as failure:
            await client.apply_volume_release({**plan, **changed})
        assert failure.value.code == "invalid" and failure.value.local
    with pytest.raises(NativeScratchPadError) as failure:
        await client.renew_lease(1900000500)
    assert failure.value.code == "fenced" and failure.value.local
    with pytest.raises(NativeScratchPadError) as failure:
        await client.reset_writer(expected_generation=2)
    assert failure.value.code == "fenced" and failure.value.local
    with pytest.raises(NativeScratchPadError) as failure:
        await client.maintain()
    assert failure.value.code == "fenced" and failure.value.local
    assert len(service.calls) == before
    await client.close()
    store = WorkspaceStore.open(tmp_path)
    completed = store.load()
    assert completed["disposal_plan"] == plan and completed["admission"] == ADMISSION
    assert "pending" not in completed
    p.validate_volume_release_result(completed["disposal"])
    store.close()


async def test_release_incarnation_canonical_and_local_outcome_not_on_wire() -> None:
    service = Service()
    transport = ScratchPadTransport(cast(NATS, service))
    plan = await transport.plan_volume_release(
        {"target": TARGET, "operation_id": "release", "end_promises": True}
    )
    for incarnation in (None, "ab" * 31, "AB" * 32, "z" * 64):
        with pytest.raises(NativeScratchPadError):
            p.validate_volume_release_plan({**plan, "incarnation": incarnation})
    with pytest.raises(NativeScratchPadError):
        p.validate_volume_release_result(
            {
                "target": TARGET,
                "slot": ADMISSION["slot"],
                "generation": ADMISSION["generation"],
                "operation_id": "release",
                "disposed": True,
                "capacity_returned": True,
                "acceptance_unknown": True,
            }
        )


async def test_reply_mismatch_is_unknown_and_checkpoint_refuses_removal() -> None:
    service = Service()
    transport = ScratchPadTransport(cast(NATS, service))
    service.changed_reply = "volume.create"
    with pytest.raises(NativeScratchPadError) as failure:
        await transport.create_volume(
            {
                "volume": TARGET["volume"],
                "action": {"operation_id": "create", "trace": {}},
                "admission": ADMISSION,
            }
        )
    assert failure.value.unknown
    command = {
        "creation_id": TARGET["creation_id"],
        "writer": {"slot": 0, "generation": 2},
        "number": 1,
        "operation_id": "remove",
        "base": {"generation": 1, "root": ROOT},
        "root": ROOT,
        "trace": {"tool_call_id": ""},
        "remove_path": "/old",
        "retention": {"enabled": False, "slot": 0, "generation": 0, "until": 0},
    }
    before = len(service.calls)
    with pytest.raises(NativeScratchPadError) as failure:
        await transport.publish({"target": TARGET, "command": command})
    assert failure.value.local and not failure.value.unknown and len(service.calls) == before
    plan = await transport.plan_removal({"target": TARGET, "command": command})
    assert plan["command"]["trace"] == {}
    assert (await transport.apply_removal({**plan, "command": command}))["command"]["trace"] == {}
    service.changed_reply = "volume.remove.apply"
    with pytest.raises(NativeScratchPadError) as failure:
        await transport.apply_removal(
            {
                "target": TARGET,
                "command": command,
                "slot": 0,
                "generation": 7,
                "sequence": 42,
                "added_objects": 1,
                "added_bytes": 4,
            }
        )
    assert failure.value.unknown


def test_lifetime_bounds_and_legacy_absence() -> None:
    view = initial()
    p.validate_volume_view(view)
    for lifetime in (
        {**view["lifetime"], "admission": {**ADMISSION, "generation": 0}},
        {**view["lifetime"], "grace_until": 1},
        {**view["lifetime"], "reserve_objects": 0},
    ):
        with pytest.raises(NativeScratchPadError):
            p.validate_volume_view({**view, "lifetime": lifetime})
    view.pop("lifetime")
    p.validate_volume_view(view)


async def test_new_retention_is_lease_bounded_but_saved_retry_is_unchanged(tmp_path: Path) -> None:
    service = Service()
    deadline = int(time.time()) + 120
    service.view["lifetime"]["expires_at"] = deadline
    client = await service.open(tmp_path)
    await client.recover()
    service.drop = "checkpoint.publish"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.publish_bytes(
            b"kept", "/result", operation_id="publish-lease", ttl_seconds=600
        )
    assert failure.value.unknown
    await client.close()
    service.view["lifetime"]["expires_at"] = deadline + 300
    client = await service.open(tmp_path)
    assert (await client.recover())["receipt"]["command"]["retention"]["until"] == deadline
    await client.close()
    sent = [call for call in service.calls if call[0] == "checkpoint.publish"]
    assert len(sent) == 2 and sent[0] == sent[1]


async def test_elapsed_retention_refuses_before_artifact_mutations(tmp_path: Path) -> None:
    service = Service()
    service.view["lifetime"]["expires_at"] = int(time.time()) - 1
    client = await service.open(tmp_path)
    await client.recover()
    with pytest.raises(NativeScratchPadError) as failure:
        await client.publish_bytes(b"expired", "/result", operation_id="expired")
    assert failure.value.code == "expired" and failure.value.local and not failure.value.unknown
    await client.close()
    assert not any(
        call[0].startswith("object.") or call[0] == "checkpoint.publish" for call in service.calls
    )
    store = WorkspaceStore.open(tmp_path)
    assert "pending" not in store.load()
    store.close()


@pytest.mark.parametrize("superseded", [False, True])
async def test_lost_close_observes_completed_private_interval(
    tmp_path: Path, superseded: bool
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    service.drop, service.drop_followup = "maintenance.close", "volume.get"
    with pytest.raises(NativeScratchPadError) as failure:
        await client.maintain()
    assert failure.value.unknown
    await client.close()
    closed_epoch = service.view["epoch"]
    service.view["closed"] = False
    service.view["revision"] += 2
    if superseded:
        service.view["epoch"] = service.view["revision"]
    client = await service.open(tmp_path)
    if superseded:
        with pytest.raises(NativeScratchPadError) as failure:
            await client.recover()
        assert failure.value.code == "fenced"
        assert (await client.renew_lease(1900000100))["lifetime"]["expires_at"] == 1900000100
    else:
        assert (await client.recover())["kind"] == "close"
    await client.close()
    assert not any(call[0] == "maintenance.apply" for call in service.calls)
    closes = [call for call in service.calls if call[0] == "maintenance.close"]
    assert len(closes) == 2 and all(call[1]["revision"] == closed_epoch - 1 for call in closes)
    store = WorkspaceStore.open(tmp_path)
    state = store.load()
    assert "pending" not in state
    store.close()


@pytest.mark.parametrize("superseded", [False, True])
async def test_private_collection_observes_exact_saved_epoch(
    tmp_path: Path, superseded: bool
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    await client.recover()
    with pytest.raises(NativeScratchPadError) as failure:
        await client.maintain()
    assert failure.value.code == "closed"
    await client.close()
    service.view["closed"] = False
    service.view["revision"] += 1
    if superseded:
        service.view["epoch"] += 1
    client = await service.open(tmp_path)
    if superseded:
        with pytest.raises(NativeScratchPadError) as failure:
            await client.recover()
        assert failure.value.code == "fenced"
        assert (await client.renew_lease(1900000100))["lifetime"]["expires_at"] == 1900000100
    else:
        assert (await client.recover())["kind"] == "apply"
    await client.close()
    assert not any(call[0] == "maintenance.apply" for call in service.calls)
    store = WorkspaceStore.open(tmp_path)
    state = store.load()
    assert "pending" not in state
    store.close()


async def test_diagnostics_never_creates_unbound_volume(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    try:
        before = len(service.calls)
        result = await client.diagnostics()
        assert result["status"] == "unbound"
        assert result["allowance"] == {"bytes": 1 << 20, "objects": 100}
        assert "charged" not in result and "ordinary_headroom" not in result
        assert [verb for verb, _ in service.calls[before:]] == ["info"]
        assert not [verb for verb, _ in service.calls if verb != "info"]
    finally:
        await client.close()


async def test_diagnostics_does_not_change_persistent_workspace(tmp_path: Path) -> None:
    service = Service()
    client = await service.open(tmp_path)
    try:
        await client.describe()
        await client.close()
        store = WorkspaceStore.open(tmp_path)
        before = store.load()
        store.close()
        client = await service.open(tmp_path)
        requests = len(service.calls)
        await client.diagnostics()
        await client.close()
        store = WorkspaceStore.open(tmp_path)
        assert store.load() == before
        store.close()
        assert [verb for verb, _ in service.calls[requests:]] == ["info", "volume.get"]
    finally:
        await client.close()


async def test_diagnostics_reports_charged_history_and_exhausted_ordinary_capacity(
    tmp_path: Path,
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    try:
        await client.describe()
        service.view["bytes"] = (1 << 20) + 16
        service.view["objects"] = 101
        before = len(service.calls)
        result = await client.diagnostics()
        assert result["status"] == "observed"
        assert result["charged"] == {"bytes": (1 << 20) + 16, "objects": 101}
        assert result["ordinary_headroom"] == {"bytes": 0, "objects": 0}
        assert result["revision"] == service.view["revision"]
        assert result["lifetime"]["reserve_bytes"] == 8 * 2**20
        assert [verb for verb, _ in service.calls[before:]] == ["info", "volume.get"]
    finally:
        await client.close()


async def test_diagnostics_preserves_pending_renewal_and_refuses_bad_observations(
    tmp_path: Path,
) -> None:
    service = Service()
    client = await service.open(tmp_path)
    try:
        await client.describe()
        service.block = "volume.renew"
        with pytest.raises(NativeScratchPadError):
            await client.renew_lease(service.view["lifetime"]["expires_at"] + 1)
        service.block = ""
        before = len(service.calls)
        assert (await client.diagnostics())["pending"] == "renew"
        assert [verb for verb, _ in service.calls[before:]] == ["info", "volume.get"]
        assert service.scope is not None
        service.scope["admission"] = {**ADMISSION, "generation": ADMISSION["generation"] + 1}
        with pytest.raises(NativeScratchPadError) as fenced:
            await client.diagnostics()
        assert fenced.value.code == "fenced"
        service.scope = None
        with pytest.raises(NativeScratchPadError) as denied:
            await client.diagnostics()
        assert denied.value.code == "denied"
        service.block = "info"
        with pytest.raises(NativeScratchPadError):
            await client.diagnostics()
        assert all(verb in ("info", "volume.get") for verb, _ in service.calls[before:])
    finally:
        await client.close()
