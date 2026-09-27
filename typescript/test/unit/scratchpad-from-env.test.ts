// `scratchPadFromEnv`: ScratchPad by configuration. An unset
// `SCRATCHPAD_VOLUME` is ScratchPad off; otherwise the four variables and
// the agent's own connection become the `sp` calls `spCliScratchPad` makes,
// seen through the stand-in CLI (`../harness/fake-sp.mjs`). The same test
// as the Python package's `test_scratchpad_from_env.py`.

import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { referenceCreator, scratchPadFromEnv } from "../../src/index.js";

const FAKE_SP = fileURLToPath(new URL("../harness/fake-sp.mjs", import.meta.url));
const TRACE = { threadId: "1".repeat(32), rootId: "2".repeat(32) };
// In the stand-in's own account: `sp` grants only within the reference's account.
const GRANTEE = { account: `A${"O".repeat(55)}`, user: `U${"C".repeat(55)}` };

describe("ScratchPad from the environment", () => {
  let dir: string;
  let log: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabric-sp-env-"));
    log = join(dir, "calls.jsonl");
    process.env["FAKE_SP_LOG"] = log;
    process.env["FAKE_SP_STATE"] = join(dir, "state.json");
  });

  afterAll(async () => {
    delete process.env["FAKE_SP_LOG"];
    delete process.env["FAKE_SP_STATE"];
    await rm(dir, { recursive: true, force: true });
  });

  const argvs = async (): Promise<string[][]> =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { argv: string[] }).argv);
  const flag = (argv: string[], name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i < 0 ? undefined : argv[i + 1];
  };

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
        SCRATCHPAD_VOLUME: "EnvReplies",
        SCRATCHPAD_BIN: FAKE_SP,
        SCRATCHPAD_DIR: join(dir, "work"),
        SCRATCHPAD_GRANT_TTL_S: "42",
        NATS_URL: "nats://10.0.0.1:4222",
        NATS_CREDS: "/nowhere/agent.creds",
      },
      { creator: "agents.prompt.assistant.test.main" },
    );
    expect(pad).toBeDefined();
    const reference = await pad!.commit("hello", "/replies/env.md", TRACE);
    await pad!.grantRead(reference, GRANTEE, TRACE);
    const calls = await argvs();
    // SCRATCHPAD_BIN: the calls reached the stand-in. The credentials the
    // agent connects with and its workspace, on every call; the volume by
    // name.
    expect(calls.map((a) => a[0])).toEqual(["init", "recover", "publish-file", "grant"]);
    for (const argv of calls) {
      expect(flag(argv, "url")).toBe("nats://10.0.0.1:4222");
      expect(flag(argv, "creds")).toBe("/nowhere/agent.creds");
      expect(flag(argv, "volume")).toBe("EnvReplies");
      // SCRATCHPAD_DIR, by its real path.
      expect(flag(argv, "dir")).toBe(join(await realpath(dir), "work"));
    }
    // SCRATCHPAD_GRANT_TTL_S.
    expect(flag(calls[3]!, "ttl-seconds")).toBe("42");
    // The creator went into the token.
    expect(flag(calls[2]!, "creator")).toBe("agents.prompt.assistant.test.main");
    expect(referenceCreator(reference)).toBe("agents.prompt.assistant.test.main");
  });

  it("uses the credentials file when a NATS context is named beside it", async () => {
    await writeFile(log, "");
    const pad = scratchPadFromEnv(
      {
        SCRATCHPAD_VOLUME: "EnvReplies",
        SCRATCHPAD_BIN: FAKE_SP,
        SCRATCHPAD_DIR: join(dir, "work-context"),
        NATS_CONTEXT: "fabric",
        NATS_CREDS: "/nowhere/agent.creds",
      },
      { creator: "agents.prompt.assistant.test.main" },
    );
    await pad!.commit("x", "/replies/x.md", TRACE);
    const [argv] = await argvs();
    expect(flag(argv!, "url")).toBe("nats://127.0.0.1:4222");
    expect(flag(argv!, "creds")).toBe("/nowhere/agent.creds");
    expect(argv).not.toContain("--context");
  });

  it("refuses a connection sp cannot use, and a TTL that is not a positive number", () => {
    // sp v2 reads no NATS context, and takes no nkey seed alone.
    for (const env of [
      { SCRATCHPAD_VOLUME: "v" },
      { SCRATCHPAD_VOLUME: "v", NATS_CONTEXT: "fabric" },
    ]) {
      expect(() => scratchPadFromEnv(env)).toThrow(
        /needs NATS_URL and NATS_CREDS; a NATS context or an nkey seed alone is not supported/,
      );
    }
    expect(() =>
      scratchPadFromEnv({ SCRATCHPAD_VOLUME: "v", NATS_CREDS: "/c", SCRATCHPAD_GRANT_TTL_S: "0" }),
    ).toThrow(/SCRATCHPAD_GRANT_TTL_S must be a positive number/);
  });
});
