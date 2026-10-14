"""Public lifecycle values preserve uint32 admission slots across wire decoding."""

from __future__ import annotations

import json
from collections.abc import Callable
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from synadia_ai.agent_fabric._scratchpad_native import protocol as p
from synadia_ai.agent_fabric._scratchpad_native.errors import NativeScratchPadError

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "test-fixtures/scratchpad/admission-slots-v1.json").read_text()
)
VALIDATORS: dict[str, Callable[[object], p.Wire]] = {
    "admission": p.validate_admission_binding,
    "lifetime": p.validate_lifetime_view,
    "removal_plan": p.validate_removal_plan,
    "release_plan": p.validate_volume_release_plan,
    "release_result": p.validate_volume_release_result,
}


@pytest.mark.parametrize("shape", VALIDATORS)
@pytest.mark.parametrize("case", FIXTURE["valid"], ids=lambda case: str(case["slot"]))
def test_uint32_slots_preserve_exact_wire(shape: str, case: dict[str, Any]) -> None:
    decoded = p.parse_strict_json(case["canonical_json"][shape], p.MAX_CONTROL_BYTES)
    assert VALIDATORS[shape](decoded) == case["values"][shape]
    assert p.go_json(decoded) == case["canonical_json"][shape]


@pytest.mark.parametrize("shape", VALIDATORS)
@pytest.mark.parametrize("case", FIXTURE["invalid"], ids=lambda case: case["name"])
def test_invalid_admission_slots_refuse(shape: str, case: dict[str, Any]) -> None:
    value = deepcopy(FIXTURE["valid"][0]["values"][shape])
    binding = value["admission"] if shape == "lifetime" else value
    binding["slot"] = case["slot"]
    with pytest.raises(NativeScratchPadError):
        VALIDATORS[shape](p.parse_strict_json(json.dumps(value), p.MAX_CONTROL_BYTES))


def test_small_handles_keep_their_bounds() -> None:
    for validate, maximum in (
        (p.validate_writer, p.WRITER_SLOTS - 1),
        (p.validate_retention_handle, p.RETENTION_SLOTS - 1),
        (p.validate_grant_handle, p.GRANT_SLOTS - 1),
    ):
        assert validate({"slot": maximum, "generation": 1})["slot"] == maximum
        for slot in (maximum + 1, 256):
            with pytest.raises(NativeScratchPadError):
                validate({"slot": slot, "generation": 1})
