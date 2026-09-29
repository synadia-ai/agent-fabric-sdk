#!/usr/bin/env python3
"""Run native client conformance and a finite spool window on Linux local storage.

The Docker recipe keeps both language runtimes in one environment. Mount a
Docker volume at /qualification; do not bind a Mac directory there. Credentials
and other fixture scratch files stay in work/, outside the exported evidence.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import sqlite3
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIN_TYPESCRIPT_CASES = 16
MIN_PYTHON_CASES = 18
MIN_SAMPLES = 2


def run(command: list[str], cwd: Path, log: Path, timeout: int) -> None:
    print(json.dumps({"command": command, "cwd": str(cwd), "log": str(log)}), flush=True)
    with log.open("x") as output:
        result = subprocess.run(
            command,
            cwd=cwd,
            stdout=output,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
    if result.returncode:
        raise RuntimeError(f"exit {result.returncode}; inspect {log}")


def passed_typescript(path: Path) -> int:
    result = json.loads(path.read_text())
    cases = [case for suite in result["testResults"] for case in suite["assertionResults"]]
    if (
        not result["success"]
        or len(cases) < MIN_TYPESCRIPT_CASES
        or any(c["status"] != "passed" for c in cases)
    ):
        raise RuntimeError(
            "TypeScript native suite failed, skipped cases, or ran fewer "
            f"than {MIN_TYPESCRIPT_CASES} cases"
        )
    return len(cases)


def passed_python(path: Path) -> int:
    root = ET.parse(path).getroot()
    cases = list(root.iter("testcase"))
    if len(cases) < MIN_PYTHON_CASES or any(list(case) for case in cases):
        raise RuntimeError(
            f"Python native suite failed, skipped cases, or ran fewer than {MIN_PYTHON_CASES} cases"
        )
    return len(cases)


def evidence_paths(output: Path, scratch: Path) -> tuple[Path, Path]:
    output, scratch = output.resolve(), scratch.resolve()
    if scratch == output or scratch.is_relative_to(output):
        raise RuntimeError("TMPDIR must be outside exported evidence; fixtures create credentials")
    return output, scratch


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cycles", type=int, choices=range(1, 11), default=10)
    parser.add_argument("--artifact-mib", type=int, choices=(7, 32), default=7)
    parser.add_argument("--spool-only", action="store_true")
    args = parser.parse_args()
    if sys.platform != "linux" or sys.version_info < (3, 12):
        raise RuntimeError("this qualification requires Linux and Python 3.12+")
    output, scratch = evidence_paths(args.output, Path(os.environ["TMPDIR"]))
    output.mkdir(parents=True, exist_ok=False)
    scratch.mkdir(parents=True, exist_ok=True)
    environment = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "python_sqlite": sqlite3.sqlite_version,
        "node_runtime": json.loads(
            subprocess.check_output(
                ["node", str(ROOT / "scripts/native-linux/runtime.mjs")], text=True
            )
        ),
        "go": subprocess.check_output(["go", "version"], text=True).strip(),
        "filesystem": subprocess.check_output(
            ["stat", "-f", "-c", "%T", str(output)], text=True
        ).strip(),
        "scratch_filesystem": subprocess.check_output(
            ["stat", "-f", "-c", "%T", str(scratch)], text=True
        ).strip(),
        "output": str(output),
        "scratch": str(scratch),
        "output_device": output.stat().st_dev,
        "scratch_device": scratch.stat().st_dev,
        "mounts": Path("/proc/self/mountinfo").read_text().splitlines(),
        "spool_only": args.spool_only,
        "cpu_count": os.cpu_count(),
        "scope": "real service, file-backed R1, Linux local filesystem; not Live deployment",
    }
    (output / "environment.json").write_text(json.dumps(environment, indent=2) + "\n")
    run(
        [
            sys.executable,
            str(ROOT / "scripts/native-linux/sources.py"),
            "--sdk-root",
            str(ROOT),
            "--core-root",
            os.environ["SCRATCHPAD_CORE_ROOT"],
            "--protocol-root",
            str(ROOT.parent / "synadia-agents"),
            "--output",
            str(output / "sources.json"),
        ],
        ROOT,
        output / "sources.log",
        30,
    )
    counts: dict[str, int] = {}
    if not args.spool_only:
        ts_report = output / "typescript.json"
        run(
            [
                "node",
                "node_modules/vitest/vitest.mjs",
                "run",
                "test/integration/scratchpad-native",
                "--reporter=default",
                "--reporter=json",
                f"--outputFile.json={ts_report}",
            ],
            ROOT / "typescript",
            output / "typescript.log",
            600,
        )
        counts["typescript_cases"] = passed_typescript(ts_report)
        py_report = output / "python.xml"
        run(
            [
                sys.executable,
                "-m",
                "pytest",
                "-s",
                "tests/test_scratchpad_native.py",
                "tests/test_scratchpad_native_expiry.py",
                "tests/test_scratchpad_native_controls.py",
                f"--junitxml={py_report}",
            ],
            ROOT / "python",
            output / "python.log",
            600,
        )
        counts["python_cases"] = passed_python(py_report)
    run(
        [
            sys.executable,
            str(ROOT / "scripts/measure-native-spool.py"),
            "--core-root",
            os.environ["SCRATCHPAD_CORE_ROOT"],
            "--output",
            str(output / "spool"),
            "--cycles",
            str(args.cycles),
            "--artifact-mib",
            str(args.artifact_mib),
        ],
        ROOT / "python",
        output / "spool.log",
        600,
    )
    records = json.loads((output / "spool/result.json").read_text())["records"]
    if len(records) != 2 * args.cycles or any(
        r["verifiedBytes"] != r["artifactBytes"] or r["samples"] < MIN_SAMPLES for r in records
    ):
        raise RuntimeError("spool probe did not verify every publication or scheduling window")
    summary = {
        "complete": True,
        "environment": environment,
        "tests": counts,
        "completed_publications": len(records),
        "verified_bytes": sum(r["verifiedBytes"] for r in records),
        "worst_scheduling_gap_ms": max(r["maxSchedulingGapMs"] for r in records),
        "spool": {
            language: {
                "cycles": len(rows),
                "first_database_bytes": rows[0]["closedDatabaseBytes"],
                "last_database_bytes": rows[-1]["closedDatabaseBytes"],
                "max_database_bytes": max(r["closedDatabaseBytes"] for r in rows),
                "worst_scheduling_gap_ms": max(r["maxSchedulingGapMs"] for r in rows),
            }
            for language in ("typescript", "python")
            for rows in [[r for r in records if r["language"] == language]]
        },
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2), flush=True)


if __name__ == "__main__":
    main()
