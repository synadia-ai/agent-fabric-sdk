// The startup line's ScratchPad state: the client the agent built, never
// one variable. `fabric env` sets SCRATCHPAD_BOOTSTRAP_FILE and
// SCRATCHPAD_DIR, not SCRATCHPAD_VOLUME, so a line read from
// SCRATCHPAD_VOLUME alone said "off" for an agent whose replies carried
// ScratchPad references.

import { nativeScratchPadFromEnv } from "@synadia-ai/agent-fabric";
import { describe, expect, it } from "vitest";
import { scratchpadLine } from "../src/agent.js";

describe("the startup line's ScratchPad state", () => {
  it("the bootstrap file alone turns ScratchPad on; neither variable leaves it off", async () => {
    // With a bootstrap file and no volume, the factory builds a client: it
    // gets as far as asking for the workspace directory.
    await expect(
      nativeScratchPadFromEnv({ SCRATCHPAD_BOOTSTRAP_FILE: "/agent/scratchpad/bootstrap.json" }, { creator: "agents.prompt.assistant.o.a", nc: {} as never }),
    ).rejects.toThrow(/SCRATCHPAD_DIR/);
    await expect(nativeScratchPadFromEnv({}, { creator: "agents.prompt.assistant.o.a", nc: {} as never })).resolves.toBeUndefined();
  });

  it("says on for an agent with a client, whichever variable configured it", () => {
    expect(scratchpadLine(true, { SCRATCHPAD_BOOTSTRAP_FILE: "/agent/scratchpad/bootstrap.json", SCRATCHPAD_DIR: "/agent/scratchpad" })).toBe("on");
    expect(scratchpadLine(true, { SCRATCHPAD_VOLUME: "AssistantReplies" })).toBe("on (volume AssistantReplies)");
  });

  it("says off for an agent without one, even when a variable is set", () => {
    expect(scratchpadLine(false, {})).toBe("off");
    expect(scratchpadLine(false, { SCRATCHPAD_VOLUME: "AssistantReplies" })).toBe("off");
  });
});
