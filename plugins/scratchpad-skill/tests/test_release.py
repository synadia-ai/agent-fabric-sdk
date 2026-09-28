"""Exercise real built artifacts; mock only the external GitHub download command."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sp_release", HERE / "release.py")
assert SPEC and SPEC.loader
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
QUALIFICATION_SPEC = importlib.util.spec_from_file_location(
    "sp_qualification", HERE / "tests/qualify-artifact.py"
)
assert QUALIFICATION_SPEC and QUALIFICATION_SPEC.loader
qualification = importlib.util.module_from_spec(QUALIFICATION_SPEC)
QUALIFICATION_SPEC.loader.exec_module(qualification)

FAKE_GH = """#!/bin/sh
set -eu
printf '%s\\n' "$@" >"$SP_TEST_CALL_LOG"
[ "$1" = release ] && [ "$2" = download ] && [ "$3" = "$SP_TEST_RELEASE_VERSION" ]
shift 3
repository=
archive=
destination=
checksums=
while [ $# -gt 0 ]; do
  case $1 in
    --repo) repository=$2 ;;
    --dir) destination=$2 ;;
    --pattern) case $2 in SHA256SUMS) checksums=$2 ;; *.tar.gz) archive=$2 ;; *) exit 7 ;; esac ;;
    *) exit 8 ;;
  esac
  shift 2
done
[ "$repository" = synadia-ai/agent-fabric-sdk ] && [ "$GH_HOST" = github.com ]
[ -n "$archive" ] && [ -n "$checksums" ] && [ -n "$destination" ]
cp "$SP_TEST_RELEASE_DIR/$archive" "$SP_TEST_RELEASE_DIR/SHA256SUMS" "$destination/"
"""


class DistributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = release.configuration()
        cls.assets = Path(
            os.environ.get("SP_RELEASE_TEST_ASSETS", str(HERE / "dist" / cls.config["release"]))
        )
        # Missing builds fail the suite; these checks are never silently skipped.
        cls.build = release.verify_cache(release.CACHE, cls.config)
        release.verify_release(cls.assets, cls.config)

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="package-test-", dir=release.WORK)
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.downloads = self.directory / "downloads"
        self.downloads.mkdir()
        self.commands = self.directory / "commands"
        self.commands.mkdir()
        for command in (
            "sh",
            "awk",
            "cat",
            "cp",
            "dirname",
            "mkdir",
            "mktemp",
            "rm",
            "tar",
            "sort",
            "cmp",
            "chmod",
            "mv",
            "grep",
            "uname",
            "sha256sum",
            "shasum",
        ):
            path = shutil.which(command)
            if path:
                (self.commands / command).symlink_to(path)
        (self.commands / "gh").write_text(FAKE_GH)
        (self.commands / "gh").chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(self.commands),
            "SP_TEST_RELEASE_DIR": str(self.downloads),
            "SP_TEST_RELEASE_VERSION": self.config["release"],
            "SP_TEST_CALL_LOG": str(self.directory / "gh.log"),
        }
        self.target = "linux/amd64"
        self.asset = release.archive_name(self.config, self.target)
        shutil.copyfile(self.assets / self.asset, self.downloads / self.asset)
        self.checksums()

    def checksums(self) -> None:
        (self.downloads / "SHA256SUMS").write_text(
            release.file_digest(self.downloads / self.asset) + "  " + self.asset + "\n"
        )

    def install(
        self,
        *,
        target: str | None = None,
        destination: Path | None = None,
        version: bool = True,
        script: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        args = [
            "sh",
            str(script or HERE / "get-sp.sh"),
            "--dest",
            str(destination or self.directory / "installed"),
            "--target",
            target or self.target,
        ]
        if version:
            args += ["--version", self.config["release"]]
        return subprocess.run(args, env=self.env, text=True, capture_output=True, check=False)

    def changed_archive(self, change: str) -> None:
        contents = release.read_archive(self.downloads / self.asset)
        if change == "target":
            contents["SOURCE"] = contents["SOURCE"].replace(
                b"target=linux/amd64", b"target=darwin/amd64"
            )
        elif change == "binary":
            contents["SOURCE"] = contents["SOURCE"].replace(
                release.digest(contents["sp"]).encode(), b"0" * 64
            )
        else:
            raise AssertionError(change)
        release.write_archive(self.downloads / self.asset, contents)
        self.checksums()

    def test_real_release_members_notices_and_shared_hashes(self) -> None:
        for target in self.config["targets"]:
            with self.subTest(target=target):
                files = release.read_archive(
                    self.assets / release.archive_name(self.config, target)
                )
                self.assertEqual(set(files), release.ARCHIVE_FILES)
                self.assertEqual(
                    release.digest(files["sp"]),
                    self.build["files"][release.binary_name(target)]["sha256"],
                )
                self.assertNotIn(b"../../", files["SKILL.md"])
                self.assertIn(b"literal symbolic links without following links", files["SKILL.md"])
                for module in self.config["dependencies"]:
                    self.assertIn(module.encode(), files["THIRD_PARTY_NOTICES"])
                self.assertIn(b"Go runtime go1.26.7", files["THIRD_PARTY_NOTICES"])
                self.assertIn(
                    b"ScratchPad's NATS completion and pull changes",
                    files["THIRD_PARTY_NOTICES"],
                )

    def test_archive_bytes_are_reproducible(self) -> None:
        contents = release.read_archive(self.assets / self.asset)
        first, second = self.directory / "a.tar.gz", self.directory / "b.tar.gz"
        release.write_archive(first, contents)
        release.write_archive(second, contents)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        self.assertEqual(first.read_bytes(), (self.assets / self.asset).read_bytes())

    @staticmethod
    def recovery_contract(text: str) -> str:
        heading = "### Remove an unprepared upload\n"
        if text.count(heading) != 1:
            raise RuntimeError("skill must contain one upload-abandonment contract")
        return text.split(heading, 1)[1].split("\n## ", 1)[0].strip()

    def require_recovery_parity(self, adapted: str) -> None:
        generic = (release.CACHE / "SKILL.md").read_text()
        if self.recovery_contract(generic) != self.recovery_contract(adapted):
            raise RuntimeError("harness recovery instructions differ from the pinned generic skill")

    def test_harness_recovery_matches_the_pinned_generic_skill(self) -> None:
        self.require_recovery_parity((HERE / "SKILL.md").read_text())

    def test_recovery_parity_refuses_an_unsafe_pending_rule(self) -> None:
        text = (HERE / "SKILL.md").read_text()
        guard = "refuses a pending checkpoint"
        self.assertEqual(text.count(guard), 1)
        with self.assertRaisesRegex(RuntimeError, "recovery instructions differ"):
            self.require_recovery_parity(text.replace(guard, "permits a pending checkpoint"))

    @staticmethod
    def normalized_packaged_skill(text: str, harness: str) -> str:
        if harness != "claude-code":
            return text
        permission = "allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)\n"
        lines = text.splitlines(keepends=True)
        if lines.count(permission) != 1:
            raise RuntimeError("Claude skill permission differs from the exact wrapper rule")
        lines.remove(permission)
        return "".join(lines)

    def test_packaged_skill_refuses_expanded_claude_permissions(self) -> None:
        source = (HERE / "SKILL.md").read_text()
        permission = "allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)\n"
        installed = source.replace("---\n", "---\n" + permission, 1)
        self.assertEqual(self.normalized_packaged_skill(installed, "claude-code"), source)
        with self.assertRaisesRegex(RuntimeError, "permission differs"):
            self.normalized_packaged_skill(
                installed.replace(permission, permission.rstrip() + " Bash(*)\n"),
                "claude-code",
            )

    def test_all_harness_archives_embed_the_current_skill_and_binaries(self) -> None:
        source = (HERE / "SKILL.md").read_text()
        env = {
            **os.environ,
            "SP_BUILD_PYTHON": sys.executable,
            "SCRATCHPAD_SRC": str(self.directory / "no-private-source-needed"),
        }
        for harness in ("pi", "openclaw", "claude-code"):
            with self.subTest(harness=harness):
                addon = HERE.parent / harness
                skill = "skills/scratchpad" if harness == "claude-code" else "skill/scratchpad"
                generated = addon / skill
                if generated.exists():
                    shutil.rmtree(generated)
                destination = self.directory / harness
                destination.mkdir()
                packed = subprocess.run(
                    [
                        "npm",
                        "pack",
                        "--json",
                        "--pack-destination",
                        str(destination),
                    ],
                    cwd=addon,
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(packed.returncode, 0, packed.stderr)
                archives = list(destination.iterdir())
                self.assertEqual(len(archives), 1, packed.stdout)
                archive = archives[0]
                with tarfile.open(archive) as package:

                    def member(name: str) -> bytes:
                        value = package.extractfile("package/" + name)
                        self.assertIsNotNone(value, name)
                        return value.read()

                    installed_skill = member(skill + "/SKILL.md").decode()
                    normalized = self.normalized_packaged_skill(installed_skill, harness)
                    self.assertEqual(normalized, source)
                    self.require_recovery_parity(normalized)
                    self.assertEqual(
                        member(skill + "/scripts/sp"),
                        (HERE / "scripts/sp").read_bytes(),
                    )
                    self.assertEqual(json.loads(member(skill + "/bin/BUILD.json")), self.build)
                    for target in self.config["targets"]:
                        name = release.binary_name(target)
                        self.assertEqual(
                            release.digest(member(skill + "/bin/" + name)),
                            self.build["files"][name]["sha256"],
                        )
                    manifest = json.loads(member("package.json"))
                    self.assertGreater(len(member(manifest["main"].removeprefix("./"))), 0)
                    self.assertEqual(
                        member(skill + "/THIRD_PARTY_NOTICES"),
                        (release.CACHE / "THIRD_PARTY_NOTICES").read_bytes(),
                    )

    def test_qualification_labels_use_the_actual_execution_host(self) -> None:
        self.assertEqual(
            qualification.execution_label("darwin", "amd64", "Darwin", "x86_64"),
            "native macOS amd64",
        )
        self.assertEqual(
            qualification.execution_label("darwin", "amd64", "Darwin", "arm64"),
            "Rosetta on macOS arm64",
        )
        self.assertEqual(
            qualification.execution_label("linux", "amd64", "linux", "x86_64"),
            "native Linux amd64 Docker",
        )
        self.assertEqual(
            qualification.execution_label("linux", "arm64", "linux", "aarch64"),
            "native Linux arm64 Docker",
        )
        self.assertEqual(
            qualification.execution_label("linux", "amd64", "linux", "aarch64"),
            "Docker amd64 emulation on arm64",
        )
        with self.assertRaisesRegex(RuntimeError, "requires an arm64 host"):
            qualification.execution_label("darwin", "arm64", "Darwin", "amd64")

    def test_harness_install_copies_identical_binaries_and_package_notices(
        self,
    ) -> None:
        addon = self.directory / "addon"
        addon.mkdir()
        (addon / "package.json").write_text(
            json.dumps(
                {
                    "name": "scratchpad-package-check",
                    "version": "0.0.0",
                    "files": ["skill", "skills"],
                }
            )
        )
        env = {
            **os.environ,
            "SP_BUILD_PYTHON": sys.executable,
            "SCRATCHPAD_SRC": str(self.directory / "no-source-checkout"),
        }
        for destination in ("skill/scratchpad", "skills/scratchpad"):
            result = subprocess.run(
                [
                    "sh",
                    str(HERE / "install.sh"),
                    "--dest",
                    destination,
                    "--allowed-tools",
                    "Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)",
                ],
                cwd=addon,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            installed = addon / destination
            for target in self.config["targets"]:
                name = release.binary_name(target)
                self.assertEqual(
                    release.file_digest(installed / "bin" / name),
                    self.build["files"][name]["sha256"],
                )
            self.assertEqual(
                (installed / "THIRD_PARTY_NOTICES").read_bytes(),
                (release.CACHE / "THIRD_PARTY_NOTICES").read_bytes(),
            )
            self.assertEqual(
                (installed / "scripts/sp").read_bytes(),
                (HERE / "scripts/sp").read_bytes(),
            )
            self.assertIn(
                "allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)",
                (installed / "SKILL.md").read_text(),
            )
        packed = subprocess.run(
            ["npm", "pack", "--dry-run", "--ignore-scripts", "--json"],
            cwd=addon,
            env=os.environ,
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(packed.returncode, 0, packed.stderr)
        members = {entry["path"] for entry in json.loads(packed.stdout)[0]["files"]}
        for destination in ("skill/scratchpad", "skills/scratchpad"):
            self.assertIn(destination + "/THIRD_PARTY_NOTICES", members)
            self.assertIn(destination + "/bin/BUILD.json", members)
            for target in self.config["targets"]:
                self.assertIn(destination + "/bin/" + release.binary_name(target), members)

    def test_cache_corruption_is_detected_even_with_same_commit_and_size(self) -> None:
        cache = self.directory / "cache"
        shutil.copytree(release.CACHE, cache)
        binary = cache / release.binary_name(self.target)
        with binary.open("r+b") as output:
            original = output.read(1)
            output.seek(0)
            output.write(bytes([original[0] ^ 1]))
        with self.assertRaisesRegex(ValueError, "cache checksum differs"):
            release.verify_cache(cache, self.config)

    def test_cache_settings_and_unexpected_files_are_detected(self) -> None:
        for key, wrong in (("source_commit", "0" * 40), ("go_version", "go1.26.6")):
            with (
                self.subTest(key=key),
                self.assertRaisesRegex(ValueError, "source/settings/builder"),
            ):
                release.verify_cache(release.CACHE, {**self.config, key: wrong})
        cache = self.directory / "cache"
        shutil.copytree(release.CACHE, cache)
        (cache / "private.go").write_text("must never be packaged")
        with self.assertRaisesRegex(ValueError, "allowlist"):
            release.verify_cache(cache, self.config)

    def test_install_all_four_archives_without_source_or_compiler(self) -> None:
        for absent in ("go", "python3", "node", "git"):
            self.assertIsNone(shutil.which(absent, path=self.env["PATH"]))
        for target in self.config["targets"]:
            with self.subTest(target=target):
                self.asset = release.archive_name(self.config, target)
                shutil.copyfile(self.assets / self.asset, self.downloads / self.asset)
                self.checksums()
                destination = self.directory / target.replace("/", "-")
                result = self.install(target=target, destination=destination)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(
                    {item.name for item in destination.iterdir()}, release.ARCHIVE_FILES
                )
                self.assertEqual(
                    release.file_digest(destination / "sp"),
                    self.build["files"][release.binary_name(target)]["sha256"],
                )
                self.assertTrue(os.access(destination / "sp", os.X_OK))
                self.assertIn(
                    "synadia-ai/agent-fabric-sdk",
                    (self.directory / "gh.log").read_text(),
                )

    def test_corrupted_download_stops_before_install(self) -> None:
        contents = release.read_archive(self.downloads / self.asset)
        contents["README.md"] += b"\nChanged after publication.\n"
        release.write_archive(self.downloads / self.asset, contents)
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("archive checksum differs", result.stderr)
        self.assertFalse((self.directory / "installed").exists())

    def test_image_build_parents_allow_runtime_user_to_traverse(self) -> None:
        parent = self.directory / "new-image-root" / "scratchpad"
        destination = parent / self.config["release"]
        result = self.install(destination=destination)
        self.assertEqual(result.returncode, 0, result.stderr)
        for directory in (parent.parent, parent, destination):
            self.assertEqual(
                directory.stat().st_mode & 0o005,
                0o005,
                "a non-owner runtime user cannot reach the installed binary",
            )
        self.assertEqual((destination / "sp").stat().st_mode & 0o005, 0o005)

    def test_duplicate_checksum_stops_before_install(self) -> None:
        checksums = self.downloads / "SHA256SUMS"
        checksums.write_text(checksums.read_text() * 2)
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing or duplicated", result.stderr)
        self.assertFalse((self.directory / "installed").exists())

    def test_checksum_source_control_admits_the_changed_archive(self) -> None:
        # Remove one guard in an isolated script copy. The corruption case
        # above must reject exactly the archive this control now admits.
        contents = release.read_archive(self.downloads / self.asset)
        contents["README.md"] += b"\nChanged after publication.\n"
        release.write_archive(self.downloads / self.asset, contents)
        original = (HERE / "get-sp.sh").read_text()
        guard = '[ "$(hash "$archive")" = "$expected" ] || fail "archive checksum differs"'
        self.assertEqual(original.count(guard), 1)
        mutant = self.directory / "get-sp-without-archive-check.sh"
        mutant.write_text(original.replace(guard, "# checksum source control"))
        result = self.install(script=mutant)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(
            b"Changed after publication.",
            (self.directory / "installed/README.md").read_bytes(),
        )

    def test_target_and_binary_hash_are_verified_inside_archive(self) -> None:
        for change, refusal in (
            ("target", "archive release or target differs"),
            ("binary", "binary checksum differs"),
        ):
            with self.subTest(change=change):
                shutil.copyfile(self.assets / self.asset, self.downloads / self.asset)
                self.changed_archive(change)
                result = self.install()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(refusal, result.stderr)
                self.assertFalse((self.directory / "installed").exists())

    def test_unexpected_source_or_link_is_refused_before_extraction(self) -> None:
        contents = release.read_archive(self.assets / self.asset)
        for hazard in ("private.go", "symlink"):
            with self.subTest(hazard=hazard):
                with tarfile.open(self.downloads / self.asset, "w:gz") as archive:
                    for name, data in contents.items():
                        member = tarfile.TarInfo(name)
                        member.mode, member.size = (
                            (0o755 if name == "sp" else 0o644),
                            len(data),
                        )
                        if hazard == "symlink" and name == "sp":
                            member.type, member.linkname, member.size = (
                                tarfile.SYMTYPE,
                                "../outside",
                                0,
                            )
                            archive.addfile(member)
                        else:
                            archive.addfile(member, io.BytesIO(data))
                    if hazard == "private.go":
                        archive.addfile(tarfile.TarInfo("private.go"), io.BytesIO(b""))
                self.checksums()
                with self.assertRaisesRegex(ValueError, "member"):
                    release.read_archive(self.downloads / self.asset)
                result = self.install()
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr, "allowlist|non-regular")
                self.assertFalse((self.directory / "installed").exists())
                self.assertFalse((self.directory / "outside").exists())

    def test_existing_destination_is_preserved(self) -> None:
        destination = self.directory / "installed"
        destination.mkdir()
        (destination / "keep").write_text("existing workspace")
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((destination / "keep").read_text(), "existing workspace")
        self.assertFalse((self.directory / "gh.log").exists())

    def test_version_and_supported_target_are_required_before_download(self) -> None:
        for options in ({"version": False}, {"target": "windows/amd64"}):
            with self.subTest(options=options):
                result = self.install(**options)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.directory / "gh.log").exists())

    def test_go_info_target_and_owned_replacement_are_checked(self) -> None:
        info = json.loads(json.dumps(self.build["build_info"][self.target]))
        for item in info["Settings"]:
            if item["Key"] == "GOARCH":
                item["Value"] = "arm64"
        with self.assertRaisesRegex(ValueError, "build setting"):
            release.validate_build_info(info, self.target, self.config)
        info = json.loads(json.dumps(self.build["build_info"][self.target]))
        for module in info["Deps"]:
            if module["Path"] == "github.com/nats-io/nats.go":
                del module["Replace"]
        with self.assertRaisesRegex(ValueError, "owned NATS replacement"):
            release.validate_build_info(info, self.target, self.config)


if __name__ == "__main__":
    unittest.main()
