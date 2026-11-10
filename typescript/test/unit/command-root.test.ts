// The command over a replaced caller. A prompt that fails before it goes
// out: its root rejects, and the command still ends with its one line,
// never an unhandled rejection; the failure happens where it would on the
// wire, at the stream's first iteration, before any root. And `agents`
// lists in code-point order, as the Python command does, with each agent's
// description under its row, as one line of plain text.

import { describe, expect, it, vi } from "vitest";
import type * as CallerModule from "../../src/caller.js";
import { recordingIO } from "../support/command-io.js";

// What each listed agent registered as its description; one registered none.
const DESCRIPTIONS: Record<string, string | undefined> = vi.hoisted(() => ({
  "agents.prompt.b": "Writes two\tlines.\n\u001b[31mNever more.",
  "agents.prompt.a_x": "Keeps the logs of the orders server. Ask it what happened in a time range.",
  "agents.prompt.B": undefined,
  "agents.prompt.a-x": " \n ",
}));

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
                description: DESCRIPTIONS[promptSubject],
              }),
            ),
          ),
        close: () => Promise.resolve(),
      }),
  };
});

const { EXIT_FAILED, EXIT_OK, runCommand } = await import("../../src/command.js");

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

  it("prints each description under its row, after a tab, as one line of plain text", async () => {
    const io = recordingIO({ NATS_CREDS: "a.creds", NATS_URL: "nats://127.0.0.1:1" });
    expect(await runCommand(["agents"], io)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(
      "agents.prompt.B\tk\tagent identity: none\n" +
        // No description, or nothing left of one: no line.
        "agents.prompt.a-x\tk\tagent identity: none\n" +
        "agents.prompt.a_x\tk\tagent identity: none\n" +
        "\tKeeps the logs of the orders server. Ask it what happened in a time range.\n" +
        "agents.prompt.b\tk\tagent identity: none\n" +
        // A line break, a tab and an escape sequence's control character: spaces.
        "\tWrites two lines. [31mNever more.\n",
    );
  });

  it("leaves the description as it was registered in --json", async () => {
    const io = recordingIO({ NATS_CREDS: "a.creds", NATS_URL: "nats://127.0.0.1:1" });
    await runCommand(["agents", "--json"], io);
    const listed = JSON.parse(io.stdout()) as Array<{ address: string; description?: string }>;
    expect(listed.map((a) => a.description)).toEqual([
      undefined,
      " \n ",
      "Keeps the logs of the orders server. Ask it what happened in a time range.",
      "Writes two\tlines.\n\u001b[31mNever more.",
    ]);
  });
});
