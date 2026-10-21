// The command's arguments, help and usage errors, without a server.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEOUT_S,
  EXIT_OK,
  EXIT_USAGE,
  parseCommand,
  runCommand,
} from "../../src/command.js";
import { recordingIO } from "../support/command-io.js";

describe("parseCommand", () => {
  it("reads agents with its flags", () => {
    expect(parseCommand(["agents", "--creds", "a.creds", "--url=nats://x:4222", "--json"])).toEqual(
      {
        kind: "agents",
        creds: "a.creds",
        url: "nats://x:4222",
        timeoutS: DEFAULT_TIMEOUT_S,
        json: true,
      },
    );
  });

  it("reads prompt: the agent, the text joined, flags anywhere", () => {
    expect(parseCommand(["prompt", "--timeout", "5", "writer", "say", "hello"])).toEqual({
      kind: "prompt",
      who: "writer",
      text: "say hello",
      timeoutS: 5,
      json: false,
    });
  });

  it("takes everything after -- as the text", () => {
    expect(parseCommand(["prompt", "writer", "--", "-5", "--json"])).toMatchObject({
      who: "writer",
      text: "-5 --json",
      json: false,
    });
  });

  it("asks for help", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["prompt", "-h"])).toEqual({ kind: "help" });
    expect(parseCommand(["help"])).toEqual({ kind: "help" });
  });

  it.each([
    [[], "name a command: agents or prompt"],
    [["deploy"], 'unknown command "deploy"'],
    [["agents", "extra"], 'agents takes no arguments, not "extra"'],
    [["prompt", "writer"], "prompt needs an agent and a text"],
    [["prompt", "writer", "hi", "--verbose"], "unknown option --verbose"],
    [["agents", "--creds"], "--creds needs a value"],
    [
      ["prompt", "w", "t", "--timeout", "soon"],
      '--timeout must be a positive number of seconds, not "soon"',
    ],
    [["prompt", "w", "t", "--timeout", "0"], "--timeout must be a positive number of seconds"],
  ])("refuses %j", (argv, message) => {
    const parsed = parseCommand(argv);
    expect(parsed.kind).toBe("usage");
    expect(parsed.kind === "usage" ? parsed.message : "").toContain(message);
  });
});

describe("runCommand without a server", () => {
  it("prints the help on stdout and exits 0", async () => {
    const io = recordingIO();
    expect(await runCommand(["--help"], io)).toBe(EXIT_OK);
    expect(io.stdout()).toContain("usage: agent-fabric agents");
  });

  it("exits 2 on a usage error, with the usage on stderr", async () => {
    const io = recordingIO();
    expect(await runCommand(["deploy"], io)).toBe(EXIT_USAGE);
    expect(io.stderr()).toContain('agent-fabric: unknown command "deploy"');
    expect(io.stderr()).toContain("usage: agent-fabric agents");
  });

  it("exits 2 without a creds file", async () => {
    const io = recordingIO({ NATS_URL: "nats://127.0.0.1:1" });
    expect(await runCommand(["agents"], io)).toBe(EXIT_USAGE);
    expect(io.stderr()).toContain("no creds file: pass --creds, or set NATS_CREDS");
  });

  it("exits 2 without a URL, naming where it comes from", async () => {
    const io = recordingIO({ NATS_CREDS: "a.creds" });
    expect(await runCommand(["agents"], io)).toBe(EXIT_USAGE);
    expect(io.stderr()).toContain("the URL the console showed next to your creds file");
  });
});
