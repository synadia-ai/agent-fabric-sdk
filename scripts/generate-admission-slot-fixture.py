#!/usr/bin/env python3
"""Generate public uint32 admission-slot vectors for both native clients."""
import hashlib
import json
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def constraints(node, parent=None):
    if isinstance(node, dict):
        named = {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}
        return {key: constraints(value, key) for key, value in node.items()
                if parent in named or key not in {"description", "$comment", "title"}}
    if isinstance(node, list):
        return [constraints(value) for value in node]
    return node


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def main():
    bootstrap = json.loads((ROOT / "test-fixtures/scratchpad/bootstrap-v1.json").read_text())
    reference = json.loads((ROOT / "test-fixtures/scratchpad/reference-v2.json").read_text())["reference"]
    admission = bootstrap["valid"]["admission"]
    target = reference["target"]
    head = {"generation": 1, "root": reference["root"]}
    command = {"creation_id": target["creation_id"], "writer": {"slot": 0, "generation": 1},
               "number": 1, "operation_id": "remove", "base": head, "root": reference["root"],
               "trace": {}, "retention": {"enabled": False, "slot": 0, "generation": 0, "until": 0},
               "remove_path": "/obsolete"}
    values = {
        "admission": admission,
        "lifetime": {"admission": admission, "phase": "active", "expires_at": 0,
                     "grace_until": 0, "max_lease_seconds": 0, "grace_seconds": 0,
                     "recovery_reads": True, "reserve_objects": 128, "reserve_bytes": 8388608},
        "removal_plan": {"target": target, "slot": 0, "generation": 7, "sequence": 42,
                         "command": command, "added_objects": 1, "added_bytes": 4},
        "release_plan": {"request": {"target": target, "operation_id": "release", "end_promises": True},
                         "incarnation": "ab" * 32, "slot": 0, "generation": 7, "sequence": 43,
                         "head": head, "effects": {"objects": 1, "bytes": 4, "retentions": 0,
                                                   "read_grants": 0, "access_slots": 1, "references": 0}},
        "release_result": {"target": target, "slot": 0, "generation": 7,
                           "operation_id": "release", "disposed": True, "capacity_returned": True},
    }
    cases = []
    for slot in (256, 1000, 10000, 100000, 2**32 - 1):
        selected = deepcopy(values)
        for name, value in selected.items():
            binding = value["admission"] if name == "lifetime" else value
            binding["slot"] = slot
        cases.append({"slot": slot, "values": selected,
                      "canonical_json": {name: encoded(value) for name, value in selected.items()}})
    fixture = {"source": "scratchpad-public-admission-slot-u32-v1", "valid": cases,
               "invalid": [{"name": name, "slot": slot} for name, slot in
                           [("negative", -1), ("overflow", 2**32), ("fractional", 0.5),
                            ("string", "256"), ("boolean", True), ("null", None)]]}
    (ROOT / "test-fixtures/scratchpad/admission-slots-v1.json").write_text(
        json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
    schema = json.loads((ROOT / "test-fixtures/schemas/scratchpad-bootstrap-v1.json").read_text())
    canonical = json.dumps(constraints(schema), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    print(f"ADMISSION_SLOT_FIXTURE valid={len(cases)} shapes={len(values)} invalid={len(fixture['invalid'])}")
    print(f"BOOTSTRAP_SCHEMA_CONSTRAINTS_SHA256={hashlib.sha256(canonical.encode()).hexdigest()}")


if __name__ == "__main__":
    main()
