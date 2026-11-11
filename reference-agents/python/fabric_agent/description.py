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

The prompt tool (``prompt.py``) prints other text another agent wrote: the
address and the identity it registered, the words of a refusal, its reply.
:func:`plain_line` applies steps 1 and 2 to a text that is printed inside a
line. :func:`terminal_text` is for a reply on a terminal, over as many lines
as it has: the line breaks and the tabs stay, and every other control or
format character is shown as U+FFFD, so an escape sequence is printed and
never run. :func:`well_formed` is for a reply that goes to a pipe or a file:
it is left as it came, but for half a character, which Python cannot write.
The ``agent-fabric`` command prints these texts by the same three.
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


def plain_line(text: str) -> str:
    """``text`` as it can be printed inside a line: every control, invisible,
    line-break and space character as a plain space, half a character as
    U+FFFD, everything else as it is. As many characters as it had."""
    return "".join(_plain(ch) for ch in text)


def well_formed(text: str) -> str:
    """``text`` with U+FFFD for half a character, and nothing else changed: the
    text a program that writes UTF-8 can write."""
    return "".join(_REPLACEMENT if unicodedata.category(ch) == "Cs" else ch for ch in text)


# The categories of a code point that a terminal may act on instead of showing
# it, a control character (the escape character among them) or a format
# character, and of half a character.
_NOT_SHOWN = frozenset({"Cc", "Cf", "Cs"})
# A line break and a tab, and the zero width non-joiner and joiner.
_SHOWN = frozenset({"\n", "\t"}) | _KEPT


def terminal_text(text: str) -> str:
    """``text`` as a terminal can be sent it, over as many lines as it has: every
    control and format character as U+FFFD, and half a character too. A line
    break (U+000A) and a tab stay, and so do the zero width non-joiner and
    joiner. Everything else is as it is. As many characters as it had."""
    return "".join(_REPLACEMENT if ch not in _SHOWN and unicodedata.category(ch) in _NOT_SHOWN else ch for ch in text)


def clean_description(text: str) -> str:
    """``text`` as a description: one line of plain text of at most
    :data:`DESCRIPTION_LIMIT` characters. Empty when nothing is left, which
    means no description."""
    points: list[str] = []
    for ch in text:
        nxt = _plain(ch)
        # Runs of spaces become one, and none leads.
        if nxt == " " and (not points or points[-1] == " "):
            continue
        points.append(nxt)
        # One character past the limit settles the result: the text is cut to
        # its first 500, whatever follows. So nothing is read past the 501st
        # character that is kept. Up to there every character is read: a run
        # of spaces or controls to its end, though one space at most is kept.
        if len(points) > DESCRIPTION_LIMIT:
            break
    del points[DESCRIPTION_LIMIT:]
    # The space that ended the text, or that the cut left at the end.
    if points and points[-1] == " ":
        points.pop()
    return "".join(points)
