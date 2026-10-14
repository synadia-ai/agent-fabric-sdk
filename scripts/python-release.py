#!/usr/bin/env python3
"""Build, inspect and install-test the exact Python publication artifacts."""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
import re
import subprocess
import tarfile
import tempfile
import zipfile
from email.parser import BytesParser
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[1]
NAME = "synadia-ai-agent-fabric"
DEPENDENCIES = {"synadia-ai-agents": "0.8.1", "synadia-ai-agent-service": "0.5.0"}
CUTOFF = "2026-10-07T00:00:00Z"


def run(command: list[str], **kwargs: object) -> None:
    subprocess.run(command, check=True, **kwargs)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition: object, message: str) -> None:
    if not condition:
        raise ValueError(message)


def public_bytes(data: bytes, name: str) -> None:
    for value in (b"/Users/", b"/home/"):
        require(value not in data, f"local build path in {name}")
    public_repositories = {b"synadia-ai/agent-fabric-sdk", b"synadia-ai/synadia-agents"}
    for repository in re.findall(rb"github\.com[:/](synadia-ai/[A-Za-z0-9_.-]+)", data):
        require(
            repository in public_repositories,
            f"unapproved repository reference in {name}",
        )


def inspect(directory: Path, version: str) -> list[Path]:
    wheels = list(directory.glob("*.whl"))
    sdists = list(directory.glob("*.tar.gz"))
    require(len(wheels) == len(sdists) == 1, "expected one wheel and one sdist")
    wheel, sdist = wheels[0], sdists[0]
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "duplicate wheel members")
        metadata = [p for p in names if p.endswith(".dist-info/METADATA")]
        require(len(metadata) == 1, "missing or duplicate wheel metadata")
        values = BytesParser().parsebytes(archive.read(metadata[0]))
        require(
            values["Name"] == NAME and values["Version"] == version,
            "wheel name/version differs",
        )
        require(any("LICENSE" in p.upper() for p in names), "wheel license missing")
        require(
            "synadia_ai/agent_fabric/THIRD_PARTY_NOTICES" in names,
            "wheel notices missing",
        )
        requirements = values.get_all("Requires-Dist", [])
        for name, value in DEPENDENCIES.items():
            require(
                any(r.replace(" ", "") == f"{name}=={value}" for r in requirements),
                f"missing exact dependency {name}",
            )
        for name in names:
            require(
                not name.startswith("/") and ".." not in Path(name).parts,
                "unsafe wheel member",
            )
            public_bytes(archive.read(name), name)
    with tarfile.open(sdist) as archive:
        members = archive.getmembers()
        roots = {Path(m.name).parts[0] for m in members}
        require(len(roots) == 1, "sdist must have one root")
        require(
            len({m.name for m in members}) == len(members), "duplicate sdist members"
        )
        files = {}
        for member in members:
            require(
                not member.name.startswith("/") and ".." not in Path(member.name).parts,
                "unsafe sdist member",
            )
            require(member.isfile() or member.isdir(), "non-regular sdist member")
            if member.isfile():
                stream = archive.extractfile(member)
                require(stream is not None, "unreadable sdist member")
                data = stream.read()
                public_bytes(data, member.name)
                files[Path(member.name).relative_to(next(iter(roots))).as_posix()] = (
                    data
                )
        require(
            "LICENSE" in files and "THIRD_PARTY_NOTICES" in files,
            "sdist license/notices missing",
        )
        project = tomllib.loads(files["pyproject.toml"].decode())
        require(
            project["project"]["name"] == NAME
            and project["project"]["version"] == version,
            "sdist name/version differs",
        )
        require(
            "sources" not in project.get("tool", {}).get("uv", {}),
            "sdist has local source overrides",
        )
        for name, value in DEPENDENCIES.items():
            require(
                f"{name}=={value}" in project["project"]["dependencies"],
                "sdist dependency differs",
            )
    return [wheel, sdist]


def stage_project(text: str) -> str:
    lines, section = [], ""
    for line in text.splitlines(keepends=True):
        heading = re.match(r"^\[([^]]+)\]\s*$", line)
        if heading:
            section = heading.group(1)
        if section == "tool.uv.sources":
            continue
        if section == "project":
            for name, version in DEPENDENCIES.items():
                line = re.sub(
                    rf'"{re.escape(name)}[^";]*"', f'"{name}=={version}"', line
                )
        if section == "build-system" and line.startswith("requires ="):
            line = 'requires = ["hatchling==1.32.0"]\n'
        lines.append(line)
    result = "".join(lines)
    require(
        "sources" not in tomllib.loads(result).get("tool", {}).get("uv", {}),
        "source override remained",
    )
    return result


def clean_uv_output(directory: Path) -> None:
    ignore = directory / ".gitignore"
    if ignore.exists():
        require(
            ignore.is_file() and not ignore.is_symlink(),
            "unexpected generated ignore file",
        )
        require(ignore.read_bytes() == b"*", "unexpected generated ignore contents")
        ignore.unlink()


def build(directory: Path, version: str) -> None:
    require(not directory.exists(), "artifact output already exists")
    require(
        not directory.is_relative_to(ROOT),
        "artifact output must be outside the checkout",
    )
    require(
        not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip(),
        "release source must be clean and committed",
    )
    directory.mkdir(parents=True)
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    epoch = subprocess.check_output(
        ["git", "show", "-s", "--format=%ct", "HEAD"], cwd=ROOT, text=True
    ).strip()
    env = dict(os.environ, UV_EXCLUDE_NEWER=CUTOFF, SOURCE_DATE_EPOCH=epoch)
    with tempfile.TemporaryDirectory(prefix="fabric-python-release-") as temporary:
        stage = Path(temporary)
        archive = stage / "source.tar"
        with archive.open("wb") as output:
            run(["git", "archive", "HEAD", "python"], cwd=ROOT, stdout=output)
        with tarfile.open(archive) as source:
            source.extractall(stage, filter="data")
        project = stage / "python/pyproject.toml"
        require(
            tomllib.loads(project.read_text())["project"]["version"] == version,
            "tag and source version differ",
        )
        project.write_text(stage_project(project.read_text()))
        run(
            [
                "uv",
                "build",
                "--sdist",
                "--out-dir",
                str(directory),
                str(stage / "python"),
            ],
            env=env,
        )
        (sdist,) = directory.glob("*.tar.gz")
        unpack = stage / "unpack"
        unpack.mkdir()
        with tarfile.open(sdist) as source:
            source.extractall(unpack, filter="data")
        (project_root,) = unpack.iterdir()
        run(
            ["uv", "build", "--wheel", "--out-dir", str(directory), str(project_root)],
            env=env,
        )
    clean_uv_output(directory)
    artifacts = inspect(directory, version)
    record = {
        "schema": 1,
        "name": NAME,
        "version": version,
        "source_commit": commit,
        "external_cutoff": CUTOFF,
        "dependencies": DEPENDENCIES,
        "artifacts": {p.name: sha256(p) for p in artifacts},
    }
    (directory / "artifacts.json").write_text(json.dumps(record, indent=2) + "\n")
    print(f"Built and inspected {len(artifacts)} distributions from {commit}")


def verify(directory: Path, version: str, install: bool) -> None:
    record = json.loads((directory / "artifacts.json").read_text())
    require(
        record["schema"] == 1
        and record["name"] == NAME
        and record["version"] == version,
        "artifact record differs",
    )
    require(
        record["external_cutoff"] == CUTOFF and record["dependencies"] == DEPENDENCIES,
        "release policy differs",
    )
    require(
        re.fullmatch(r"[0-9a-f]{40}", record["source_commit"]),
        "invalid source revision",
    )
    if expected_source := os.environ.get("GITHUB_SHA"):
        require(
            record["source_commit"] == expected_source,
            "artifact source differs from the workflow revision",
        )
    require(len(record["artifacts"]) == 2, "artifact count differs")
    for name, digest in record["artifacts"].items():
        require(
            Path(name).name == name and not (directory / name).is_symlink(),
            "unsafe artifact filename",
        )
        require(sha256(directory / name) == digest, "artifact digest differs")
    require(
        {p.name for p in directory.iterdir()}
        == set(record["artifacts"]) | {"artifacts.json"},
        "unexpected artifact files",
    )
    artifacts = inspect(directory, version)
    count = 0
    if install:
        env = dict(os.environ, UV_EXCLUDE_NEWER=CUTOFF)
        exceptions = [
            arg
            for name in DEPENDENCIES
            # The pinned Linux uv rejects the maximum year-9999 timestamp.
            for arg in ("--exclude-newer-package", f"{name}=2100-01-01T00:00:00Z")
        ]
        for py in ("3.11", "3.12", "3.13"):
            for artifact in artifacts:
                with tempfile.TemporaryDirectory(
                    prefix="fabric-python-install-"
                ) as temporary:
                    venv = Path(temporary) / ".venv"
                    run(["uv", "venv", "--python", py, str(venv)], env=env)
                    python = venv / "bin/python"
                    run(
                        [
                            "uv",
                            "pip",
                            "install",
                            "--python",
                            str(python),
                            *exceptions,
                            str(artifact),
                        ],
                        env=env,
                    )
                    run(
                        [
                            str(python),
                            "-I",
                            str(Path(__file__).resolve()),
                            "smoke",
                            "--version",
                            version,
                        ],
                        cwd=temporary,
                    )
                    count += 1
    print(
        f"Verified {len(artifacts)} artifact digests; completed {count} clean installs"
    )


def smoke(version: str) -> None:
    for name, expected in {NAME: version, **DEPENDENCIES}.items():
        require(
            importlib.metadata.version(name) == expected,
            f"installed version differs for {name}",
        )
    for module in (
        "synadia_ai.agents",
        "synadia_ai.agent_service",
        "synadia_ai.agent_fabric",
        "synadia_ai.agent_fabric.scratchpad_native",
    ):
        importlib.import_module(module)
    print("Imported all three installed SDKs and the native client")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "verify", "smoke"))
    parser.add_argument("--version", required=True)
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--install", action="store_true")
    args = parser.parse_args()
    require(re.fullmatch(r"\d+\.\d+\.\d+", args.version), "invalid package version")
    if args.command == "smoke":
        smoke(args.version)
    else:
        require(args.artifacts is not None, "artifact directory required")
        directory = args.artifacts.resolve()
        if args.command == "build":
            build(directory, args.version)
        else:
            verify(directory, args.version, args.install)


if __name__ == "__main__":
    main()
