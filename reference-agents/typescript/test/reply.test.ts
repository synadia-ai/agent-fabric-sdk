import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deliveredReply } from "../src/reply.js";

const cases = JSON.parse(readFileSync(new URL("../../test-fixtures/reply-delivery.json", import.meta.url), "utf8"));
describe("bounded reply language contract", () => {
  for (const item of cases) {
    it(item.name, () => {
      const text = item.unit.repeat(item.repeat) + item.suffix;
      const reference = item.mode === "granted" ? "sp-ref:exact" : undefined;
      const value = deliveredReply(text, reference);
      expect(Buffer.byteLength(text, "utf8")).toBe(item.bytes);
      const expected = item.large
        ? reference === undefined
          ? `Delivery refused: the ${item.bytes}-byte result exceeds the 65536-byte inline limit and no retained ScratchPad handoff was granted.`
          : `Result stored in ScratchPad (${item.bytes} UTF-8 bytes). Read the granted reference to retrieve it.\n\n${reference}`
        : text + (reference === undefined ? "" : `\n\n${reference}`);
      expect(value).toEqual({ reply: expected, history: item.large ? expected : text });
      if (item.large) expect(Buffer.byteLength(value.reply, "utf8")).toBeLessThan(1024);
    });
  }
});


it("returns only the short handoff token in a large model-facing reply", () => {
  const reference = "sp-r1:" + "A".repeat(60);
  const result = deliveredReply("x".repeat(65537), reference);
  expect(result.reply.endsWith(reference)).toBe(true);
  expect(result.reply).not.toContain("sp-ref:");
  expect(result.history).toBe(result.reply);
});
