"""The vendored schemas' constraints are the source's, byte for byte in meaning.

The four files under ``test-fixtures/schemas/`` are vendored from the
fabric's schemas, with one exception: their texts (``description``,
``$comment``, ``title``) were reworded here for publication on 2026-09-29.
Every constraint stays as at the source's commit. The digest below is of
each file with those texts removed, canonical JSON with sorted keys, taken
from the files as vendored before the rewording; it moves only when a
constraint does, and then the schemas were copied again and this test is
updated with them.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

SCHEMAS = Path(__file__).resolve().parents[2] / "test-fixtures" / "schemas"

TEXT_KEYS = {"description", "$comment", "title"}
# Maps whose keys are names, not keywords: a property called "title" stays.
NAMED_MAPS = {"properties", "patternProperties", "$defs", "definitions", "dependentSchemas"}

CONSTRAINTS_SHA256 = {
    "edge.json": "be35efc3036d07529375c1284c79b47abe60317bd9af480cdb30bd7ac9a617e6",
    "served.json": "7912268857448be1af22aa54cecb5f4e350720992f508443bf934c05e30b0eee",
    "sp-grant-request.json": "48045a583b4dc4f30b696d0f5d1065f5f44808bd7c4a7cd03d2a6957a0b8dc39",
    "sp-grant-reply.json": "417a1b1cc3683daad122c6f6ce9478bef86d4a4538f72fb14460b3bb2c44ba49",
}


def _constraints(node: Any, parent: str | None = None) -> Any:
    if isinstance(node, dict):
        return {
            key: _constraints(value, key)
            for key, value in node.items()
            if parent in NAMED_MAPS or key not in TEXT_KEYS
        }
    if isinstance(node, list):
        return [_constraints(value) for value in node]
    return node


@pytest.mark.parametrize("name", sorted(CONSTRAINTS_SHA256))
def test_constraints_are_the_sources(name: str) -> None:
    schema = json.loads((SCHEMAS / name).read_text(encoding="utf-8"))
    canonical = json.dumps(
        _constraints(schema), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    assert hashlib.sha256(canonical.encode("utf-8")).hexdigest() == CONSTRAINTS_SHA256[name]


def test_every_vendored_schema_is_covered() -> None:
    assert {path.name for path in SCHEMAS.glob("*.json")} == set(CONSTRAINTS_SHA256)
