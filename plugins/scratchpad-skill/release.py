#!/usr/bin/env python3
"""Pinned ScratchPad build, cache, notices, and standalone archive checks.

Uses Python 3.12+ and its standard library. Only selected binaries, public
dependency notices, and client instructions leave the private build directory.
"""

from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONFIG = HERE / "release.json"
CACHE = HERE / "bin"
WORK = HERE / ".work"
ARCHIVE_FILES = {"sp", "SOURCE", "BUILD.json", "SKILL.md", "README.md", "THIRD_PARTY_NOTICES"}
SUPPORTED = {"darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"}
MAIN_MODULE = "github.com/synadia-ai/scratchpad"


def check(ok: object, message: str) -> None:
    if not ok:
        raise ValueError(message)


def encoded(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def run(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> bytes:
    return subprocess.check_output(args, cwd=cwd, env=env)


def configuration() -> dict[str, Any]:
    value = json.loads(CONFIG.read_bytes())
    check(value["schema"] == 1, "unsupported release settings schema")
    check(re.fullmatch(r"sp-v\d+\.\d+\.\d+", value["release"]), "invalid release tag")
    check(re.fullmatch(r"[0-9a-f]{40}", value["source_commit"]), "source pin must be a full commit")
    check(re.fullmatch(r"go\d+\.\d+\.\d+", value["go_version"]), "Go must have an exact version")
    check(value["source_repository"] == "synadia-ai/scratchpad", "unexpected source repository")
    check(len(value["targets"]) == 4 and set(value["targets"]) == SUPPORTED, "unsupported targets")
    check(
        value["build_flags"] == ["-trimpath", "-buildvcs=false", "-ldflags=-s -w"],
        "unexpected build flags",
    )
    if os.environ.get("SP_COMMIT"):
        check(
            os.environ["SP_COMMIT"] == value["source_commit"],
            "edit release.json to change the shared pin; SP_COMMIT differs",
        )
    return value


def binary_name(target: str) -> str:
    check(target in SUPPORTED, "unsupported target")
    return "sp-" + target.replace("/", "-")


def archive_name(config: dict[str, Any], target: str) -> str:
    return config["release"] + "-" + target.replace("/", "-") + ".tar.gz"


def go_environment(config: dict[str, Any], target: str | None = None) -> dict[str, str]:
    env = {
        **os.environ,
        "GOTOOLCHAIN": config["go_version"],
        "CGO_ENABLED": "0",
        "GOFLAGS": "",
        "GOWORK": "off",
        "GOEXPERIMENT": "",
        "GOAMD64": "v1",
        "GOARM64": "v8.0",
    }
    env.pop("GOOS", None)
    env.pop("GOARCH", None)
    if target:
        env["GOOS"], env["GOARCH"] = target.split("/")
    return env


def builder_hash() -> str:
    return digest(
        encoded({name: file_digest(HERE / name) for name in ("release.py", "build-sp.sh")})
    )


def cache_files(config: dict[str, Any]) -> set[str]:
    return {
        *(binary_name(target) for target in config["targets"]),
        "COMMIT",
        "THIRD_PARTY_NOTICES",
        "SKILL.md",
    }


def verify_cache(directory: Path, config: dict[str, Any]) -> dict[str, Any]:
    check(
        directory.is_dir() and not directory.is_symlink(), "cache directory is missing or is a link"
    )
    expected = cache_files(config)
    check(
        {path.name for path in directory.iterdir()} == expected | {"BUILD.json"},
        "cache file allowlist differs",
    )
    for name in expected | {"BUILD.json"}:
        path = directory / name
        check(
            path.is_file() and not path.is_symlink(), "cache member is not a regular file: " + name
        )
    build = json.loads((directory / "BUILD.json").read_bytes())
    check(
        build["config"] == config and build["builder_sha256"] == builder_hash(),
        "cache source/settings/builder changed",
    )
    check(set(build["files"]) == expected, "cache hash allowlist differs")
    for name in sorted(expected):
        path = directory / name
        check(
            build["files"][name] == {"sha256": file_digest(path), "bytes": path.stat().st_size},
            "cache checksum differs: " + name,
        )
        if name.startswith("sp-"):
            check(os.access(path, os.X_OK), "cached binary is not executable: " + name)
    check(
        (directory / "COMMIT").read_text() == config["source_commit"] + "\n",
        "cache source commit differs",
    )
    check(
        set(build["build_info"]) == set(config["targets"]), "cache build-info target list differs"
    )
    for target, info in build["build_info"].items():
        validate_build_info(info, target, config)
    return build


def validate_build_info(info: dict[str, Any], target: str, config: dict[str, Any]) -> None:
    check(
        info["GoVersion"] == config["go_version"] and info["Path"] == MAIN_MODULE + "/cmd/sp",
        "binary toolchain or command differs",
    )
    settings = {item["Key"]: item["Value"] for item in info["Settings"]}
    os_name, arch = target.split("/")
    for key, value in {
        "GOOS": os_name,
        "GOARCH": arch,
        "CGO_ENABLED": "0",
        "-trimpath": "true",
    }.items():
        check(settings.get(key) == value, "binary build setting differs: " + key)
    # Go omits linker arguments from build info when -trimpath is enabled.
    # The exact build invocation remains in the shared release settings.
    check(settings.get("-ldflags") in (None, "-s -w"), "binary linker settings differ")
    check(
        {item["Path"]: item["Version"] for item in info["Deps"]} == config["dependencies"],
        "linked dependency versions differ",
    )
    for module in info["Deps"]:
        if module["Path"] == "github.com/nats-io/nats.go":
            check(
                module.get("Replace", {}).get("Path") == "./third_party/nats-go",
                "binary omitted the owned NATS replacement",
            )
        else:
            check(not module.get("Replace"), "unexpected module replacement")


def json_values(data: bytes) -> list[dict[str, Any]]:
    text, decoder, values = data.decode(), json.JSONDecoder(), []
    while text.strip():
        text = text.lstrip()
        value, offset = decoder.raw_decode(text)
        values.append(value)
        text = text[offset:]
    return values


def notices(source: Path, config: dict[str, Any]) -> bytes:
    modules: dict[str, dict[str, Any]] = {}
    for target in config["targets"]:
        packages = json_values(
            run(
                ["go", "list", "-deps", "-json", "./cmd/sp"],
                cwd=source,
                env=go_environment(config, target),
            )
        )
        for package in packages:
            module = package.get("Module")
            if module and module["Path"] != MAIN_MODULE:
                modules[module["Path"]] = module
    check(
        {name: module["Version"] for name, module in modules.items()} == config["dependencies"],
        "dependency closure differs from reviewed pin",
    )
    goroot = Path(run(["go", "env", "GOROOT"], env=go_environment(config)).decode().strip())
    go_license = goroot / "LICENSE"
    if not go_license.is_file() and goroot.name == "libexec":
        go_license = goroot.parent / "LICENSE"  # Homebrew keeps it above GOROOT.
    sections = [
        (
            "Third-party notices for the ScratchPad executable.\n"
            "These terms describe third-party components, not a license for private ScratchPad source.\n"
            "The agent-fabric-sdk source license does not set the license of the ScratchPad executable.\n"
        ),
        "Go runtime " + config["go_version"] + "\n\n" + go_license.read_text(),
    ]
    for name, module in sorted(modules.items()):
        root = Path(module["Dir"])
        check((root / "LICENSE").is_file(), "dependency has no reviewed license: " + name)
        label = name + " " + module["Version"]
        if name == "github.com/nats-io/nats.go":
            label += (
                "\nContains ScratchPad's NATS completion and pull changes at "
                + config["source_commit"]
                + "."
            )
        texts = [(root / "LICENSE").read_text()]
        if (root / "NOTICE").is_file():
            texts.append((root / "NOTICE").read_text())
        sections.append(label + "\n\n" + "\n\n".join(texts))
    return ("\n\n" + "=" * 72 + "\n\n").join(sections).encode()


def standalone_skill(source: Path) -> bytes:
    text = (source / "skills/scratchpad/SKILL.md").read_text()
    replacements = {
        "Use this skill with the replacement service and `cmd/sp`.\nThe Fabric example image also installs this command as `sp`.\nThe [CLI contract](../../internal/volumecli/README.md) defines every flag and result.": "Use the `sp` binary from this archive with the ScratchPad service.\n[Installation and source metadata](README.md) describe this release.\nPut the installed directory on PATH before using these commands.\nFabric harness agents use their packaged `scripts/sp` wrapper instead.",
        "The [SDK contract](../../client/v2/README.md) defines those operations.": "Those SDK operations are outside this CLI skill.",
        "Read [capacity and growth](../../docs/explainers/current-capacity-and-growth.md) before selecting larger workflows.": "Ask the deployment operator for the selected quotas before choosing larger workflows.",
    }
    for old, new in replacements.items():
        check(
            text.count(old) == 1, "pinned generic skill changed; review its standalone adaptation"
        )
        text = text.replace(old, new)
    check("../../" not in text, "standalone skill contains private repository links")
    return text.encode()


def build_cache(config: dict[str, Any], source: Path, directory: Path = CACHE) -> dict[str, Any]:
    if directory.exists():
        try:
            cached = verify_cache(directory, config)
            print(
                f"Verified {len(config['targets'])} cached binaries at {config['source_commit']}",
                flush=True,
            )
            return cached
        except (OSError, ValueError, KeyError) as error:
            print("Rebuilding invalid cache: " + str(error), flush=True)
    actual = (
        run(["git", "rev-parse", "--verify", config["source_commit"] + "^{commit}"], cwd=source)
        .decode()
        .strip()
    )
    check(actual == config["source_commit"], "source revision differs")
    check(
        run(["go", "env", "GOVERSION"], env=go_environment(config)).decode().strip()
        == config["go_version"],
        "Go toolchain differs",
    )
    WORK.mkdir(exist_ok=True)
    with (
        tempfile.TemporaryDirectory(prefix="source-", dir=WORK) as private,
        tempfile.TemporaryDirectory(prefix="cache-", dir=WORK) as staged,
    ):
        private_path, stage = Path(private), Path(staged)
        archive = private_path / "source.tar"
        with archive.open("wb") as output:
            subprocess.run(
                ["git", "archive", config["source_commit"]], cwd=source, stdout=output, check=True
            )
        with tarfile.open(archive) as source_archive:
            source_archive.extractall(private_path, filter="data")
        archive.unlink()
        (stage / "COMMIT").write_text(config["source_commit"] + "\n")
        (stage / "THIRD_PARTY_NOTICES").write_bytes(notices(private_path, config))
        (stage / "SKILL.md").write_bytes(standalone_skill(private_path))
        information = {}
        for target in config["targets"]:
            output = stage / binary_name(target)
            subprocess.run(
                ["go", "build", *config["build_flags"], "-o", str(output), "./cmd/sp"],
                cwd=private_path,
                env=go_environment(config, target),
                check=True,
            )
            info = json.loads(
                run(["go", "version", "-m", "-json", str(output)], env=go_environment(config))
            )
            info.pop("File", None)
            validate_build_info(info, target, config)
            information[target] = info
            print(f"Built {target}: {output.stat().st_size} bytes", flush=True)
        metadata = {
            "schema": 1,
            "config": config,
            "builder_sha256": builder_hash(),
            "generic_skill_sha256": file_digest(private_path / "skills/scratchpad/SKILL.md"),
            "build_info": information,
            "files": {
                name: {"sha256": file_digest(stage / name), "bytes": (stage / name).stat().st_size}
                for name in sorted(cache_files(config))
            },
        }
        (stage / "BUILD.json").write_bytes(encoded(metadata))
        verify_cache(stage, config)
        if directory.exists():
            check(directory == CACHE, "refuse to replace an unrecognized cache directory")
            shutil.rmtree(directory)
        shutil.copytree(stage, directory)
    return verify_cache(directory, config)


def readme(config: dict[str, Any], target: str) -> bytes:
    return (
        f"# ScratchPad {config['release']} for {target}\n\n"
        "This archive contains a standalone client for the private preview.\n"
        "It needs no Go, Node, Pi, or private source checkout.\n"
        "Put this directory on PATH or invoke its `sp` by absolute path.\n"
        "Use your existing NATS credentials and a private persistent writer directory.\n"
        "Read SKILL.md for publication, grants, reads, hydration, and recovery.\n\n"
        "SOURCE identifies this binary; BUILD.json contains its exact source pin, target, toolchain,\n"
        "hash, and Go build information. The command has no version flag.\n"
        "THIRD_PARTY_NOTICES contains the included dependency terms. The SDK repository's license\n"
        "does not determine the license of this executable or grant access to private ScratchPad source.\n\n"
        "For an explicit download during onboarding or image creation, use the release's get-sp.sh:\n\n"
        f'```sh\nsh get-sp.sh --version {config["release"]} --dest "$HOME/.local/share/scratchpad/{config["release"]}"\n```\n\n'
        "The installer requires authenticated GitHub CLI access to synadia-ai/agent-fabric-sdk,\n"
        "tar, and sha256sum or shasum. It verifies checksums and refuses an existing destination.\n"
        "Downloads never occur during model tool calls. Windows is not a supported target.\n"
    ).encode()


def archive_contents(
    config: dict[str, Any], target: str, cache: Path, build: dict[str, Any]
) -> dict[str, bytes]:
    binary = cache / binary_name(target)
    info = {
        "schema": 1,
        "release": config["release"],
        "source_repository": config["source_repository"],
        "source_commit": config["source_commit"],
        "target": target,
        "go_version": config["go_version"],
        "binary_sha256": file_digest(binary),
        "binary_bytes": binary.stat().st_size,
        "build_info": build["build_info"][target],
        "generic_skill_sha256": build["generic_skill_sha256"],
    }
    source = "".join(
        f"{key}={info[key]}\n"
        for key in ("release", "source_commit", "go_version", "target", "binary_sha256")
    )
    return {
        "sp": binary.read_bytes(),
        "SOURCE": source.encode(),
        "BUILD.json": encoded(info),
        "SKILL.md": (cache / "SKILL.md").read_bytes(),
        "README.md": readme(config, target),
        "THIRD_PARTY_NOTICES": (cache / "THIRD_PARTY_NOTICES").read_bytes(),
    }


def write_archive(path: Path, contents: dict[str, bytes]) -> None:
    check(set(contents) == ARCHIVE_FILES, "archive content allowlist differs")
    with (
        path.open("wb") as output,
        gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed,
        tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive,
    ):
        for name, data in sorted(contents.items()):
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(data), 0o755 if name == "sp" else 0o644
            member.uid = member.gid = member.mtime = 0
            archive.addfile(member, io.BytesIO(data))


def read_archive(path: Path) -> dict[str, bytes]:
    files = {}
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            check(
                member.name in ARCHIVE_FILES and member.name not in files,
                "unexpected or duplicate archive member",
            )
            check(
                member.isfile() and member.mode == (0o755 if member.name == "sp" else 0o644),
                "archive member type/mode differs",
            )
            check(0 < member.size <= 64 * 1024 * 1024, "archive member size differs")
            content = archive.extractfile(member)
            check(content is not None, "archive member is unreadable")
            files[member.name] = content.read()
    check(set(files) == ARCHIVE_FILES, "archive member allowlist differs")
    return files


def verify_release(directory: Path, config: dict[str, Any], cache: Path = CACHE) -> dict[str, Any]:
    build = verify_cache(cache, config)
    expected = {archive_name(config, target) for target in config["targets"]} | {
        "release.json",
        "SHA256SUMS",
        "get-sp.sh",
    }
    check(
        {path.name for path in directory.iterdir()} == expected, "release asset allowlist differs"
    )
    for name in expected:
        check(
            (directory / name).is_file() and not (directory / name).is_symlink(),
            "release asset is not a regular file",
        )
    manifest = json.loads((directory / "release.json").read_bytes())
    check(manifest["config"] == config, "release source/settings differ")
    check(
        set(manifest["assets"]) == expected - {"release.json", "SHA256SUMS"},
        "release manifest asset list differs",
    )
    lines = (directory / "SHA256SUMS").read_text().splitlines()
    expected_lines = [
        file_digest(directory / name) + "  " + name for name in sorted(expected - {"SHA256SUMS"})
    ]
    check(lines == expected_lines, "release checksum list differs")
    for name, details in manifest["assets"].items():
        path = directory / name
        check(
            details == {"sha256": file_digest(path), "bytes": path.stat().st_size},
            "release asset hash differs",
        )
    check(
        (directory / "get-sp.sh").read_bytes() == (HERE / "get-sp.sh").read_bytes(),
        "installer differs",
    )
    for target in config["targets"]:
        check(
            read_archive(directory / archive_name(config, target))
            == archive_contents(config, target, cache, build),
            "archive bytes differ from verified build: " + target,
        )
    return manifest


def package_release(
    config: dict[str, Any], output: Path, *, replace: bool, cache: Path = CACHE
) -> dict[str, Any]:
    build = verify_cache(cache, config)
    if output.exists():
        check(replace, "release output exists; use --replace for a local candidate rebuild")
        verify_release(output, config, cache)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".sp-release-", dir=output.parent) as temporary:
        stage = Path(temporary)
        for target in config["targets"]:
            write_archive(
                stage / archive_name(config, target), archive_contents(config, target, cache, build)
            )
        shutil.copyfile(HERE / "get-sp.sh", stage / "get-sp.sh")
        inputs = [
            "release.json",
            "release.py",
            "build-sp.sh",
            "release-sp.sh",
            "get-sp.sh",
            "SKILL.md",
            "install.sh",
        ]
        manifest = {
            "schema": 1,
            "config": config,
            "packaging_revision": run(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
            "packaging_dirty": bool(
                run(
                    ["git", "status", "--porcelain", "--", "plugins/scratchpad-skill"], cwd=ROOT
                ).strip()
            ),
            "packaging_files": {name: file_digest(HERE / name) for name in inputs},
            "assets": {
                path.name: {"sha256": file_digest(path), "bytes": path.stat().st_size}
                for path in sorted(stage.iterdir())
            },
        }
        (stage / "release.json").write_bytes(encoded(manifest))
        (stage / "SHA256SUMS").write_text(
            "".join(file_digest(path) + "  " + path.name + "\n" for path in sorted(stage.iterdir()))
        )
        verify_release(stage, config, cache)
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output)
    print(
        f"Verified {len(config['targets'])} archives and {len(ARCHIVE_FILES)} allowlisted files per archive in {output}",
        flush=True,
    )
    return verify_release(output, config, cache)


def main() -> None:
    check(sys.version_info >= (3, 12), "build tooling needs Python 3.12+; set SP_BUILD_PYTHON")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "release", "verify"))
    parser.add_argument(
        "--source",
        type=Path,
        default=Path(os.environ.get("SCRATCHPAD_SRC", str(ROOT.parent / "scratchpad"))),
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    config = configuration()
    output = args.output or HERE / "dist" / config["release"]
    WORK.mkdir(exist_ok=True)
    with (WORK / "build.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.command in {"build", "release"}:
            build_cache(config, args.source.resolve())
        if args.command == "release":
            package_release(config, output.resolve(), replace=args.replace)
        elif args.command == "verify":
            verify_release(output.resolve(), config)
            print(
                f"Verified {len(config['targets'])} release archives, hashes, provenance, and file allowlists"
            )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit("sp-release: " + str(error)) from error
