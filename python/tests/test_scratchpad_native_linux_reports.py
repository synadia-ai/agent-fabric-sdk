"""The Linux qualification must reject skipped, empty, and failed reports."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "native_linux_qualification",
    Path(__file__).resolve().parents[2] / "scripts/native-linux/run.py",
)
assert SPEC and SPEC.loader
qualification = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(qualification)


@pytest.mark.parametrize("language", ["typescript", "python"])
@pytest.mark.parametrize("defect", ["none", "empty", "skip", "failure"])
def test_native_report_counts(tmp_path: Path, language: str, defect: str) -> None:
    report = tmp_path / "report"
    if language == "typescript":
        count = qualification.MIN_TYPESCRIPT_CASES
        cases = [{"status": "passed"} for _ in range(count)]
        if defect == "empty":
            cases = []
        elif defect != "none":
            cases[0]["status"] = "pending" if defect == "skip" else "failed"
        report.write_text(
            json.dumps({"success": True, "testResults": [{"assertionResults": cases}]})
        )
        read = qualification.passed_typescript
    else:
        count = qualification.MIN_PYTHON_CASES
        xml_cases = ["<testcase/>" for _ in range(count)]
        if defect == "empty":
            xml_cases = []
        elif defect != "none":
            marker = "skipped" if defect == "skip" else "failure"
            xml_cases[0] = f"<testcase><{marker}/></testcase>"
        report.write_text(
            "<testsuites><testsuite>" + "".join(xml_cases) + "</testsuite></testsuites>"
        )
        read = qualification.passed_python
    if defect == "none":
        assert read(report) == count
    else:
        with pytest.raises(RuntimeError, match="failed, skipped cases, or ran fewer"):
            read(report)


def test_fixture_credentials_stay_outside_evidence(tmp_path: Path) -> None:
    output, scratch = tmp_path / "evidence", tmp_path / "work"
    assert qualification.evidence_paths(output, scratch) == (output, scratch)
    for unsafe in (output, output / "work"):
        with pytest.raises(RuntimeError, match="outside exported evidence"):
            qualification.evidence_paths(output, unsafe)
