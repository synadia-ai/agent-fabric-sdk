// The command over a replaced caller. A prompt that fails before it goes
// out: its root rejects, and the command still ends with its one line,
// never an unhandled rejection; the failure happens where it would on the
// wire, at the stream's first iteration, before any root. And `agents`
// lists in code-point order, as the Python command does.

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
        list: () =>
          Promise.resolve(
            ["agents.prompt.b", "agents.prompt.a_x", "agents.prompt.B", "agents.prompt.a-x"].map(
              (promptSubject) => ({
                promptSubject,
                agent: "k",
                identity: undefined,
                idSigVerified: false,
                description: "",
              }),
            ),
          ),
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

describe("agents", () => {
  it("lists by code point, the Python command's order", async () => {
    const io = recordingIO({ NATS_CREDS: "a.creds", NATS_URL: "nats://127.0.0.1:1" });
    await runCommand(["agents", "--json"], io);
    const order = (JSON.parse(io.stdout()) as Array<{ address: string }>).map((a) => a.address);
    expect(order).toEqual([
      "agents.prompt.B",
      "agents.prompt.a-x",
      "agents.prompt.a_x",
      "agents.prompt.b",
    ]);
  });
});
