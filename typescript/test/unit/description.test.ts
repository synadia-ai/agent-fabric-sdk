// An agent's description as the command shows it (`src/description.ts`),
// against the vectors the reference agents' own rule is tested with. Their
// `entry` list is for the places a person types a description; the command
// only shows one.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cleanDescription,
  DESCRIPTION_LIMIT,
  terminalText,
  wellFormed,
} from "../../src/description.js";

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

// The text is read only as far as its result needs, one character past the
// limit, and the result is the one that cleaning the whole text first and
// cutting it then gives.
describe("cleanDescription, at the cut", () => {
  const FFFD = String.fromCodePoint(0xfffd);
  const JOINER = String.fromCodePoint(0x200d);
  const THUMB = String.fromCodePoint(0x1f44d); // one character, two UTF-16 units
  const HALF = String.fromCharCode(0xd83d); // half a character
  const a = (count: number): string => "a".repeat(count);

  it("cuts after the 500th character, whatever stands there", () => {
    // A space the cut leaves at the end goes; nothing else does.
    expect(cleanDescription(`${a(498)} z`)).toBe(`${a(498)} z`);
    expect(cleanDescription(`${a(499)} z`)).toBe(a(499));
    expect(cleanDescription(`${a(500)} z`)).toBe(a(500));
    expect(cleanDescription(`${a(499)}${JOINER}z`)).toBe(`${a(499)}${JOINER}`);
    expect(cleanDescription(`${a(499)}${THUMB}z`)).toBe(`${a(499)}${THUMB}`);
    expect(cleanDescription(`${a(499)}${HALF}z`)).toBe(`${a(499)}${FFFD}`);
    expect(cleanDescription(`${a(500)}${THUMB}`)).toBe(a(500));
    expect(cleanDescription(`${a(500)}${HALF}`)).toBe(a(500));
  });

  // The rule the plain way, for the texts below: the whole text first, then
  // the cut.
  function wholeFirst(text: string): string {
    const line = Array.from(text, (point) => (point === HALF ? FFFD : point))
      .join("")
      .replace(/ +/g, " ")
      .replace(/^ | $/g, "");
    const points = Array.from(line);
    if (points.length <= DESCRIPTION_LIMIT) return line;
    return points.slice(0, DESCRIPTION_LIMIT).join("").replace(/ $/, "");
  }

  it("gives what cleaning the whole text first gives, for 498 to 503 characters", () => {
    // At the boundary: a space, a joiner, a character above U+FFFF, half a
    // character. After it: nothing, more text, more spaces, the same again.
    for (let length = 498; length <= 503; length++) {
      for (const boundary of [" ", JOINER, THUMB, HALF]) {
        const tails = ["", "z", " z", "  ", "zzzzzz", boundary, `${boundary}${boundary}z`];
        for (const tail of tails) {
          const text = `${a(length - 1)}${boundary}${tail}`;
          const label = `${length} characters, U+${boundary.codePointAt(0)!.toString(16)} last, then ${JSON.stringify(tail)}`;
          expect([label, cleanDescription(text)]).toEqual([label, wholeFirst(text)]);
        }
      }
    }
  });

  it("stops reading one character past the limit", () => {
    // A text that counts how much of it is read: a hundred thousand
    // characters, a space after every six. Only its iteration is used, as
    // the rule reads a text.
    let read = 0;
    const long = {
      *[Symbol.iterator](): Generator<string> {
        for (let i = 0; i < 100_000; i++) {
          read += 1;
          yield i % 7 === 6 ? " " : "a";
        }
      },
    } as unknown as string;
    expect(cleanDescription(long)).toBe("aaaaaa ".repeat(72).slice(0, DESCRIPTION_LIMIT));
    expect(read).toBe(DESCRIPTION_LIMIT + 1);
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

describe("wellFormed", () => {
  it("writes U+FFFD for half a character and changes nothing else", () => {
    const [high, low] = [String.fromCharCode(0xd83d), String.fromCharCode(0xdc4d)];
    const fffd = String.fromCodePoint(0xfffd);
    const rest = `\u001b[2J\ttab\r\n${String.fromCodePoint(0x202e, 0x200d, 0xa0)}`;
    expect(wellFormed(`${rest}${high}`)).toBe(`${rest}${fffd}`);
    expect(wellFormed(`${low}${rest}${low}${high}`)).toBe(`${fffd}${rest}${fffd}${fffd}`);
    expect(wellFormed(`${high}${low}${rest}`)).toBe(`${String.fromCodePoint(0x1f44d)}${rest}`);
  });
});
