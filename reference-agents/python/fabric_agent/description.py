"""description.py — the rule for an agent's description.

The description says what the agent does. The other agents of the account
read it in discovery (``discover_agents``) when they choose whom to ask, and
the account's people read it in the console. The agent's own side writes it
and nothing signs it, so it is a claim; and the whole account reads it, so it
holds nothing secret.

It is one line of plain text of at most 500 characters.
:func:`clean_description` makes any text fit and never refuses one:

1. every control, invisible, line-break and space character becomes a plain
   space (the Unicode categories Cc, Cf, Zl, Zp and Zs);
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

# Controls (a tab, a line break, an escape), format characters (a zero-width
# space, a direction override), line and paragraph separators, and every kind
# of space.
_NOT_PLAIN = frozenset({"Cc", "Cf", "Zl", "Zp", "Zs"})


def clean_description(text: str) -> str:
    """``text`` as a description: one line of plain text of at most
    :data:`DESCRIPTION_LIMIT` characters. Empty when nothing is left, which
    means no description."""
    spaced = "".join(" " if unicodedata.category(ch) in _NOT_PLAIN else ch for ch in text)
    line = " ".join(part for part in spaced.split(" ") if part)
    if len(line) <= DESCRIPTION_LIMIT:
        return line
    return line[:DESCRIPTION_LIMIT].rstrip(" ")
