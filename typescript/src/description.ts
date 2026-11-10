// What an agent registered, as the `agent-fabric` command shows it: plain
// text, and for the description one line of it. Not part of the package's
// exports.
//
// A description is free text the agent's own side registered. Before the
// command prints one, half a character (a surrogate that is not part of a
// pair) becomes U+FFFD, every control, invisible, line-break and space
// character becomes a plain space (the Unicode categories Cc, Cf, Zl, Zp and
// Zs), runs of spaces become one, and a text longer than 500 characters is
// cut to its first 500. Two invisible characters stay, the zero width
// non-joiner and joiner (U+200C, U+200D): Persian, the Indic scripts and
// emoji sequences are spelled with them. So a description is always one
// line that can be printed, and no escape sequence in it reaches the
// terminal. Printable characters are never changed; a character is a
// Unicode code point. Mirrors `synadia_ai/agent_fabric/_description.py`,
// with the same test vectors.
//
// The other fields of a listed agent, its address, its kind and its
// identity, are registered text too. `plainLine` applies the rule's first
// step to one: the same characters become a space or U+FFFD, and nothing is
// collapsed or cut.

/** The most characters, counted as Unicode code points, a description has. */
export const DESCRIPTION_LIMIT = 500;

// One code point that is not plain text.
const NOT_PLAIN = /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u;
const ZERO_WIDTH_NON_JOINER = 0x200c;
const ZERO_WIDTH_JOINER = 0x200d;

// What takes the place of half a character: U+FFFD, the replacement character.
const REPLACEMENT = String.fromCodePoint(0xfffd);

/** One code point as plain text: itself, a space in its place, or U+FFFD for half of one. */
function plain(point: string): string {
  const code = point.codePointAt(0);
  // A surrogate that is not part of a pair: a text cut inside an emoji has
  // one. A pair arrives here as one code point above U+FFFF, never as these.
  if (code !== undefined && code >= 0xd800 && code <= 0xdfff) return REPLACEMENT;
  if (code === ZERO_WIDTH_NON_JOINER || code === ZERO_WIDTH_JOINER) return point;
  return NOT_PLAIN.test(point) ? " " : point;
}

/**
 * `text` as it can be printed inside a line: every control, invisible,
 * line-break and space character as a plain space, half a character as
 * U+FFFD, everything else as it is. As many characters as it had.
 */
export function plainLine(text: string): string {
  let line = "";
  for (const point of text) line += plain(point);
  return line;
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
