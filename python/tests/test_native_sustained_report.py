"""Behavioral controls for the finite sustained qualification checker."""

import copy
import importlib.util
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/native-sustained.py"
SPEC = importlib.util.spec_from_file_location("native_sustained_report", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


def watch_segment(language, begin, end, generation=0):
    oracle = checker.canary_expected(language)
    # Each process may have a different monotonic epoch. Only durations agree.
    origin = 700_000 + generation * 400_000
    samples = [
        {
            **oracle,
            "outcome": "ok",
            "monotonicStartMs": origin + index,
            "monotonicEndMs": origin + index + 1,
            "durationMs": 1,
            "maintenanceAtStart": False,
            "maintenanceAtEnd": False,
        }
        for index in range(0, end - begin, 1000)
    ]
    return {
        "samples": samples,
        "generation": generation,
        "monotonicStartMs": origin,
        "monotonicEndMs": origin + end - begin,
        "controllerMonotonicStartMs": begin,
        "controllerMonotonicEndMs": end,
    }


@pytest.fixture(scope="module")
def valid_report():
    records = []
    faults = []
    for cycle in range(12):
        row = {
            "cycle": cycle,
            "durationMs": 100,
            "startLagMs": 1,
            "languages": {},
            "storage": {
                "native_stream": {"bytes": 90_000_000},
                "native_store": {
                    "allocated_bytes": 100_000_000,
                    "logical_bytes": 95_000_000,
                    "vanished_entries": 0,
                },
                "physical_store": {"vanished_entries": 0},
            },
        }
        for language in checker.LANGUAGES:
            oracle = checker.expected(language, cycle, checker.SIZES[cycle % 3])
            receipt = {
                "command": {"number": cycle + 2, "operation_id": f"sustained-{language}-{cycle}"}
            }
            publication = {
                "publication": {"receipt": receipt, "reference": "unused-by-report-check"},
                "inputBytes": oracle["bytes"],
                "sha256": oracle["sha256"],
                "publishMs": 10,
                "samples": 3,
                "maxGapMs": 5,
            }
            if (cycle, language) in ((4, "typescript"), (8, "python")):
                publication["error"] = {"code": "unknown", "unknown": True}
                pause = cycle * 10_000
                faults.append(
                    {
                        "cycle": cycle,
                        "language": language,
                        "exitCode": -9,
                        "reopenedPending": "publish",
                        "capturedReceipt": receipt,
                        "recoveredReceipt": copy.deepcopy(receipt),
                        "pauseMs": 1000,
                        "pauseStartElapsedMs": pause,
                        "pauseEndElapsedMs": pause + 1000,
                    }
                )
            volume = {
                "closed": False,
                "bytes": 41_000_000,
                "objects": 100,
                "retentions": [{"pin": {"root": "retained"}} for _ in range(min(cycle + 2, 4))],
            }
            row["languages"][language] = {
                "publish": publication,
                "read": {**oracle, "durationMs": 3},
                "afterCollectionRead": checker.canary_expected(language),
                "inspect": {
                    "description": {"volume": volume},
                    "databaseBytes": 40_000_000,
                    "journalBytes": 40_000_000,
                    "walBytes": 0,
                    "maxRssBytes": 100_000_000,
                },
                "collection": {"before": {"bytes": 50_000_000}, "after": {"bytes": 41_000_000}},
            }
        records.append(row)
    segments = {
        reader: [
            watch_segment(checker.other(reader), begin, end, index)
            for index, (begin, end) in enumerate(((0, 40_000), (41_000, 80_000), (81_000, 120_000)))
        ]
        for reader in checker.LANGUAGES
    }
    return {
        "complete": True,
        "mode": "rehearsal",
        "cycles": 12,
        "cadenceSeconds": 10,
        "elapsedSeconds": 120,
        "startedMonotonicMs": 0,
        "records": records,
        "faults": faults,
        "fixture": {"dropped_replies": 2, "accepted_receipts": 2, "service_restarts": 2},
        "watchSegments": segments,
        "watch": {
            reader: [sample for segment in parts for sample in segment["samples"]]
            for reader, parts in segments.items()
        },
        "finalReads": {name: checker.canary_expected(name) for name in checker.LANGUAGES},
    }


def test_complete_report_counts_actual_windows(valid_report):
    summary = checker.summarize(valid_report)
    assert summary["publications"] == 24
    assert summary["verifiedBytes"] == 8 * sum(checker.SIZES)
    assert summary["languages"]["typescript"]["worstCanaryCoverageGapMs"] == 1000
    assert len(summary["languages"]["python"]["quarters"]) == 4


def test_canary_ok_with_wrong_bytes_is_rejected():
    segment = watch_segment("typescript", 0, 3000)
    segment["samples"][1]["bytes"] = 0
    with pytest.raises(RuntimeError, match="size or SHA-256"):
        checker.check_watch(segment, checker.canary_expected("typescript"))


def test_ten_second_stall_and_catchup_cannot_replace_coverage():
    segment = watch_segment("typescript", 0, 20_000)
    # Preserve sample count: a burst after the stall must still fail.
    for index in range(1, 11):
        segment["samples"][index]["monotonicStartMs"] = 710_000 + index
        segment["samples"][index]["monotonicEndMs"] = 710_001 + index
    with pytest.raises(RuntimeError, match="coverage gap"):
        checker.check_watch(segment, checker.canary_expected("typescript"))


@pytest.mark.parametrize("edge", ["first", "last"])
def test_missing_boundary_reads_are_rejected(edge):
    segment = watch_segment("python", 0, 10_000)
    segment["samples"] = segment["samples"][5:] if edge == "first" else segment["samples"][:5]
    with pytest.raises(RuntimeError, match="coverage gap"):
        checker.check_watch(segment, checker.canary_expected("python"))


def test_missing_cycle_is_rejected(valid_report):
    result = copy.deepcopy(valid_report)
    result["records"].pop(5)
    with pytest.raises(RuntimeError, match="cycle coverage"):
        checker.summarize(result)


def test_different_recovered_receipt_is_rejected(valid_report):
    result = copy.deepcopy(valid_report)
    result["faults"][0]["recoveredReceipt"]["command"]["number"] += 1
    with pytest.raises(RuntimeError, match="exact accepted receipt"):
        checker.summarize(result)


def test_middle_storage_spike_is_rejected(valid_report):
    result = copy.deepcopy(valid_report)
    result["records"][5]["storage"]["native_stream"]["bytes"] = 113 * checker.MIB
    with pytest.raises(RuntimeError, match="native stream exceeded"):
        checker.summarize(result)


def test_retained_journal_counts_toward_workspace_limit(valid_report):
    result = copy.deepcopy(valid_report)
    result["records"][5]["languages"]["python"]["inspect"]["journalBytes"] = 80 * checker.MIB
    with pytest.raises(RuntimeError, match="database and journals"):
        checker.summarize(result)


def test_qualification_requires_matching_controls():
    with pytest.raises(RuntimeError, match="requires --controls-evidence"):
        checker.controls_proof(None, {})


def test_incomplete_file_walk_is_not_an_allocation_bound(valid_report):
    result = copy.deepcopy(valid_report)
    result["records"][5]["storage"]["native_store"]["vanished_entries"] = 1
    with pytest.raises(RuntimeError, match="lost entries"):
        checker.summarize(result)
