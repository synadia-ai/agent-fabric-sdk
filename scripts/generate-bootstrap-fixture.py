#!/usr/bin/env python3
"""Regenerate public descriptor inputs shared by both SDK consumer suites."""
import json
from copy import deepcopy
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def main():
    valid = {
        "version": 1,
        "principal": {
            "account": "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
            "user": "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
        },
        "volume": "Replies",
        "admission": {"slot": 0, "generation": 7, "operation_id": "admit-7"},
        "creation": {"operation_id": "console-create-7", "trace": {}},
    }
    traced = deepcopy(valid)
    traced["creation"]["trace"] = {
        "thread_id": "1" * 32, "root_id": "2" * 32, "tool_call_id": "bootstrap <&> café"
    }
    valid_slots = []
    for slot in (256, 1000, 10000, 100000, 2**32 - 1):
        descriptor = deepcopy(traced)
        descriptor["admission"]["slot"] = slot
        valid_slots.append({"name": f"admission-slot-{slot}", "descriptor": descriptor})
    malformed = []
    for name, path, replacement in [
        ("unsupported-version", ("version",), 2),
        ("bad-account-checksum", ("principal", "account"), valid["principal"]["account"][:-1] + "T"),
        ("invalid-volume", ("volume",), "../Replies"),
        ("zero-generation", ("admission", "generation"), 0),
        ("slot-overflow", ("admission", "slot"), 2**32),
        ("negative-slot", ("admission", "slot"), -1),
        ("fractional-slot", ("admission", "slot"), 0.5),
        ("string-slot", ("admission", "slot"), "256"),
        ("boolean-slot", ("admission", "slot"), True),
        ("empty-operation", ("creation", "operation_id"), ""),
        ("partial-trace", ("creation", "trace"), {"thread_id": "1" * 32}),
    ]:
        changed = deepcopy(valid)
        target = changed
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = replacement
        malformed.append({"name": name, "json": encoded(changed)})
    for name, path in [("unknown-top-field", ()), ("unknown-principal-field", ("principal",)),
                       ("unknown-admission-field", ("admission",)),
                       ("unknown-creation-field", ("creation",)),
                       ("unknown-trace-field", ("creation", "trace"))]:
        changed = deepcopy(valid)
        target = changed
        for key in path:
            target = target[key]
        target["unexpected"] = True
        malformed.append({"name": name, "json": encoded(changed)})
    raw = encoded(valid)
    malformed.extend([
        {"name": "duplicate-version", "json": raw.replace('"version":1', '"version":1,"version":1')},
        {"name": "duplicate-principal", "json": raw.replace('"account":', '"user":"' + valid["principal"]["user"] + '","account":')},
        {"name": "duplicate-trace", "json": raw.replace('"trace":{}', '"trace":{"tool_call_id":"","tool_call_id":""}')},
    ])
    precision = deepcopy(valid)
    precision["admission"]["generation"] = 2**53
    fixture = {"source": "scratchpad-bootstrap-v1", "max_bytes": 4096,
               "valid": valid, "valid_json": raw, "valid_trace": traced,
               "valid_slots": valid_slots,
               "malformed": malformed,
               "sdk_refusals": [{"name": "unsupported-counter-precision", "json": encoded(precision)}]}
    path = ROOT / "test-fixtures/scratchpad/bootstrap-v1.json"
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n")
    print(f"BOOTSTRAP_FIXTURE valid={2 + len(valid_slots)} malformed={len(malformed)} sdk_refusals=1 max_bytes=4096")


if __name__ == "__main__":
    main()
