"""Pin each schema's constraints independently of descriptive text.

Source histories and the additive short-reference grant-request pattern are
recorded in test-fixtures/README.md. A contract change updates this digest
and its behavior tests together; prose changes leave the digest unchanged.
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
    "sp-grant-request.json": "340ed503c22eb9f7da9af88cdceca82ff8765c24e6677f9482c91dc0a85e29c1",
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
def test_constraints_match_the_pinned_contract(name: str) -> None:
    schema = json.loads((SCHEMAS / name).read_text(encoding="utf-8"))
    canonical = json.dumps(
        _constraints(schema), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    assert hashlib.sha256(canonical.encode("utf-8")).hexdigest() == CONSTRAINTS_SHA256[name]


def test_every_vendored_schema_is_covered() -> None:
    assert {path.name for path in SCHEMAS.glob("*.json")} == set(CONSTRAINTS_SHA256)
