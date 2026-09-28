#!/usr/bin/env python3
"""Prove that both real-service tests reject a missing durable grant intent.

Run each mutation in a fresh copy. Never modify the source checkout or use a
private NATS API. An expected assertion must fail; setup failures do not count.
Run the unchanged real-service suites separately before using this control.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    core = args.core_root.resolve()
    if not (core / "internal/volumeservice/native_client_control_test.go").is_file():
        parser.error("core checkout needs the native control fixture")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    shutil.copytree(root / "test-fixtures", output / "test-fixtures")
    mutations = [
        {
            "language": "typescript",
            "file": "src/scratchpad-native/client.ts",
            "before": (
                "  private change(pending: Pending): void {\n"
                "    this.save({ ...this.state, pending });\n  }"
            ),
            "after": (
                "  private change(pending: Pending): void {\n"
                '    if (pending.kind === "grant") {\n'
                "      this.state = { ...this.state, pending };\n"
                "      return;\n    }\n"
                "    this.save({ ...this.state, pending });\n  }"
            ),
            "command": [
                "node",
                str(root / "typescript/node_modules/vitest/vitest.mjs"),
                "run",
                "test/integration/scratchpad-native-controls.test.ts",
                "-t",
                "recovers an accepted grant",
                "--reporter=verbose",
            ],
        },
        {
            "language": "python",
            "file": "src/synadia_ai/agent_fabric/_scratchpad_native/client.py",
            "before": (
                "    def _change(self, pending: dict[str, Any]) -> None:\n"
                '        self._save({**self._state, "pending": pending})'
            ),
            "after": (
                "    def _change(self, pending: dict[str, Any]) -> None:\n"
                '        if pending["kind"] == "grant":\n'
                '            self._state = {**self._state, "pending": pending}\n'
                "            return\n"
                '        self._save({**self._state, "pending": pending})'
            ),
            "command": [
                str(root / "python/.venv/bin/python"),
                "-m",
                "pytest",
                "-s",
                "tests/test_scratchpad_native_controls.py",
                "-k",
                "accepted_control_recovery and grant",
            ],
        },
    ]
    records = []
    for mutation in mutations:
        language = mutation["language"]
        original = root / language / mutation["file"]
        before_hash = digest(original)
        work = output / language
        shutil.copytree(
            root / language,
            work,
            ignore=shutil.ignore_patterns(
                "node_modules",
                ".venv",
                "dist",
                "__pycache__",
                ".pytest_cache",
                ".mypy_cache",
                ".ruff_cache",
            ),
        )
        if language == "typescript":
            (work / "node_modules").symlink_to(
                root / language / "node_modules", target_is_directory=True
            )
        target = work / mutation["file"]
        source = target.read_text()
        if source.count(mutation["before"]) != 1:
            raise RuntimeError(f"{language}: mutation anchor must match exactly once")
        target.write_text(source.replace(mutation["before"], mutation["after"], 1))
        environment = {
            **os.environ,
            "SCRATCHPAD_CORE_ROOT": str(core),
            "PYTHONPATH": str(work / "src"),
        }
        run = subprocess.run(
            mutation["command"],
            cwd=work,
            env=environment,
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        log = run.stdout + run.stderr
        (output / f"{language}.log").write_text(log)
        expected = "reopened workspace retains its control"
        assertion = "AssertionError" in log
        rejected = run.returncode == 1 and expected in log and assertion
        if digest(original) != before_hash:
            raise RuntimeError("source checkout changed while checking its copy")
        records.append(
            {
                "language": language,
                "source_sha256": before_hash,
                "mutant_sha256": digest(target),
                "command": mutation["command"],
                "exit_code": run.returncode,
                "expected_assertion": expected,
                "rejected_at_expected_assertion": rejected,
            }
        )
        (output / "result.json").write_text(json.dumps({"controls": records}, indent=2) + "\n")
        print(json.dumps(records[-1]), flush=True)
        if not rejected:
            raise RuntimeError(
                f"{language}: missing expected rejection; inspect {output / (language + '.log')}"
            )
    if {record["language"] for record in records} != {"typescript", "python"}:
        raise RuntimeError("both language controls must run")


if __name__ == "__main__":
    main()
