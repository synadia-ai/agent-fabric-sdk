"""description.py — the rule for an agent's description.

The description says what the agent does. The other agents of the account
read it in discovery (``discover_agents``) when they choose whom to ask, and
the account's people read it in the console. The agent's own side writes it
and nothing signs it, so it is a claim; and the whole account reads it, so it
holds nothing secret.

It is one line of plain text of at most 500 characters.
:func:`clean_description` makes any text fit and never refuses one:

1. every control, invisible, line-break and space character becomes a plain
   space (the Unicode categories Cc, Cf, Zl, Zp and Zs). Two invisible
   characters stay, the zero width non-joiner and joiner (U+200C, U+200D):
   Persian, the Indic scripts and emoji sequences are spelled with them;
2. runs of spaces become one, and the spaces at both ends go;
3. a text longer than 500 characters is cut to its first 500, and a space the
   cut leaves at the end goes too.

A character is a Unicode code point, never a byte or a UTF-16 unit, and a
printable character is never changed. The same rule, with the same test
vectors (``../../test-fixtures/description-vectors.json``), as
``../../typescript/src/description.ts``.
"""

from __future__ import annotations

import unicodedata

#: The most characters, counted as Unicode code points, a description has.
DESCRIPTION_LIMIT = 500

# A code point that is not plain text: a control (a tab, a line break, an
# escape), a format character (a zero-width space, a direction override), a
# line or paragraph separator, or any kind of space.
_NOT_PLAIN = frozenset({"Cc", "Cf", "Zl", "Zp", "Zs"})
# The zero width non-joiner and joiner.
_KEPT = frozenset({chr(0x200C), chr(0x200D)})


def _plain(ch: str) -> str:
    """One code point as plain text: itself, or a space in its place."""
    return " " if unicodedata.category(ch) in _NOT_PLAIN and ch not in _KEPT else ch


def clean_description(text: str) -> str:
    """``text`` as a description: one line of plain text of at most
    :data:`DESCRIPTION_LIMIT` characters. Empty when nothing is left, which
    means no description."""
    spaced = "".join(_plain(ch) for ch in text)
    line = " ".join(part for part in spaced.split(" ") if part)
    if len(line) <= DESCRIPTION_LIMIT:
        return line
    return line[:DESCRIPTION_LIMIT].rstrip(" ")
