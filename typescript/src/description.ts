// An agent's description, as the `agent-fabric` command shows it: one line
// of plain text. Not part of the package's exports.
//
// A description is free text the agent's own side registered. Before the
// command prints one, every control, invisible, line-break and space
// character becomes a plain space (the Unicode categories Cc, Cf, Zl, Zp and
// Zs), runs of spaces become one, and a text longer than 500 characters is
// cut to its first 500. So a description is always one line, and no escape
// sequence in it reaches the terminal. Printable characters are never
// changed; a character is a Unicode code point. Mirrors
// `synadia_ai/agent_fabric/_description.py`, with the same test vectors.

/** The most characters, counted as Unicode code points, a description has. */
export const DESCRIPTION_LIMIT = 500;

const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu;

/** `text` as one line of plain text of at most 500 characters; empty when nothing is left. */
export function cleanDescription(text: string): string {
  const line = text.replace(NOT_PLAIN, " ").replace(/ +/g, " ").replace(/^ | $/g, "");
  const characters = Array.from(line);
  if (characters.length <= DESCRIPTION_LIMIT) return line;
  return characters.slice(0, DESCRIPTION_LIMIT).join("").replace(/ $/, "");
}
