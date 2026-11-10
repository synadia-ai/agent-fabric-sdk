// description.ts — the rule for an agent's description.
//
// The description says what the agent does. The other agents of the account
// read it in discovery (`discover_agents`) when they choose whom to ask, and
// the account's people read it in the console. The agent's own side writes
// it and nothing signs it, so it is a claim; and the whole account reads it,
// so it holds nothing secret.
//
// It is one line of plain text of at most 500 characters. `cleanDescription`
// makes any text fit and never refuses one:
//
//   1. half a character becomes U+FFFD, the replacement character: a
//      surrogate that is not part of a pair, which a text cut inside an
//      emoji holds, and which a program cannot always print;
//   2. every control, invisible, line-break and space character becomes a
//      plain space (the Unicode categories Cc, Cf, Zl, Zp and Zs). Two
//      invisible characters stay, the zero width non-joiner and joiner
//      (U+200C, U+200D): Persian, the Indic scripts and emoji sequences are
//      spelled with them;
//   3. runs of spaces become one, and the spaces at both ends go;
//   4. a text longer than 500 characters is cut to its first 500, and a
//      space the cut leaves at the end goes too.
//
// A character is a Unicode code point, never a byte or a UTF-16 unit, and a
// printable character is never changed. The same rule, with the same test
// vectors (`../../test-fixtures/description-vectors.json`), as
// `../../python/fabric_agent/description.py`.

/** The most characters, counted as Unicode code points, a description has. */
export const DESCRIPTION_LIMIT = 500;

// One code point that is not plain text: a control (a tab, a line break, an
// escape), a format character (a zero-width space, a direction override), a
// line or paragraph separator, or any kind of space.
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
 * `text` as a description: one line of plain text of at most
 * {@link DESCRIPTION_LIMIT} characters. Empty when nothing is left, which
 * means no description.
 */
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
  // Counted here, by code point: an emoji is one character, as it is in Python.
  if (points.length > DESCRIPTION_LIMIT) {
    points.length = DESCRIPTION_LIMIT;
    if (points[points.length - 1] === " ") points.pop();
  }
  return points.join("");
}
