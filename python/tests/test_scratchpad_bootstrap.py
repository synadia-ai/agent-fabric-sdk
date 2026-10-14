"""Exact creation import preserves real SQLite state; only NATS is replaced."""

from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any, cast

import pytest
from nats import NATS

from synadia_ai.agent_fabric._scratchpad_native import protocol as p
from synadia_ai.agent_fabric._scratchpad_native.bootstrap import (
    MAX_BOOTSTRAP_BYTES,
    decode_scratchpad_bootstrap,
    read_scratchpad_bootstrap_file,
)
from synadia_ai.agent_fabric._scratchpad_native.client import (
    native_scratchpad,
    native_scratchpad_from_env,
)
from synadia_ai.agent_fabric._scratchpad_native.errors import NativeScratchPadError
from synadia_ai.agent_fabric._scratchpad_native.store import WorkspaceStore

from .test_scratchpad_native_lifecycle import Service
from .test_scratchpad_native_transport import message

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "test-fixtures/scratchpad/bootstrap-v1.json").read_text()
)
CREATOR = "agents.prompt.test.acme.main"


def bootstrap(tmp_path: Path, descriptor: dict[str, Any] | None = None) -> Path:
    file = tmp_path / "bootstrap file.json"
    file.write_text(json.dumps(descriptor or FIXTURE["valid_trace"]))
    return file


def saved(directory: Path) -> Any:
    store = WorkspaceStore.open(directory)
    try:
        return store.load()
    finally:
        store.close()


def test_shared_complete_request_and_byte_bound() -> None:
    raw = FIXTURE["valid_json"]
    assert decode_scratchpad_bootstrap(raw) == FIXTURE["valid"]
    assert decode_scratchpad_bootstrap(json.dumps(FIXTURE["valid_trace"])) == FIXTURE["valid_trace"]
    padded = raw + " " * (MAX_BOOTSTRAP_BYTES - len(raw.encode()))
    assert decode_scratchpad_bootstrap(padded) == FIXTURE["valid"]
    for invalid in (padded + " ", b"\xff"):
        with pytest.raises(NativeScratchPadError):
            decode_scratchpad_bootstrap(invalid)
    zero = deepcopy(FIXTURE["valid"])
    zero["principal"]["account"] = "A" * 56
    assert decode_scratchpad_bootstrap(json.dumps(zero)) == zero


@pytest.mark.parametrize(
    "case", FIXTURE["malformed"] + FIXTURE["sdk_refusals"], ids=lambda case: case["name"]
)
def test_shared_refusals(case: dict[str, str]) -> None:
    with pytest.raises(NativeScratchPadError):
        decode_scratchpad_bootstrap(case["json"])


def test_regular_bounded_file(tmp_path: Path) -> None:
    file = bootstrap(tmp_path)
    assert read_scratchpad_bootstrap_file(file) == FIXTURE["valid_trace"]
    with pytest.raises(NativeScratchPadError, match="regular file"):
        read_scratchpad_bootstrap_file(tmp_path)
    link = tmp_path / "link"
    link.symlink_to(file)
    with pytest.raises(NativeScratchPadError):
        read_scratchpad_bootstrap_file(link)
    file.write_text(" " * (MAX_BOOTSTRAP_BYTES + 1))
    with pytest.raises(NativeScratchPadError, match="byte bound"):
        read_scratchpad_bootstrap_file(file)


async def test_derived_volume_and_durable_request_before_create(tmp_path: Path) -> None:
    file, directory, service = bootstrap(tmp_path), tmp_path / "work", Service()
    pad = await native_scratchpad_from_env(
        {"SCRATCHPAD_BOOTSTRAP_FILE": str(file), "SCRATCHPAD_DIR": str(directory)},
        nc=cast(NATS, service),
        creator=CREATOR,
    )
    assert pad is not None
    await pad.close()
    assert [verb for verb, _ in service.calls] == ["info"]
    state = saved(directory)
    assert state["creation"] == FIXTURE["valid_trace"]["creation"]
    assert state["admission"] == FIXTURE["valid_trace"]["admission"]
    resumed = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    try:
        assert (await resumed.describe())["volume"]["target"] == service.view["target"]
    finally:
        await resumed.close()
    request = next(body for verb, body in service.calls if verb == "volume.create")
    assert request == {
        "volume": "Replies",
        "action": FIXTURE["valid_trace"]["creation"],
        "admission": FIXTURE["valid_trace"]["admission"],
    }


async def test_principal_and_custom_volume_refuse_before_workspace(tmp_path: Path) -> None:
    file, directory, service = bootstrap(tmp_path), tmp_path / "work", Service()

    # The public NATS response supplies a different, valid account principal.
    class OtherOwner(Service):
        async def request(self, *args: Any, **kwargs: Any) -> Any:
            return message(
                {
                    "principal": {**FIXTURE["valid"]["principal"], "account": "A" * 56},
                    "scopes": [],
                    "limits": p.PUBLIC_LIMITS,
                }
            )

    with pytest.raises(NativeScratchPadError, match="principal"):
        await native_scratchpad(
            nc=cast(NATS, OtherOwner()), dir=directory, creator=CREATOR, bootstrap_file=file
        )
    assert not directory.exists()
    with pytest.raises(NativeScratchPadError, match="configured volume"):
        await native_scratchpad(
            nc=cast(NATS, service),
            dir=directory,
            creator=CREATOR,
            bootstrap_file=file,
            volume="Custom",
        )
    assert not directory.exists()
    assert all(verb == "info" for verb, _ in service.calls)


async def test_first_import_requires_exact_discovered_admission(tmp_path: Path) -> None:
    file, directory, service = bootstrap(tmp_path), tmp_path / "work", Service()
    assert service.scope is not None
    service.scope = {
        **service.scope,
        "admission": {**FIXTURE["valid"]["admission"], "generation": 8},
    }
    with pytest.raises(NativeScratchPadError) as error:
        await native_scratchpad(
            nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
        )
    assert error.value.code == "fenced" and saved(directory) is None
    assert [verb for verb, _ in service.calls] == ["info"]


async def test_matching_import_and_trace_mismatch_preserve_sqlite_bytes(tmp_path: Path) -> None:
    file, directory, service = bootstrap(tmp_path), tmp_path / "work", Service()
    pad = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    await pad.close()
    store = WorkspaceStore.open(directory)
    state = store.load()
    store.save(
        {
            **state,
            "target": service.view["target"],
            "writer": {"slot": 0, "generation": 2},
            "next": 8,
            "pending": {"kind": "reset", "writer": {"slot": 0, "generation": 2}},
        }
    )
    store.close()
    before = (directory / "scratchpad.sqlite").read_bytes()
    same = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    await same.close()
    assert (directory / "scratchpad.sqlite").read_bytes() == before
    changed = deepcopy(FIXTURE["valid_trace"])
    changed["creation"]["trace"]["tool_call_id"] = "different"
    file.write_text(json.dumps(changed))
    with pytest.raises(NativeScratchPadError, match="creation request"):
        await native_scratchpad(
            nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
        )
    assert (directory / "scratchpad.sqlite").read_bytes() == before
    assert all(verb == "info" for verb, _ in service.calls)


async def test_unknown_create_replays_without_discovery_or_admin(tmp_path: Path) -> None:
    file, directory, service = bootstrap(tmp_path), tmp_path / "work", Service()
    service.drop = "volume.create"
    pad = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    with pytest.raises(NativeScratchPadError) as error:
        await pad.describe()
    assert error.value.unknown
    await pad.close()
    service.scope = None
    resumed = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    try:
        assert (await resumed.describe())["volume"]["target"] == service.view["target"]
    finally:
        await resumed.close()
    attempts = [body for verb, body in service.calls if verb == "volume.create"]
    assert len(attempts) == 2 and attempts[0] == attempts[1]
    assert all(verb in {"info", "volume.create"} for verb, _ in service.calls)


async def test_disposal_cannot_be_reopened(tmp_path: Path) -> None:
    file, directory, service = bootstrap(tmp_path), tmp_path / "work", Service()
    pad = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    await pad.close()
    store = WorkspaceStore.open(directory)
    state = store.load()
    store.save(
        {
            **state,
            "target": service.view["target"],
            "disposal": {
                "target": service.view["target"],
                "slot": 0,
                "generation": 7,
                "operation_id": "release",
                "disposed": True,
                "capacity_returned": True,
            },
        }
    )
    store.close()
    before = (directory / "scratchpad.sqlite").read_bytes()
    with pytest.raises(NativeScratchPadError) as error:
        await native_scratchpad(
            nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
        )
    assert error.value.code == "fenced"
    assert (directory / "scratchpad.sqlite").read_bytes() == before
    assert all(verb == "info" for verb, _ in service.calls)


async def test_exists_never_adopts_a_target(tmp_path: Path) -> None:
    class ExistsService(Service):
        async def request(self, subject: str, *args: Any, **kwargs: Any) -> Any:
            if subject.endswith("volume.create"):
                self.calls.append(("volume.create", {}))
                return message(b"", {"code": "exists", "message": "different creation"})
            return await super().request(subject, *args, **kwargs)

    file, directory, service = bootstrap(tmp_path), tmp_path / "work", ExistsService()
    pad = await native_scratchpad(
        nc=cast(NATS, service), dir=directory, creator=CREATOR, bootstrap_file=file
    )
    try:
        with pytest.raises(NativeScratchPadError) as error:
            await pad.describe()
        assert error.value.code == "exists" and not error.value.unknown
    finally:
        await pad.close()
    assert "target" not in saved(directory)
    assert [verb for verb, _ in service.calls] == ["info", "volume.create"]
