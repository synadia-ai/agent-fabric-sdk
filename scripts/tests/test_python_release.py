from __future__ import annotations

import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "python-release.py"
SPEC = importlib.util.spec_from_file_location("python_release", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class PythonReleaseTests(unittest.TestCase):
    def artifacts(self, root: Path) -> tuple[Path, Path]:
        wheel = root / "package.whl"
        sdist = root / "package.tar.gz"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr(
                "package.dist-info/METADATA",
                "Name: synadia-ai-agent-fabric\nVersion: 0.1.0\nRequires-Dist: synadia-ai-agents==0.8.0\nRequires-Dist: synadia-ai-agent-service==0.5.0\n",
            )
            archive.writestr("package.dist-info/licenses/LICENSE", "license")
            archive.writestr("synadia_ai/agent_fabric/THIRD_PARTY_NOTICES", "notices")
        project = '[project]\nname = "synadia-ai-agent-fabric"\nversion = "0.1.0"\ndependencies = ["synadia-ai-agents==0.8.0", "synadia-ai-agent-service==0.5.0"]\n'
        with tarfile.open(sdist, "w:gz") as archive:
            for name, value in {
                "pyproject.toml": project,
                "LICENSE": "license",
                "THIRD_PARTY_NOTICES": "notices",
            }.items():
                data = value.encode()
                member = tarfile.TarInfo("package/" + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return wheel, sdist

    def test_stage_removes_local_sources_and_pins_first_party_and_backend(self) -> None:
        source = '[project]\nname = "synadia-ai-agent-fabric"\nversion = "0.1.0"\ndependencies = [\n"synadia-ai-agents>=0.8",\n"synadia-ai-agent-service>=0.5",\n"nats-py>=2.16",\n]\n[tool.uv.sources]\nsynadia-ai-agents = { path = "../source" }\n[build-system]\nrequires = ["hatchling"]\n'
        staged = release.stage_project(source)
        self.assertNotIn("../source", staged)
        self.assertIn('"synadia-ai-agents==0.8.0"', staged)
        self.assertIn('"synadia-ai-agent-service==0.5.0"', staged)
        self.assertIn('"hatchling==1.32.0"', staged)
        self.assertIn('"nats-py>=2.16"', staged)

    def test_public_boundary_admits_known_repos_and_refuses_other_org_repos(
        self,
    ) -> None:
        release.public_bytes(
            b"https://github.com/synadia-ai/agent-fabric-sdk", "readme"
        )
        with self.assertRaisesRegex(ValueError, "unapproved repository"):
            release.public_bytes(
                b"https://github.com/synadia-ai/unapproved-project", "readme"
            )

    def test_inspection_rejects_version_mismatch_with_valid_artifact_control(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.artifacts(root)
            self.assertEqual(len(release.inspect(root, "0.1.0")), 2)
            with self.assertRaisesRegex(ValueError, "name/version differs"):
                release.inspect(root, "0.1.1")

    @mock.patch.dict(os.environ, {"GITHUB_SHA": "0" * 40})
    def test_digest_guard_detects_changed_distribution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wheel, sdist = self.artifacts(root)
            record = {
                "schema": 1,
                "name": release.NAME,
                "version": "0.1.0",
                "source_commit": "0" * 40,
                "external_cutoff": release.CUTOFF,
                "dependencies": release.DEPENDENCIES,
                "artifacts": {p.name: release.sha256(p) for p in (wheel, sdist)},
            }
            (root / "artifacts.json").write_text(json.dumps(record))
            release.verify(root, "0.1.0", False)
            with (
                mock.patch.dict(os.environ, {"GITHUB_SHA": "1" * 40}),
                self.assertRaisesRegex(ValueError, "source differs"),
            ):
                release.verify(root, "0.1.0", False)
            with wheel.open("ab") as stream:
                stream.write(b"changed")
            with self.assertRaisesRegex(ValueError, "digest differs"):
                release.verify(root, "0.1.0", False)


if __name__ == "__main__":
    unittest.main()
