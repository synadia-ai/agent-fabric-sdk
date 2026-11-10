"""An agent's description as the command shows it (``_description.py``).

Against the vectors the reference agents' own rule is tested with. Their
``entry`` list is for the places a person types a description; the command only
shows one. The TypeScript suite's ``description.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from synadia_ai.agent_fabric._description import DESCRIPTION_LIMIT, clean_description

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "reference-agents/test-fixtures/description-vectors.json"
    ).read_text(encoding="utf-8")
)


def test_has_the_vectors_limit() -> None:
    assert VECTORS["limit"] == DESCRIPTION_LIMIT
    assert VECTORS["clean"]


@pytest.mark.parametrize("vector", VECTORS["clean"], ids=lambda v: v["name"])
def test_clean_description_against_the_shared_vectors(vector: dict[str, str]) -> None:
    assert clean_description(vector["in"]) == vector["out"]
    # A cleaned text is a description: cleaning it again changes nothing.
    assert clean_description(vector["out"]) == vector["out"]
