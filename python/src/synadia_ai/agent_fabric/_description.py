"""An agent's description, as the ``agent-fabric`` command shows it: one line
of plain text. Not part of the package's exports.

A description is free text the agent's own side registered. Before the command
prints one, every control, invisible, line-break and space character becomes a
plain space (the Unicode categories Cc, Cf, Zl, Zp and Zs), runs of spaces
become one, and a text longer than 500 characters is cut to its first 500. Two
invisible characters stay, the zero width non-joiner and joiner (U+200C,
U+200D): Persian, the Indic scripts and emoji sequences are spelled with them.
So a description is always one line, and no escape sequence in it reaches the
terminal. Printable characters are never changed; a character is a Unicode code
point. Mirrors ``typescript/src/description.ts``, with the same test vectors.
"""

from __future__ import annotations

import unicodedata

#: The most characters, counted as Unicode code points, a description has.
DESCRIPTION_LIMIT = 500

# The categories of a code point that is not plain text.
_NOT_PLAIN = frozenset({"Cc", "Cf", "Zl", "Zp", "Zs"})
# The zero width non-joiner and joiner.
_KEPT = frozenset({chr(0x200C), chr(0x200D)})


def _plain(ch: str) -> str:
    """One code point as plain text: itself, or a space in its place."""
    return " " if unicodedata.category(ch) in _NOT_PLAIN and ch not in _KEPT else ch


def clean_description(text: str) -> str:
    """``text`` as one line of plain text of at most 500 characters; empty when nothing is left."""
    spaced = "".join(_plain(ch) for ch in text)
    line = " ".join(part for part in spaced.split(" ") if part)
    if len(line) <= DESCRIPTION_LIMIT:
        return line
    return line[:DESCRIPTION_LIMIT].rstrip(" ")
