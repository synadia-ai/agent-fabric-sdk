"""Under ``make test-py CHECKOUTS=1`` the four packages are the checkouts',
in the test process and in a child started with ``sys.executable``, as the
tests that run the agent as a program start it. Without ``CHECKOUTS=1`` it
skips: the packages are PyPI's.

The Makefile passes ``CHECKOUTS``, ``SDK_DIR`` and ``DE_DIR``.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
SIBLINGS = REPO.parent
MODULES = {
    "synadia_ai.agents": SIBLINGS / os.environ.get("SDK_DIR", "synadia-agents") / "client-sdk" / "python",
    "synadia_ai.agent_service": SIBLINGS / os.environ.get("SDK_DIR", "synadia-agents") / "agent-sdk" / "python",
    "synadia_ai.agent_fabric": REPO / "python",
    "synadia_durable": SIBLINGS / os.environ.get("DE_DIR", "durable-sdk") / "python",
}
WHERE = "import importlib, json, sys; print(json.dumps({m: importlib.import_module(m).__file__ for m in sys.argv[1:]}))"


@pytest.mark.skipif(os.environ.get("CHECKOUTS") != "1", reason="runs under make test-py CHECKOUTS=1")
def test_the_four_packages_are_the_checkouts_in_the_tests_and_in_a_child() -> None:
    here = json.loads(subprocess.run([sys.executable, "-c", WHERE, *MODULES], capture_output=True, text=True, check=True).stdout)
    for module, checkout in MODULES.items():
        own = Path(importlib.import_module(module).__file__ or "").resolve()
        child = Path(here[module]).resolve()
        for path in (own, child):
            assert path.is_relative_to(checkout.resolve()), f"{module} from {path}, not from {checkout}"
