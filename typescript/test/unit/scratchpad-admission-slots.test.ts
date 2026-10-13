import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as p from "../../src/scratchpad-native/protocol";

type Shape = "admission" | "lifetime" | "removal_plan" | "release_plan" | "release_result";
type Wire = Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../test-fixtures/scratchpad/admission-slots-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: { slot: number; values: Record<Shape, Wire>; canonical_json: Record<Shape, string> }[];
  invalid: { name: string; slot: unknown }[];
};
const validators: Record<Shape, (value: unknown) => void> = {
  admission: p.validateAdmissionBinding,
  lifetime: p.validateLifetimeView,
  removal_plan: p.validateRemovalPlan,
  release_plan: p.validateVolumeReleasePlan,
  release_result: p.validateVolumeReleaseResult,
};

for (const shape of Object.keys(validators) as Shape[]) {
  describe(`public ${shape} admission slot`, () => {
    it.each(fixture.valid)("preserves uint32 slot $slot through strict wire decoding", (test) => {
      const decoded = p.parseStrictJSON(test.canonical_json[shape], p.MAX_CONTROL_BYTES);
      validators[shape](decoded);
      expect(decoded).toEqual(test.values[shape]);
      expect(p.goJSON(decoded)).toBe(test.canonical_json[shape]);
    });
    it.each(fixture.invalid)("refuses $name", (test) => {
      const value = structuredClone(fixture.valid[0]!.values[shape]);
      const binding = shape === "lifetime" ? (value.admission as Wire) : value;
      binding.slot = test.slot;
      expect(() =>
        validators[shape](p.parseStrictJSON(JSON.stringify(value), p.MAX_CONTROL_BYTES)),
      ).toThrow();
    });
  });
}

it("keeps writer, retention, and read-grant slots bounded", () => {
  for (const [validate, maximum] of [
    [p.validateWriter, p.WRITER_SLOTS - 1],
    [p.validateRetentionHandle, p.RETENTION_SLOTS - 1],
    [p.validateGrantHandle, p.GRANT_SLOTS - 1],
  ] as const) {
    expect(() => validate({ slot: maximum, generation: 1 })).not.toThrow();
    expect(() => validate({ slot: maximum + 1, generation: 1 })).toThrow();
    expect(() => validate({ slot: 256, generation: 1 })).toThrow();
  }
});
