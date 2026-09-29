#!/usr/bin/env python3
"""Record the exact source files consumed by the Linux qualification image.

Run on the host before building, then inside the image with --expected. This
checks file names and bytes, including deleted files; a commit label alone does
not identify a dirty checkout. Dependency lockfiles and image IDs are separate
inputs. Generated workspaces, credentials, caches and host environments are not
source inputs and are never traversed here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

IGNORED = {"node_modules", "dist", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache"}
INPUTS = {
    "sdk": [
        "typescript/src",
        "typescript/test",
        "typescript/scripts",
        "python/src",
        "python/tests",
        "scripts",
        "test-fixtures",
        "typescript/package.json",
        "typescript/package-lock.json",
        "typescript/tsconfig.json",
        "typescript/tsconfig.build.json",
        "typescript/tsup.config.ts",
        "typescript/vitest.config.ts",
        "python/pyproject.toml",
        "python/uv.lock",
        "python/README.md",
        "python/THIRD_PARTY_NOTICES",
    ],
    "core": ["api", "client", "codec", "naming", "internal", "third_party", "go.mod", "go.sum"],
    "protocol": [
        f"{package}/{language}/{leaf}"
        for package in ("client-sdk", "agent-sdk")
        for language, leaves in (
            (
                "typescript",
                (
                    "src",
                    "package.json",
                    "bun.lock",
                    "tsconfig.json",
                    "tsconfig.build.json",
                    "tsup.config.ts",
                ),
            ),
            ("python", ("src", "pyproject.toml", "uv.lock", "README.md")),
        )
        for leaf in leaves
    ],
}


def files(root: Path, inputs: list[str]) -> dict[str, str]:
    result = {}
    for source in inputs:
        selected = root / source
        if selected.is_file():
            paths = [selected]
        else:
            if not selected.is_dir():
                raise RuntimeError(f"missing source input: {selected}")
            paths = []
            for directory, folders, names in os.walk(selected):
                folders[:] = [name for name in folders if name not in IGNORED]
                paths.extend(Path(directory) / name for name in names if not name.startswith("."))
        for path in paths:
            result[str(path.relative_to(root))] = hashlib.sha256(path.read_bytes()).hexdigest()
    if not result:
        raise RuntimeError(f"no source files below {root}")
    return dict(sorted(result.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in INPUTS:
        parser.add_argument(f"--{name}-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected", type=Path)
    args = parser.parse_args()
    sources = {
        name: files(getattr(args, f"{name}_root").resolve(), paths)
        for name, paths in INPUTS.items()
    }
    summary = {
        "files": {name: len(paths) for name, paths in sources.items()},
        "sha256": hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest(),
    }
    with args.output.open("x") as output:
        json.dump({"summary": summary, "sources": sources}, output, indent=2)
        output.write("\n")
    if args.expected and json.loads(args.expected.read_text())["sources"] != sources:
        raise RuntimeError("image source paths or bytes differ from the expected checkout manifest")
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
