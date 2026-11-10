// The command over a replaced caller. A prompt that fails before it goes
// out: its root rejects, and the command still ends with its one line,
// never an unhandled rejection; the failure happens where it would on the
// wire, at the stream's first iteration, before any root. `agents` lists in
// code-point order, as the Python command does, with each agent's
// description under its row, as one line of plain text. And `prompt` prints
// what the agents registered, an address or an identity, as plain text too.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@synadia-ai/agents";
import type * as CallerModule from "../../src/caller.js";
import { recordingIO } from "../support/command-io.js";

/** One agent as discovery hands it to the command. */
interface Listed {
  readonly promptSubject: string;
  readonly agent: string;
  readonly identity: string | undefined;
  readonly idSigVerified: boolean;
  readonly description: string | undefined;
}

// What the replaced caller lists, finds and is told; each test sets it.
const world = vi.hoisted(() => ({
  agents: [] as Listed[],
  // The agent `find` returns. Unset, `find` picks from `agents` by the
  // caller's own rule, and fails as the caller does.
  target: undefined as Listed | undefined,
  // What the agent says when it refuses the prompt.
  refusal: "",
}));

vi.mock("../../src/caller.js", async (importOriginal) => {
  const real = await importOriginal<typeof CallerModule>();
  return {
    ...real,
    fabricCaller: () =>
      Promise.resolve({
        find: (who: string) =>
          Promise.resolve().then(
            () => world.target ?? real.pickAgent(world.agents as unknown as Agent[], who),
          ),
        prompt: () => {
          const rootId = Promise.reject(new real.FabricCallerError("not-sent", "never sent"));
          rootId.catch(() => {});
          return Promise.resolve({
            rootId,
            stream: {
              [Symbol.asyncIterator]: () => ({
                next: () => Promise.reject(new Error(world.refusal)),
              }),
            },
          });
        },
        list: () => Promise.resolve(world.agents),
        close: () => Promise.resolve(),
      }),
  };
});

const { FabricCallerError, pickAgent } = await import("../../src/caller.js");
const { EXIT_FAILED, EXIT_OK, runCommand } = await import("../../src/command.js");

const ENV = { NATS_CREDS: "a.creds", NATS_URL: "nats://127.0.0.1:1" };

const WRITER: Listed = {
  promptSubject: "agents.prompt.writer.demo.s",
  agent: "writer",
  identity: undefined,
  idSigVerified: false,
  description: "",
};

beforeEach(() => {
  world.agents = [];
  world.target = WRITER;
  world.refusal = "refused before it went out";
});

/** An agent of kind `k` that registered no identity. */
function listed(promptSubject: string, description?: string): Listed {
  return { promptSubject, agent: "k", identity: undefined, idSigVerified: false, description };
}

describe("a prompt that never goes out", () => {
  it("ends with one line and exit 1, its root's rejection handled", async () => {
    const io = recordingIO(ENV);
    expect(await runCommand(["prompt", "writer", "hi"], io)).toBe(EXIT_FAILED);
    // Let any unhandled rejection surface before the test ends.
    await new Promise((r) => setTimeout(r, 50));
    expect(io.stderr()).toContain("agent-fabric: no reply: refused before it went out\n");
    expect(io.stderr()).not.toContain("root ");
  });
});

// An address, a kind and an identity are text the agents registered, and a
// refusal's few words are the agent's own. `prompt` prints them on stderr,
// which is a terminal more often than not.
describe("prompt, what an agent registered or said", () => {
  const ESC = String.fromCharCode(0x1b);
  const OVERRIDE = String.fromCodePoint(0x202e); // right-to-left override
  const HALF = String.fromCharCode(0xdc80); // half a character
  const CLEAR = `${ESC}[2J`; // the escape sequence that clears the screen

  it("prints the agent's address and identity as plain text", async () => {
    world.target = {
      ...WRITER,
      promptSubject: `agents.prompt.w${CLEAR}.demo\n.s${HALF}`,
      identity: `ACCOUNT${OVERRIDE}.USER`,
      idSigVerified: true,
    };
    const io = recordingIO(ENV);
    expect(await runCommand(["prompt", "writer", "hi"], io)).toBe(EXIT_FAILED);
    expect(io.stderr()).toContain(
      `→ agents.prompt.w [2J.demo .s${String.fromCodePoint(0xfffd)} (agent ACCOUNT .USER, verified)\n`,
    );
    expect(io.stderr()).not.toContain(ESC);
  });

  it("prints a refusal's words as plain text, on one line", async () => {
    world.refusal = `service error 500: no${CLEAR}\nroot 0123`;
    const io = recordingIO(ENV);
    expect(await runCommand(["prompt", "writer", "hi"], io)).toBe(EXIT_FAILED);
    expect(io.stderr()).toBe(
      "url nats://127.0.0.1:1\n" +
        "→ agents.prompt.writer.demo.s (agent identity: none)\n" +
        "agent-fabric: no reply: service error 500: no [2J root 0123\n",
    );
  });

  describe("naming the agents that are there", () => {
    const there = [
      { ...WRITER, promptSubject: `agents.prompt.a${CLEAR}.demo.s`, agent: "k" },
      { ...WRITER, promptSubject: "agents.prompt.b\t.demo.s", agent: "k" },
    ];

    beforeEach(() => {
      world.agents = there;
      world.target = undefined;
    });

    it("prints every address as plain text when no agent is found", async () => {
      const io = recordingIO(ENV);
      expect(await runCommand(["prompt", "nosuch", "hi"], io)).toBe(EXIT_FAILED);
      expect(io.stderr()).toBe(
        "url nats://127.0.0.1:1\n" +
          'agent-fabric: no agent "nosuch"; there: agents.prompt.a [2J.demo.s, agents.prompt.b .demo.s\n',
      );
    });

    it("prints every address as plain text when a kind names several", async () => {
      const io = recordingIO(ENV);
      expect(await runCommand(["prompt", "k", "hi"], io)).toBe(EXIT_FAILED);
      expect(io.stderr()).toBe(
        "url nats://127.0.0.1:1\n" +
          'agent-fabric: 2 agents of kind "k": agents.prompt.a [2J.demo.s, agents.prompt.b .demo.s; name one by its address\n',
      );
    });

    it("leaves the error a program catches as it is: the addresses as they were registered", () => {
      let caught: unknown;
      try {
        pickAgent(there as unknown as Agent[], "nosuch");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FabricCallerError);
      expect((caught as Error).message).toBe(
        `no agent "nosuch"; there: agents.prompt.a${CLEAR}.demo.s, agents.prompt.b\t.demo.s`,
      );
    });
  });
});

describe("agents", () => {
  // Three emoji held together by two zero width joiners, which stay.
  const FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const DIRTY = `Writes two\tlines.\n\u001b[31mNever more. ${FAMILY}`;
  const LOGS = "Keeps the logs of the orders server. Ask it what happened in a time range.";

  beforeEach(() => {
    // What each agent registered as its description; one registered none.
    world.agents = [
      listed("agents.prompt.b", DIRTY),
      listed("agents.prompt.a_x", LOGS),
      listed("agents.prompt.B"),
      listed("agents.prompt.a-x", " \n "),
    ];
  });

  it("lists by code point, the Python command's order", async () => {
    const io = recordingIO(ENV);
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
    const io = recordingIO(ENV);
    expect(await runCommand(["agents"], io)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(
      "agents.prompt.B\tk\tagent identity: none\n" +
        // No description, or nothing left of one: no line.
        "agents.prompt.a-x\tk\tagent identity: none\n" +
        "agents.prompt.a_x\tk\tagent identity: none\n" +
        `\t${LOGS}\n` +
        "agents.prompt.b\tk\tagent identity: none\n" +
        // A line break, a tab and an escape sequence's control character: spaces.
        // The joiners inside the emoji stay, so it stays one emoji.
        `\tWrites two lines. [31mNever more. ${FAMILY}\n`,
    );
  });

  it("leaves the description as it was registered in --json", async () => {
    const io = recordingIO(ENV);
    await runCommand(["agents", "--json"], io);
    const all = JSON.parse(io.stdout()) as Array<{ address: string; description?: string }>;
    expect(all.map((a) => a.description)).toEqual([undefined, " \n ", LOGS, DIRTY]);
  });

  // Half a character: a text cut inside an emoji ends in one. A program that
  // writes UTF-8 cannot print it, and the Python command stopped the list
  // there. Both commands print U+FFFD in its place, and every agent.
  it("lists every agent when a description holds half a character, with U+FFFD in its place", async () => {
    world.agents = [
      listed("agents.prompt.a", "First."),
      listed("agents.prompt.b", `cut in an emoji ${String.fromCharCode(0xd83d)}`),
      listed("agents.prompt.c", "Third."),
    ];
    const io = recordingIO(ENV);
    expect(await runCommand(["agents"], io)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(
      "agents.prompt.a\tk\tagent identity: none\n" +
        "\tFirst.\n" +
        "agents.prompt.b\tk\tagent identity: none\n" +
        `\tcut in an emoji ${String.fromCodePoint(0xfffd)}\n` +
        "agents.prompt.c\tk\tagent identity: none\n" +
        "\tThird.\n",
    );
  });

  it("writes half a character as its escape in --json, the bytes the Python command writes", async () => {
    world.agents = [listed("agents.prompt.b", `cut in an emoji ${String.fromCharCode(0xd83d)}`)];
    const io = recordingIO(ENV);
    expect(await runCommand(["agents", "--json"], io)).toBe(EXIT_OK);
    expect(io.stdout()).toBe(
      '[{"address":"agents.prompt.b","kind":"k","identity":null,"verified":false,' +
        '"description":"cut in an emoji \\ud83d"}]\n',
    );
  });

  // The kind, the address and the identity are text an agent registered too:
  // `metadata.agent` is as free as the description.
  describe("the row's own fields", () => {
    const ESC = String.fromCharCode(0x1b);
    const OVERRIDE = String.fromCodePoint(0x202e); // right-to-left override
    const HALF = String.fromCharCode(0xdc80); // half a character
    const KIND = `wri${ESC}[31mter\tk2`;

    beforeEach(() => {
      world.agents = [
        {
          promptSubject: "agents.prompt.w\nx",
          agent: KIND,
          identity: `ACCOUNT${OVERRIDE}.USER`,
          idSigVerified: true,
          description: "Writes.",
        },
        { ...listed("agents.prompt.z", "Last."), agent: `half${HALF}` },
      ];
    });

    it("are printed as plain text: an escape character in the kind does not reach the terminal", async () => {
      const io = recordingIO(ENV);
      expect(await runCommand(["agents"], io)).toBe(EXIT_OK);
      expect(io.stdout()).toBe(
        // The escape character and the tab in the kind, the line break in the
        // address, the override in the identity: a space each, nothing cut.
        "agents.prompt.w x\twri [31mter k2\tagent ACCOUNT .USER, verified\n" +
          "\tWrites.\n" +
          `agents.prompt.z\thalf${String.fromCodePoint(0xfffd)}\tagent identity: none\n` +
          "\tLast.\n",
      );
    });

    it("are left as they were registered in --json", async () => {
      const io = recordingIO(ENV);
      expect(await runCommand(["agents", "--json"], io)).toBe(EXIT_OK);
      expect(JSON.parse(io.stdout())).toEqual([
        {
          address: "agents.prompt.w\nx",
          kind: KIND,
          identity: `ACCOUNT${OVERRIDE}.USER`,
          verified: true,
          description: "Writes.",
        },
        {
          address: "agents.prompt.z",
          kind: `half${HALF}`,
          identity: null,
          verified: false,
          description: "Last.",
        },
      ]);
    });
  });
});
