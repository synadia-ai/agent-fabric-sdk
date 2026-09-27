#!/usr/bin/env -S uv run --script
# /// script
# requires-python = "==3.12.*"
# dependencies = []
# ///
"""Qualify an extracted sp executable against the real ScratchPad service fixture.

The service fixture is built separately from an explicit private source revision.
The workflow itself uses only sp, an already built fixture, and the SDK test adapter.
Credentials stay in the fixture's temporary directory and never enter the report.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def execution_label(target_os: str, target_arch: str, host_os: str, host_arch: str) -> str:
    host_arch = {"aarch64": "arm64", "x86_64": "amd64"}.get(host_arch, host_arch)
    if host_arch not in {"arm64", "amd64"} or host_os.lower() != target_os:
        raise RuntimeError("unsupported qualification host or operating system")
    if target_os == "darwin":
        if target_arch == host_arch:
            return "native macOS " + host_arch
        if host_arch == "arm64" and target_arch == "amd64":
            return "Rosetta on macOS arm64"
        raise RuntimeError("macOS arm64 qualification requires an arm64 host")
    if target_arch == host_arch:
        return "native Linux " + host_arch + " Docker"
    return "Docker " + target_arch + " emulation on " + host_arch


async def workflow(args: argparse.Namespace) -> None:
    spec = importlib.util.spec_from_file_location("native_service", args.adapter)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    work = args.work.resolve()
    work.mkdir(mode=0o700)
    fixture_dir = work / "fixture-client"
    fixture_dir.mkdir(mode=0o700)
    fixture_process = await asyncio.create_subprocess_exec(
        str(args.fixture.resolve()),
        "-test.run=^TestNativeClientFixtureProcess$",
        "-test.timeout=180s",
        env={**os.environ, "SP_NATIVE_CLIENT_FIXTURE": "1"},
        cwd=work,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    fixture = module.NativeService(fixture_process, fixture_dir)
    commands = []
    counts = None
    try:
        fixture.config = await asyncio.wait_for(asyncio.shield(fixture.ready), 30)
        cfg = fixture.config
        workspace = work / "workspace"
        workspace.mkdir(mode=0o700)

        async def sp(
            command: str,
            *flags: str,
            user: str = "owner",
            fault: bool = False,
            writer: bool = True,
            expected: int = 0,
        ) -> dict:
            argv = [
                str(args.sp.resolve()),
                command,
                "--url",
                cfg["fault_url" if fault else "url"],
                "--creds",
                cfg["users"][user]["credentials"],
            ]
            if writer:
                argv.extend(["--dir", str(workspace)])
            argv.extend(flags)
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                # sp has no external executable dependency.
                env={**os.environ, "PATH": "/sp-no-tools"},
                cwd=work,
            )
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), 45)
            except BaseException:
                process.kill()
                await process.wait()
                raise
            commands.append({"command": command, "principal": user, "exit": process.returncode})
            if process.returncode != expected:
                raise AssertionError(
                    f"{command}: expected exit {expected}, got {process.returncode}: "
                    f"{stdout.decode()} {stderr.decode()}"
                )
            payload = stdout if expected == 0 else stderr
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                # Refusals may place their structured result on stdout.
                return json.loads(stdout)

        await sp("init", "--volume", cfg["volume"], "--operation-id", "artifact-create")
        content = bytes(index % 251 for index in range(1_048_713))
        source = work / "source.bin"
        source.write_bytes(content)
        published = await sp(
            "publish-file",
            "--source",
            str(source),
            "--path",
            "/artifact.bin",
            "--operation-id",
            "artifact-publish",
            "--creator",
            "agent://artifact-test",
        )
        reference = published["reference"]
        assert published["receipt"] and reference.startswith("sp-ref:")

        async def grant(ref: str, action: str) -> None:
            reader = cfg["users"]["reader"]
            value = await sp(
                "grant",
                "--ref",
                ref,
                "--grantee-account",
                reader["account"],
                "--grantee-user",
                reader["user"],
                "--operation-id",
                action,
            )
            assert value["expires_at"] > 0 and value["handle"]["generation"] > 0

        await grant(reference, "artifact-grant")
        read = await sp("read", "--ref", reference, user="reader", writer=False)
        assert read["bytes"] == len(content) and base64.b64decode(read["data_base64"]) == content
        denied = await sp("read", "--ref", reference, user="intruder", writer=False, expected=1)
        assert denied["error"]["code"] == "denied" and denied["error"]["unknown"] is False, denied
        go_read = await fixture.command("go_read", reference=reference, user="reader")
        assert go_read["bytes"] == len(content) and go_read["sha256"] == digest(content)

        recovered_content = bytes((index * 7 + 3) % 251 for index in range(1_048_733))
        source.write_bytes(recovered_content)
        await fixture.command("drop_publish", operation_id="artifact-unknown")
        unknown = await sp(
            "publish-file",
            "--source",
            str(source),
            "--path",
            "/recovered.bin",
            "--operation-id",
            "artifact-unknown",
            "--creator",
            "agent://artifact-test",
            fault=True,
            expected=3,
        )
        assert unknown["error"]["unknown"] is True, (
            "unknown outcome must include a structured diagnostic"
        )
        accepted = await fixture.command("accepted", operation_id="artifact-unknown")
        source.write_bytes(b"changed source must not replace the saved intent")
        await fixture.command("restart_service")
        recovered = await sp("recover")
        assert recovered["receipt"] == accepted["receipt"]
        await grant(recovered["reference"], "recovered-grant")
        read = await sp("read", "--ref", recovered["reference"], user="reader", writer=False)
        assert read["bytes"] == len(recovered_content)
        assert base64.b64decode(read["data_base64"]) == recovered_content

        tree = work / "tree"
        tree.mkdir(mode=0o700)
        (tree / "nested").mkdir()
        (tree / "nested" / "answer.txt").write_bytes(b"retained tree bytes\n")
        executable = tree / "run.sh"
        executable.write_bytes(b"#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        (tree / "answer-link").symlink_to("nested/answer.txt")
        synced = await sp(
            "sync",
            "--source",
            str(tree),
            "--operation-id",
            "artifact-tree",
            "--handoff-creator",
            "agent://artifact-test",
            "--handoff-path",
            "/",
        )
        await grant(synced["reference"], "tree-grant")
        destination = work / "hydrated"
        hydrated = await sp(
            "hydrate",
            "--ref",
            synced["reference"],
            "--destination",
            str(destination),
            user="reader",
            writer=False,
        )
        assert (destination / "nested" / "answer.txt").read_bytes() == b"retained tree bytes\n"
        assert (destination / "run.sh").read_bytes() == executable.read_bytes()
        assert (destination / "run.sh").stat().st_mode & 0o111 == 0o111
        assert (destination / "answer-link").is_symlink()
        assert os.readlink(destination / "answer-link") == "nested/answer.txt"
        assert hydrated["files"] == 2 and hydrated["symlinks"] == 1
        counts = await fixture.close()
        assert counts["accepted_receipts"] == 1 and counts["dropped_replies"] == 1
        assert counts["go_reads"] == 1 and counts["service_restarts"] == 1
        result = {
            "target": args.target,
            "execution": args.execution,
            "binary_sha256": digest(args.sp.read_bytes()),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "published_bytes": len(content),
            "published_sha256": digest(content),
            "recovered_bytes": len(recovered_content),
            "recovered_sha256": digest(recovered_content),
            "exact_receipt_recovered": True,
            "changed_source_ignored": True,
            "denied_reads": 1,
            "hydrated_files": 2,
            "hydrated_symlinks": 1,
            "executable_mode_preserved": True,
            "fixture": counts,
            "commands": commands,
            "scope": "installed CLI on a real single-server service fixture; not R3 or performance qualification",
        }
        (work / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        if args.report is not None:
            args.report.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
    finally:
        if counts is None:
            await fixture.kill()
            shutil.rmtree(fixture_dir, ignore_errors=True)


def outer(args: argparse.Namespace) -> None:
    root = args.core_root.resolve()
    source_commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=root):
        raise RuntimeError("fixture source checkout must be clean")
    target_os, target_arch = args.target.split("-")
    if target_os == "darwin":
        execution = execution_label(target_os, target_arch, platform.system(), platform.machine())
    else:
        docker_host = (
            subprocess.check_output(
                ["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"],
                text=True,
            )
            .strip()
            .split("/")
        )
        execution = execution_label(target_os, target_arch, *docker_host)
    out = args.evidence.resolve()
    out.mkdir(mode=0o700)
    archive = args.archive.resolve()
    with tarfile.open(archive) as package:
        expected = {
            "sp",
            "SOURCE",
            "BUILD.json",
            "SKILL.md",
            "README.md",
            "THIRD_PARTY_NOTICES",
        }
        members = package.getmembers()
        if (
            {m.name for m in members} != expected
            or len(members) != len(expected)
            or not all(m.isfile() for m in members)
        ):
            raise RuntimeError("release archive differs from the exact regular-file allowlist")
        package.extractall(out / "installed", filter="data")
    installed = out / "installed"
    metadata = dict(line.split("=", 1) for line in (installed / "SOURCE").read_text().splitlines())
    assert metadata["target"] == args.target.replace("-", "/")
    assert metadata["source_commit"] == source_commit
    assert metadata["binary_sha256"] == digest((installed / "sp").read_bytes())
    fixture = out / "fixture"
    # The macOS amd64 executable uses Rosetta against the native host service.
    fixture_arch = (
        "arm64" if target_os == "darwin" and platform.machine() == "arm64" else target_arch
    )
    build_env = {
        **os.environ,
        "GOOS": target_os,
        "GOARCH": fixture_arch,
        "CGO_ENABLED": "0",
        "GOTOOLCHAIN": "go1.26.7",
    }
    with (out / "build.log").open("w") as log:
        subprocess.run(
            ["go", "test", "-c", "-o", str(fixture), "./internal/volumeservice"],
            cwd=root,
            env=build_env,
            stdout=log,
            stderr=subprocess.STDOUT,
            check=True,
            timeout=240,
        )
    sdk_root = Path(__file__).resolve().parents[3]
    adapter = sdk_root / "python/tests/harness/native_service.py"
    copied_adapter = out / "native_service.py"
    shutil.copy2(adapter, copied_adapter)
    copied_gate = out / "qualify-artifact.py"
    shutil.copy2(Path(__file__), copied_gate)
    if target_os == "darwin":
        argv = [
            sys.executable,
            str(copied_gate),
            "workflow",
            "--sp",
            str(installed / "sp"),
            "--fixture",
            str(fixture),
            "--adapter",
            str(copied_adapter),
            "--work",
            str(out / "workflow"),
            "--target",
            args.target,
            "--execution",
            execution,
            "--report",
            str(out / "workflow-result.json"),
        ]
    else:
        volume = "sp-artifact-" + digest(str(out).encode())[:16]
        exists = subprocess.run(
            ["docker", "volume", "inspect", volume], capture_output=True, check=False
        )
        if exists.returncode == 0:
            raise RuntimeError(f"qualification volume already exists: {volume}")
        created = subprocess.check_output(
            [
                "docker",
                "volume",
                "create",
                "--label",
                "scratchpad.qualification=true",
                "--label",
                f"scratchpad.evidence={out.name}",
                volume,
            ],
            text=True,
        ).strip()
        if created != volume:
            raise RuntimeError("Docker returned an unexpected qualification volume")
        (out / "docker-volume.txt").write_text(volume + "\n")
        argv = [
            "docker",
            "run",
            "--rm",
            "--platform",
            f"linux/{target_arch}",
            "--network",
            "none",
            "--mount",
            f"type=bind,src={out},dst=/qualification",
            "--mount",
            f"type=volume,src={volume},dst=/work",
            "python:3.12-slim",
            "python",
            "/qualification/qualify-artifact.py",
            "workflow",
            "--sp",
            "/qualification/installed/sp",
            "--fixture",
            "/qualification/fixture",
            "--adapter",
            "/qualification/native_service.py",
            "--work",
            "/work/workflow",
            "--target",
            args.target,
            "--execution",
            execution,
            "--report",
            "/qualification/workflow-result.json",
        ]
    with (out / "workflow.log").open("w") as log:
        subprocess.run(argv, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=240)
    result = json.loads((out / "workflow-result.json").read_text())
    result.update(archive_sha256=digest(archive.read_bytes()), source_commit=source_commit)
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(
        json.dumps(
            {
                "target": args.target,
                "execution": execution,
                "published_bytes": result["published_bytes"],
                "recovered_bytes": result["recovered_bytes"],
                "commands": len(result["commands"]),
                "denied_reads": result["denied_reads"],
                "exact_receipt_recovered": result["exact_receipt_recovered"],
            }
        )
    )


def main() -> None:
    if not __debug__:
        raise RuntimeError("qualification requires Python assertions enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    run = sub.add_parser("run")
    run.add_argument("--core-root", required=True, type=Path)
    run.add_argument("--archive", required=True, type=Path)
    run.add_argument("--evidence", required=True, type=Path)
    run.add_argument(
        "--target",
        required=True,
        choices=["darwin-arm64", "darwin-amd64", "linux-arm64", "linux-amd64"],
    )
    inner = sub.add_parser("workflow")
    for name in ("sp", "fixture", "adapter", "work"):
        inner.add_argument(f"--{name}", required=True, type=Path)
    inner.add_argument("--target", required=True)
    inner.add_argument("--execution", required=True)
    inner.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.mode == "workflow":
        asyncio.run(workflow(args))
    else:
        outer(args)


if __name__ == "__main__":
    main()
