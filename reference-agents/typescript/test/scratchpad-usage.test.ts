import { describe, expect, it } from "vitest";
import {
  NativeScratchPadError,
  type ScratchPadClient,
} from "@synadia-ai/agent-fabric";
import { ScratchPadUsage } from "../src/scratchpad-usage.js";
import { NO_TOOLS } from "../src/tools.js";

function client() {
  return {
    calls: 0,
    error: undefined as Error | undefined,
    async diagnostics() {
      this.calls++;
      if (this.error) throw this.error;
      return {
        volume: "Replies",
        status: "unbound" as const,
        allowance: { bytes: 1024, objects: 100 },
      };
    },
  };
}
describe("model-facing volume usage", () => {
  it.each(["{}", "", "  "])(
    "accepts no-argument provider output %j without guessing zero usage",
    async (args) => {
      const pad = client();
      const runner = new ScratchPadUsage(
        NO_TOOLS,
        pad as unknown as ScratchPadClient,
      );
      expect(runner.definitions).toHaveLength(1);
      const result = JSON.parse(
        await runner.call("scratchpad_usage", args, "call-1"),
      );
      expect(result.status).toBe("unbound");
      expect(result.charged).toBeUndefined();
      expect(pad.calls).toBe(1);
      expect(
        JSON.parse(await runner.call("discover_agents", "{}", "call-2")).error,
      ).toBe("this agent has no tools");
    },
  );
  it.each([
    '{"volume":"other"}',
    '{"credentials":"secret"}',
    "[]",
    "null",
    "bad json",
  ])("refuses model arguments: %s", async (args) => {
    const pad = client();
    const runner = new ScratchPadUsage(
      NO_TOOLS,
      pad as unknown as ScratchPadClient,
    );
    expect(
      JSON.parse(await runner.call("scratchpad_usage", args, "call-1")).status,
    ).toBe("invalid");
    expect(pad.calls).toBe(0);
  });
  it("does not leak raw errors, preserves authority codes and declines unsupported capabilities", async () => {
    const pad = client();
    const runner = new ScratchPadUsage(
      NO_TOOLS,
      pad as unknown as ScratchPadClient,
    );
    for (const error of [
      new Error("PRIVATE_PATH"),
      new NativeScratchPadError("fenced", "PRIVATE_PATH"),
    ]) {
      pad.error = error;
      const reply = await runner.call("scratchpad_usage", "{}", "call-1");
      expect(JSON.parse(reply)).toEqual({
        status: "error",
        code: error instanceof NativeScratchPadError ? "fenced" : "unavailable",
      });
      expect(reply).not.toContain("PRIVATE");
    }
    expect(new ScratchPadUsage(NO_TOOLS).definitions).toEqual([]);
  });
});
