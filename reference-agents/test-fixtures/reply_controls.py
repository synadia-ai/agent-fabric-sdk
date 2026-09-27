#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.12.*"
# dependencies = []
# ///
"""Prove bounded-reply checks reject three real regressions in isolated source copies."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
CONTROLS = {
    "utf8-boundary": {
        "ts": ("reference-agents/typescript/src/reply.ts", 'Buffer.byteLength(text, "utf8")', "text.length", "test/reply.test.ts", "multibyte-over"),
        "py": ("reference-agents/python/fabric_agent/reply.py", 'len(text.encode("utf-8"))', "len(text)", "tests/test_reply.py", "multibyte-over"),
    },
    "grant-required": {
        "ts": ("reference-agents/typescript/src/agent.ts", "if (await references.grantCaller(ref, response.sender))", "if (true)", "test/reply-agent.test.ts", "large-unsigned"),
        "py": ("reference-agents/python/fabric_agent/agent.py", "if await references.grant_caller(ref, stream.sender):", "if True:", "tests/test_reply_agent.py", "large-unsigned"),
    },
    "bounded-history": {
        "ts": ("reference-agents/typescript/src/agent.ts", 'content: delivery.history', 'content: result.reply', "test/reply-agent.test.ts", "ascii-over"),
        "py": ("reference-agents/python/fabric_agent/agent.py", '"content": history_reply', '"content": result.reply', "tests/test_reply_agent.py", "ascii-over"),
    },
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--language", choices=("ts", "py", "all"), default="all")
    args = parser.parse_args()
    out = args.evidence.resolve()
    if ROOT == out or ROOT in out.parents:
        parser.error("evidence must be outside the source checkout")
    out.mkdir(mode=0o700)
    results = []
    for language in (("ts", "py") if args.language == "all" else (args.language,)):
        for control, variants in CONTROLS.items():
            path, old, new, test, selected = variants[language]
            work = out / (language + "-" + control)
            work.mkdir(mode=0o700)
            for relative in ("reference-agents/typescript/src", "reference-agents/typescript/test", "reference-agents/python/fabric_agent", "reference-agents/python/tests", "reference-agents/test-fixtures", "test-fixtures/scratchpad"):
                shutil.copytree(ROOT / relative, work / relative, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            for relative in ("reference-agents/typescript/package.json", "reference-agents/typescript/tsconfig.json", "reference-agents/typescript/vitest.config.ts", "reference-agents/python/pyproject.toml"):
                shutil.copy2(ROOT / relative, work / relative)
            (work / "reference-agents/typescript/node_modules").symlink_to(ROOT / "reference-agents/typescript/node_modules", target_is_directory=True)
            target = work / path
            source = target.read_text()
            if source.count(old) != 1:
                raise RuntimeError(f"{control} anchor count differs in {path}")
            target.write_text(source.replace(old, new))
            env = dict(os.environ)
            if language == "ts":
                command = ["node", str(ROOT / "reference-agents/typescript/node_modules/vitest/vitest.mjs"), "run", test, "-t", selected]
                cwd = work / "reference-agents/typescript"
                failure_marker = "AssertionError"
            else:
                # This interpreter belongs to the uv-managed project environment.
                command = [str(ROOT / "reference-agents/python/.venv/bin/python"), "-m", "pytest", test, "-q", "-k", selected]
                cwd = work / "reference-agents/python"
                env["PYTHONPATH"] = str(cwd) + os.pathsep + env.get("PYTHONPATH", "")
                failure_marker = "AssertionError"
            started = time.monotonic()
            with (work / "output.log").open("x") as log:
                result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=90)
            output = (work / "output.log").read_text()
            caught = result.returncode != 0 and failure_marker in output and "1 failed" in output
            record = dict(language=language, control=control, caught=caught, exit=result.returncode,
                          seconds=time.monotonic() - started, command=command)
            (work / "result.json").write_text(json.dumps(record, indent=2) + "\n")
            results.append(record)
            if not caught:
                raise RuntimeError(f"{language} {control} did not produce the expected behavioral failure; inspect {work}")
    (out / "result.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps({"controls_caught": len(results), "languages": sorted({r["language"] for r in results})}))


if __name__ == "__main__":
    main()
