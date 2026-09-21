"""Shared by the cross-language tests: where the TypeScript package is, and whether it can run."""

from __future__ import annotations

import shutil

from tests.support import REPO_ROOT

TS_DIR = REPO_ROOT / "typescript"
FABRIC_TS_MODULE = TS_DIR / "src" / "index.ts"


def interop_prereqs_missing() -> str | None:
    """Why the TypeScript side cannot run here, or ``None`` when it can."""
    if shutil.which("bun") is None:
        return "bun not on PATH"
    if not (TS_DIR / "node_modules" / "@synadia-ai" / "agent-service").exists():
        return "typescript/node_modules missing — run `npm install` in typescript/"
    return None
