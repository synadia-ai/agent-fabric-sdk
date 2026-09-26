// `scratchPadFromEnv`: ScratchPad by configuration. An unset
// `SCRATCHPAD_VOLUME` is ScratchPad off; otherwise the four variables and
// the agent's own connection become the `sp` calls `spCliScratchPad` makes,
// seen through the stand-in CLI (`../harness/fake-sp.mjs`).

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scratchPadFromEnv } from "../../src/index.js";

const FAKE_SP = fileURLToPath(new URL("../harness/fake-sp.mjs", import.meta.url));
const TRACE = { threadId: "1".repeat(32), rootId: "2".repeat(32) };
const GRANTEE = { account: `A${"B".repeat(55)}`, user: `U${"C".repeat(55)}` };

describe("ScratchPad from the environment", () => {
  let dir: string;
  let log: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabric-sp-env-"));
    log = join(dir, "calls.jsonl");
    process.env["FAKE_SP_LOG"] = log;
    process.env["FAKE_SP_STATE"] = join(dir, "state.json");
    process.env["FAKE_SP_VOLUME"] = "env-replies";
  });

  afterAll(async () => {
    delete process.env["FAKE_SP_LOG"];
    delete process.env["FAKE_SP_STATE"];
    delete process.env["FAKE_SP_VOLUME"];
    await rm(dir, { recursive: true, force: true });
  });

  it("is off when SCRATCHPAD_VOLUME is unset or empty", () => {
    expect(scratchPadFromEnv({})).toBeUndefined();
    expect(
      scratchPadFromEnv({ SCRATCHPAD_VOLUME: "", NATS_CREDS: "/nowhere/agent.creds" }),
    ).toBeUndefined();
    // Off means nothing else is read: a bad TTL without a volume is no error.
    expect(scratchPadFromEnv({ SCRATCHPAD_GRANT_TTL_S: "soon" })).toBeUndefined();
  });

  it("reads the four variables and the agent's credentials", async () => {
    await writeFile(log, "");
    const pad = scratchPadFromEnv(
      {
        SCRATCHPAD_VOLUME: "env-replies",
        SCRATCHPAD_BIN: FAKE_SP,
        SCRATCHPAD_DIR: join(dir, "work"),
        SCRATCHPAD_GRANT_TTL_S: "42",
        NATS_URL: "nats://10.0.0.1:4222",
        NATS_CREDS: "/nowhere/agent.creds",
      },
      { creator: "agents.prompt.assistant.test.main" },
    );
    expect(pad).toBeDefined();
    const before = Math.floor(Date.now() / 1000);
    const reference = await pad!.commit("hello", "/replies/env.md", TRACE);
    await pad!.grantRead(reference, GRANTEE, TRACE);
    const calls = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
    const flag = (argv: string[], name: string): string | undefined => {
      const i = argv.indexOf(`-${name}`);
      return i < 0 ? undefined : argv[i + 1];
    };
    // SCRATCHPAD_BIN: the calls reached the stand-in. The volume by name, the
    // credentials the agent connects with, on every call.
    expect(calls.map((a) => a.filter((w) => !w.startsWith("-"))[0])).toEqual([
      "volume",
      "session",
      "put",
      "commit",
      "ref",
      "grant",
    ]);
    for (const argv of calls) {
      expect(flag(argv, "url")).toBe("nats://10.0.0.1:4222");
      expect(flag(argv, "creds")).toBe("/nowhere/agent.creds");
    }
    // SCRATCHPAD_DIR, by its real path.
    expect(flag(calls[1]!, "save")!.startsWith(join(await realpath(dir), "work") + "/")).toBe(true);
    // SCRATCHPAD_GRANT_TTL_S.
    const expires = Number(flag(calls[5]!, "expires-at"));
    expect(expires).toBeGreaterThanOrEqual(before + 42);
    expect(expires).toBeLessThanOrEqual(before + 44);
    // The creator went into the token.
    const made = JSON.parse(
      Buffer.from(reference.slice("sp-ref:".length), "base64url").toString(),
    ) as { creator?: string };
    expect(made.creator).toBe("agents.prompt.assistant.test.main");
  });

  it("connects by NATS context when one is named", async () => {
    await writeFile(log, "");
    const pad = scratchPadFromEnv({
      SCRATCHPAD_VOLUME: "env-replies",
      SCRATCHPAD_BIN: FAKE_SP,
      SCRATCHPAD_DIR: join(dir, "work-context"),
      NATS_CONTEXT: "fabric",
      NATS_CREDS: "/nowhere/agent.creds",
    });
    await pad!.owns(`sp-ref:${Buffer.from('{"ref":{"volume_id":"v"}}').toString("base64url")}`);
    const [argv] = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
    expect(argv).toEqual(["volume", "list", "-context", "fabric", "-json"]);
  });

  it("refuses a connection sp cannot use, and a TTL that is not a positive number", () => {
    expect(() => scratchPadFromEnv({ SCRATCHPAD_VOLUME: "v" })).toThrow(
      /NATS_CREDS or NATS_CONTEXT/,
    );
    expect(() =>
      scratchPadFromEnv({ SCRATCHPAD_VOLUME: "v", NATS_CREDS: "/c", SCRATCHPAD_GRANT_TTL_S: "0" }),
    ).toThrow(/SCRATCHPAD_GRANT_TTL_S must be a positive number/);
  });
});
