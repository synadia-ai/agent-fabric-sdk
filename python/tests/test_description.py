"""An agent's description as the command shows it (``_description.py``).

Against the vectors the reference agents' own rule is tested with. Their
``entry`` list is for the places a person types a description; the command only
shows one. The TypeScript suite's ``description.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from synadia_ai.agent_fabric._description import (
    DESCRIPTION_LIMIT,
    clean_description,
    terminal_text,
    well_formed,
)

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


# A reply or a question as a terminal is sent it. The same cases as the
# TypeScript suite's.
_FFFD = chr(0xFFFD)


def test_terminal_text_keeps_a_line_break_and_a_tab_and_the_text_around_them() -> None:
    text = "one\ttwo\nthree: caf\u00e9, \U0001f44d"
    assert terminal_text(text) == text


def test_terminal_text_shows_u_fffd_for_every_other_control_character() -> None:
    for code in range(0xA0):
        if 0x20 <= code < 0x7F:  # printable ASCII
            continue
        kept = code in (0x09, 0x0A)
        expected = f"a{chr(code)}b" if kept else f"a{_FFFD}b"
        assert (code, terminal_text(f"a{chr(code)}b")) == (code, expected)


def test_terminal_text_shows_u_fffd_for_a_format_character_in_any_plane() -> None:
    # Soft hyphen, zero width space, the direction marks and overrides, the
    # word joiner, the byte order mark, a language tag.
    for code in (0xAD, 0x200B, 0x200E, 0x200F, 0x202A, 0x202E, 0x2060, 0xFEFF, 0xE0001):
        assert (code, terminal_text(f"a{chr(code)}b")) == (code, f"a{_FFFD}b")


def test_terminal_text_keeps_the_zero_width_non_joiner_and_joiner() -> None:
    family = "".join(map(chr, (0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467)))
    word = "".join(map(chr, (0x645, 0x6CC, 0x200C, 0x62E, 0x648, 0x627, 0x647, 0x645)))
    assert terminal_text(f"{word} {family}") == f"{word} {family}"


def test_terminal_text_shows_u_fffd_for_half_a_character_and_keeps_a_whole_one() -> None:
    high, low = chr(0xD83D), chr(0xDC4D)
    assert terminal_text(f"a{high}") == f"a{_FFFD}"
    assert terminal_text(f"{low}b") == f"{_FFFD}b"
    assert terminal_text(f"{low}{high}") == f"{_FFFD}{_FFFD}"
    assert terminal_text(chr(0x1F44D)) == chr(0x1F44D)


def test_terminal_text_leaves_every_kind_of_space_and_separator() -> None:
    # They are not control characters.
    spaces = "".join(map(chr, (0x20, 0xA0, 0x2003, 0x3000, 0x2028, 0x2029)))
    assert terminal_text(spaces) == spaces


def test_well_formed_writes_u_fffd_for_half_a_character_and_changes_nothing_else() -> None:
    high, low = chr(0xD83D), chr(0xDC4D)
    rest = "\u001b[2J\ttab\r\n" + "".join(map(chr, (0x202E, 0x200D, 0xA0)))
    assert well_formed(f"{rest}{high}") == f"{rest}{_FFFD}"
    assert well_formed(f"{low}{rest}{low}{high}") == f"{_FFFD}{rest}{_FFFD}{_FFFD}"
    assert well_formed(f"{chr(0x1F44D)}{rest}") == f"{chr(0x1F44D)}{rest}"
    # The text can be written as UTF-8.
    assert well_formed(f"{high}{rest}{low}").encode()
