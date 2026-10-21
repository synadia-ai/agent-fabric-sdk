// A prompt that fails before it goes out: its root rejects, and the command
// still ends with its one line, never an unhandled rejection. The caller is
// replaced, so the failure happens where it would on the wire: at the
// stream's first iteration, before any root.

import { describe, expect, it, vi } from "vitest";
import type * as CallerModule from "../../src/caller.js";
import { recordingIO } from "../support/command-io.js";

vi.mock("../../src/caller.js", async (importOriginal) => {
  const real = await importOriginal<typeof CallerModule>();
  return {
    ...real,
    fabricCaller: () =>
      Promise.resolve({
        find: () =>
          Promise.resolve({
            promptSubject: "agents.prompt.writer.demo.s",
            identity: undefined,
            idSigVerified: false,
            agent: "writer",
            description: "",
          }),
        prompt: () => {
          const rootId = Promise.reject(new real.FabricCallerError("not-sent", "never sent"));
          rootId.catch(() => {});
          return Promise.resolve({
            rootId,
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () => Promise.reject(new Error("refused before it went out")),
              }),
            },
          });
        },
        close: () => Promise.resolve(),
      }),
  };
});

const { EXIT_FAILED, runCommand } = await import("../../src/command.js");

describe("a prompt that never goes out", () => {
  it("ends with one line and exit 1, its root's rejection handled", async () => {
    const io = recordingIO({ NATS_CREDS: "a.creds", NATS_URL: "nats://127.0.0.1:1" });
    expect(await runCommand(["prompt", "writer", "hi"], io)).toBe(EXIT_FAILED);
    // Let any unhandled rejection surface before the test ends.
    await new Promise((r) => setTimeout(r, 50));
    expect(io.stderr()).toContain("agent-fabric: no reply: refused before it went out\n");
    expect(io.stderr()).not.toContain("root ");
  });
});
