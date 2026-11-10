// An agent's description as the command shows it (`src/description.ts`),
// against the vectors the reference agents' own rule is tested with. Their
// `entry` list is for the places a person types a description; the command
// only shows one.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanDescription, DESCRIPTION_LIMIT, terminalText } from "../../src/description.js";

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../reference-agents/test-fixtures/description-vectors.json", import.meta.url),
    "utf8",
  ),
) as { limit: number; clean: { name: string; in: string; out: string }[] };

describe("cleanDescription, against the shared vectors", () => {
  it("has the vectors' limit", () => {
    expect(DESCRIPTION_LIMIT).toBe(vectors.limit);
    expect(vectors.clean.length).toBeGreaterThan(0);
  });

  it.each(vectors.clean)("$name", (v) => {
    expect(cleanDescription(v.in)).toBe(v.out);
    // A cleaned text is a description: cleaning it again changes nothing.
    expect(cleanDescription(v.out)).toBe(v.out);
  });
});

// A reply or a question as a terminal is sent it. The same cases as the
// Python suite's.
describe("terminalText", () => {
  const FFFD = String.fromCodePoint(0xfffd);
  const at = (...codes: number[]): string => String.fromCodePoint(...codes);

  it("keeps a line break and a tab, and the text around them", () => {
    expect(terminalText("one\ttwo\nthree: caf\u00e9, \u{1F44D}")).toBe(
      "one\ttwo\nthree: caf\u00e9, \u{1F44D}",
    );
  });

  it("shows U+FFFD for every other control character", () => {
    for (let code = 0; code <= 0x9f; code++) {
      if (code >= 0x20 && code < 0x7f) continue; // printable ASCII
      const kept = code === 0x09 || code === 0x0a;
      expect([code, terminalText(`a${at(code)}b`)]).toEqual([
        code,
        kept ? `a${at(code)}b` : `a${FFFD}b`,
      ]);
    }
  });

  it("shows U+FFFD for a format character, in any plane", () => {
    // Soft hyphen, zero width space, the direction marks and overrides, the
    // word joiner, the byte order mark, a language tag.
    for (const code of [0xad, 0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2060, 0xfeff, 0xe0001]) {
      expect([code, terminalText(`a${at(code)}b`)]).toEqual([code, `a${FFFD}b`]);
    }
  });

  it("keeps the zero width non-joiner and joiner", () => {
    const family = at(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const word = at(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645);
    expect(terminalText(`${word} ${family}`)).toBe(`${word} ${family}`);
  });

  it("shows U+FFFD for half a character, and keeps a whole one", () => {
    const [high, low] = [String.fromCharCode(0xd83d), String.fromCharCode(0xdc4d)];
    expect(terminalText(`a${high}`)).toBe(`a${FFFD}`);
    expect(terminalText(`${low}b`)).toBe(`${FFFD}b`);
    expect(terminalText(`${low}${high}`)).toBe(`${FFFD}${FFFD}`);
    expect(terminalText(`${high}${low}`)).toBe(at(0x1f44d));
  });

  it("leaves every kind of space and separator: they are not control characters", () => {
    const spaces = at(0x20, 0xa0, 0x2003, 0x3000, 0x2028, 0x2029);
    expect(terminalText(spaces)).toBe(spaces);
  });
});
