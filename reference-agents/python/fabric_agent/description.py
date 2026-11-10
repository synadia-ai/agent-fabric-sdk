"""description.py — the rule for an agent's description.

The description says what the agent does. The other agents of the account
read it in discovery (``discover_agents``) when they choose whom to ask, and
the account's people read it in the console. The agent's own side writes it
and nothing signs it, so it is a claim; and the whole account reads it, so it
holds nothing secret.

It is one line of plain text of at most 500 characters.
:func:`clean_description` makes any text fit and never refuses one:

1. half a character becomes U+FFFD, the replacement character: a surrogate
   that is not part of a pair, which a text cut inside an emoji holds, and so
   does a value that was not UTF-8. Python cannot print one;
2. every control, invisible, line-break and space character becomes a plain
   space (the Unicode categories Cc, Cf, Zl, Zp and Zs). Two invisible
   characters stay, the zero width non-joiner and joiner (U+200C, U+200D):
   Persian, the Indic scripts and emoji sequences are spelled with them;
3. runs of spaces become one, and the spaces at both ends go;
4. a text longer than 500 characters is cut to its first 500, and a space the
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


# What takes the place of half a character: U+FFFD, the replacement character.
_REPLACEMENT = chr(0xFFFD)


def _plain(ch: str) -> str:
    """One code point as plain text: itself, a space in its place, or U+FFFD for half of one."""
    category = unicodedata.category(ch)
    # A surrogate that is not part of a pair: a text cut inside an emoji has
    # one, and so has a value that was not UTF-8. Python cannot print it.
    if category == "Cs":
        return _REPLACEMENT
    return " " if category in _NOT_PLAIN and ch not in _KEPT else ch


def clean_description(text: str) -> str:
    """``text`` as a description: one line of plain text of at most
    :data:`DESCRIPTION_LIMIT` characters. Empty when nothing is left, which
    means no description."""
    spaced = "".join(_plain(ch) for ch in text)
    line = " ".join(part for part in spaced.split(" ") if part)
    if len(line) <= DESCRIPTION_LIMIT:
        return line
    return line[:DESCRIPTION_LIMIT].rstrip(" ")
