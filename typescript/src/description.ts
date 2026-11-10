// An agent's description, as the `agent-fabric` command shows it: one line
// of plain text. Not part of the package's exports.
//
// A description is free text the agent's own side registered. Before the
// command prints one, every control, invisible, line-break and space
// character becomes a plain space (the Unicode categories Cc, Cf, Zl, Zp and
// Zs), runs of spaces become one, and a text longer than 500 characters is
// cut to its first 500. Two invisible characters stay, the zero width
// non-joiner and joiner (U+200C, U+200D): Persian, the Indic scripts and
// emoji sequences are spelled with them. So a description is always one
// line, and no escape sequence in it reaches the terminal. Printable
// characters are never changed; a character is a Unicode code point. Mirrors
// `synadia_ai/agent_fabric/_description.py`, with the same test vectors.

/** The most characters, counted as Unicode code points, a description has. */
export const DESCRIPTION_LIMIT = 500;

// One code point that is not plain text.
const NOT_PLAIN = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u;
const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;

/** One code point as plain text: itself, or a space in its place. */
function plain(point: string): string {
  const code = point.codePointAt(0);
  if (code === ZERO_WIDTH_NON_JOINER || code === ZERO_WIDTH_JOINER) return point;
  return NOT_PLAIN.test(point) ? " " : point;
}

/** `text` as one line of plain text of at most 500 characters; empty when nothing is left. */
export function cleanDescription(text: string): string {
  // One code point at a time, each tested alone, never one expression over
  // the whole text: an engine that pairs the units of a text wrongly under a
  // global Unicode expression lets a character slip through (Bun 1.3.14
  // does, for a byte order mark after a ligature).
  const points: string[] = [];
  for (const point of text) {
    const next = plain(point);
    // Runs of spaces become one, and none leads.
    if (next === " " && (points.length === 0 || points[points.length - 1] === " ")) continue;
    points.push(next);
  }
  if (points[points.length - 1] === " ") points.pop();
  if (points.length > DESCRIPTION_LIMIT) {
    points.length = DESCRIPTION_LIMIT;
    if (points[points.length - 1] === " ") points.pop();
  }
  return points.join("");
}
