// An agent's description as the command shows it (`src/description.ts`),
// against the vectors the reference agents' own rule is tested with. Their
// `entry` list is for the places a person types a description; the command
// only shows one.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanDescription, DESCRIPTION_LIMIT } from "../../src/description.js";

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
