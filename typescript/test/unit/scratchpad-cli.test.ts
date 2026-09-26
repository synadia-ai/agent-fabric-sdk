// The ScratchPad wrapper against a stand-in for the `sp` command line
// (`../harness/fake-sp.mjs`): what the wrapper asks the CLI to do, in which
// order, with which flags. The real ScratchPad was measured by hand
// (`agent-fabric-examples` `docs/findings.md` F6, the PLAN log); this pins
// the calls down so a change in the wrapper shows up in `npm test`. Moved
// here with the wrapper from `agent-fabric-examples` `agents/ts` at `1ed3c45`.
//
// The grant is the point: on a reference into the agent's own volume, one
// `grant issue` to one principal, read only, on the one path, with an
// expiry, and a line in the ledger of whom this agent granted what; on a
// reference into someone else's volume, nothing: no read, no copy, no
// grant. Only the creator grants (`grant-request.test.ts`). The wrapper is
// the `ScratchPad` port with a commit and a read, `spCliScratchPad`; the
// vocabulary of references is tested in `scratchpad-vocabulary.test.ts`.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { referenceCreator, spCliScratchPad, type ScratchPadClient } from "../../src/index.js";

const FAKE_SP = fileURLToPath(new URL("../harness/fake-sp.mjs", import.meta.url));
const TRACE = { threadId: "1".repeat(32), rootId: "2".repeat(32) };
const GRANTEE = { account: `A${"B".repeat(55)}`, user: `U${"C".repeat(55)}` };

interface Call {
  readonly argv: string[];
  readonly stdin: string | null;
}

/** The verb of a call and its `-flag value` pairs. */
function parse(call: Call): { verb: string; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {};
  const words: string[] = [];
  for (let i = 0; i < call.argv.length; i++) {
    const a = call.argv[i]!;
    if (a.startsWith("-")) {
      if (a === "-json" || a === "-apply") flags[a.slice(1)] = true;
      else flags[a.slice(1)] = call.argv[++i]!;
    } else words.push(a);
  }
  return { verb: words.join(" "), flags };
}

function decode(reference: string): {
  ref: Record<string, unknown>;
  source_sequence: number;
  creator?: string;
} {
  return JSON.parse(
    Buffer.from(reference.slice("sp-ref:".length), "base64url").toString(),
  ) as never;
}

/** A token as another agent would hand it over: into a volume that is not ours. */
function foreignReference(path: string): string {
  const made = {
    ref: {
      type: "handoff",
      handoff_id: "hnd-theirs",
      volume_id: "vol-other",
      root: "root-x",
      path,
      expires_at: 9e9,
    },
    source_sequence: 3,
  };
  return `sp-ref:${Buffer.from(JSON.stringify(made)).toString("base64url")}`;
}

describe("the ScratchPad wrapper over the sp command line", () => {
  let dir: string;
  let log: string;
  let pad: ScratchPadClient;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabric-examples-sp-"));
    log = join(dir, "calls.jsonl");
    process.env["FAKE_SP_LOG"] = log;
    process.env["FAKE_SP_STATE"] = join(dir, "state.json");
    process.env["FAKE_SP_VOLUME"] = "test-replies";
    delete process.env["FAKE_SP_DENY_VOLUME"];
    pad = spCliScratchPad({
      bin: FAKE_SP,
      dir: join(dir, "work"),
      volume: "test-replies",
      nats: { url: "nats://127.0.0.1:4222", creds: "/nowhere/agent.creds" },
      grantTtlS: 60,
      creator: "agents.prompt.assistant.test.main",
    });
  });

  afterAll(async () => {
    delete process.env["FAKE_SP_LOG"];
    delete process.env["FAKE_SP_STATE"];
    delete process.env["FAKE_SP_VOLUME"];
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await writeFile(log, "");
  });

  async function calls(): Promise<ReturnType<typeof parse>[]> {
    const text = await readFile(log, "utf8");
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => parse(JSON.parse(l) as Call));
  }

  it("commits through a session, a put, a commit and a ref, every call on the served thread", async () => {
    const reference = await pad.commit("hello", "/replies/t1.md", TRACE);
    expect(reference.startsWith("sp-ref:")).toBe(true);
    const made = decode(reference);
    expect(made.ref).toMatchObject({ volume_id: "vol-own", path: "/replies/t1.md" });
    expect(made.source_sequence).toBe(7);
    // The token names the agent that made it, so whoever is handed it knows whom to ask.
    expect(made.creator).toBe("agents.prompt.assistant.test.main");
    expect(referenceCreator(reference)).toBe("agents.prompt.assistant.test.main");

    const seen = await calls();
    expect(seen.map((c) => c.verb)).toEqual([
      "volume list",
      "session open",
      "put",
      "commit",
      "ref make",
    ]);
    for (const c of seen) {
      // The agent's own credentials, the served thread, machine-readable output.
      expect(c.flags).toMatchObject({
        url: "nats://127.0.0.1:4222",
        creds: "/nowhere/agent.creds",
        "thread-id": TRACE.threadId,
        "root-id": TRACE.rootId,
        json: true,
      });
    }
    expect(seen[1]!.flags).toMatchObject({
      "volume-id": "vol-own",
      "base-root": "root-0",
      "write-scope": "/",
    });
    expect(seen[2]!.flags).toMatchObject({ path: "/replies/t1.md", source: "-" });
    expect(seen[3]!.flags["apply"]).toBe(true);
    expect(seen[4]!.flags).toMatchObject({ "volume-id": "vol-own", path: "/replies/t1.md" });
    // The content went in on stdin.
    const raw = (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
    expect(raw[2]!.stdin).toBe("hello");
  });

  it("reads by resolving the reference, then cat", async () => {
    const reference = await pad.commit("what was committed", "/replies/t2.md", TRACE);
    await writeFile(log, "");
    expect(await pad.read(reference, TRACE)).toBe("what was committed");
    const seen = await calls();
    expect(seen.map((c) => c.verb)).toEqual(["ref resolve", "cat"]);
    expect(seen[1]!.flags).toMatchObject({ "volume-id": "vol-own", path: "/replies/t2.md" });
    // The CLI gets back what `ref.make` replied, without the token's `creator`.
    const resolved = JSON.parse(await readFile(String(seen[0]!.flags["ref"]), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(resolved).sort()).toEqual(["ref", "source_sequence"]);
  });

  it("grants read on a reference into its own volume: one principal, one path, read, an expiry", async () => {
    const reference = await pad.commit("mine", "/replies/t3.md", TRACE);
    await writeFile(log, "");
    const before = Math.floor(Date.now() / 1000);
    expect(await pad.owns(reference)).toBe(true);
    expect(pad.granted(reference, GRANTEE)).toBeUndefined();
    await pad.grantRead(reference, GRANTEE, TRACE, "call_7");
    const seen = await calls();
    expect(seen.map((c) => c.verb)).toEqual(["grant issue"]);
    const { flags } = seen[0]!;
    expect(flags).toMatchObject({
      "volume-id": "vol-own",
      "grantee-account": GRANTEE.account,
      "grantee-user": GRANTEE.user,
      subtree: "/replies/t3.md",
      actions: "read",
      "thread-id": TRACE.threadId,
      "root-id": TRACE.rootId,
      "tool-call-id": "call_7",
    });
    expect(flags["scope-root"]).toBeUndefined();
    const expires = Number(flags["expires-at"]);
    expect(expires).toBeGreaterThanOrEqual(before + 60);
    expect(expires).toBeLessThanOrEqual(before + 62);
    expect(String(flags["operation-id"])).toMatch(/^[0-9a-f-]{36}$/);
    // The ledger: that principal, that reference, and nobody and nothing
    // else. A grant this agent makes of its own accord is first-hand.
    expect(pad.granted(reference, GRANTEE)).toBe("first-hand");
    expect(pad.granted(reference, { ...GRANTEE, user: `U${"D".repeat(55)}` })).toBeUndefined();
    expect(
      pad.granted(await pad.commit("other", "/replies/t3b.md", TRACE), GRANTEE),
    ).toBeUndefined();
  });

  it("keeps apart the grants it made first-hand and those it made on request", async () => {
    const reference = await pad.commit("mine", "/replies/t3d.md", TRACE);
    const other = { ...GRANTEE, user: `U${"E".repeat(55)}` };
    // Made because another agent asked: recorded as such, and the CLI call is the same.
    await writeFile(log, "");
    await pad.grantRead(reference, other, TRACE, "call_8", "on-request");
    expect(pad.granted(reference, other)).toBe("on-request");
    expect((await calls()).map((c) => c.verb)).toEqual(["grant issue"]);
    // A first-hand grant still running is not hidden by a later one made on request.
    await pad.grantRead(reference, GRANTEE, TRACE);
    await pad.grantRead(reference, GRANTEE, TRACE, undefined, "on-request");
    expect(pad.granted(reference, GRANTEE)).toBe("first-hand");
  });

  it("forgets a grant when it expires", async () => {
    const brief = spCliScratchPad({
      bin: FAKE_SP,
      dir: join(dir, "work-brief"),
      volume: "test-replies",
      nats: { url: "nats://127.0.0.1:4222", creds: "/nowhere/agent.creds" },
      grantTtlS: 0,
    });
    const reference = await brief.commit("soon gone", "/replies/t3c.md", TRACE);
    await brief.grantRead(reference, GRANTEE, TRACE);
    expect(brief.granted(reference, GRANTEE)).toBeUndefined();
  });

  it("grants nothing on a reference into someone else's volume, and neither reads nor copies it", async () => {
    const theirs = foreignReference("/replies/theirs.md");
    expect(await pad.owns(theirs)).toBe(false);
    await expect(pad.grantRead(theirs, GRANTEE, TRACE)).rejects.toThrow(
      /only its creator can grant/,
    );
    expect(pad.granted(theirs, GRANTEE)).toBeUndefined();
    // Not one call to ScratchPad: being handed content is not a right to pass it on.
    expect(await calls()).toEqual([]);
    expect(referenceCreator(theirs)).toBeUndefined();
  });

  it("refuses a token that does not decode or names no volume, without throwing", async () => {
    await pad.commit("mine", "/replies/t6.md", TRACE); // the wrapper knows its own volume
    const noRef = `sp-ref:${Buffer.from(JSON.stringify({ source_sequence: 3 })).toString("base64url")}`;
    const noVolumeId = `sp-ref:${Buffer.from(JSON.stringify({ ref: { root: "r" } })).toString("base64url")}`;
    for (const token of ["sp-ref:!!!not-base64url", "sp-ref:bm90IGpzb24", noRef, noVolumeId]) {
      await expect(pad.owns(token)).resolves.toBe(false);
      expect(pad.granted(token, GRANTEE)).toBeUndefined();
    }
  });

  it("owns nothing before it has a volume, and does not create one to find out", async () => {
    const fresh = spCliScratchPad({
      bin: FAKE_SP,
      dir: join(dir, "work-fresh"),
      volume: "never-committed-to",
      nats: { url: "nats://127.0.0.1:4222", creds: "/nowhere/agent.creds" },
    });
    expect(await fresh.owns(foreignReference("/replies/theirs.md"))).toBe(false);
    expect((await calls()).map((c) => c.verb)).toEqual(["volume list"]);
  });

  it("saves the CLI's replies under its directory's real path, because sp refuses a symlink in it", async () => {
    // As on macOS, where /tmp and $TMPDIR are symlinks.
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    const linked = spCliScratchPad({
      bin: FAKE_SP,
      dir: join(dir, "link", "work"),
      volume: "test-replies",
      nats: { url: "nats://127.0.0.1:4222", creds: "/nowhere/agent.creds" },
    });
    await linked.commit("hello", "/replies/t5.md", TRACE);
    const saved = (await calls())
      .filter((c) => c.verb === "session open")
      .map((c) => String(c.flags["save"]));
    expect(saved).toHaveLength(1);
    expect(saved[0]!.startsWith(join(await realpath(dir), "real", "work") + "/")).toBe(true);
  });

  it("reports a refused read with the CLI's error code", async () => {
    process.env["FAKE_SP_DENY_VOLUME"] = "vol-other";
    try {
      await expect(pad.read(foreignReference("/x.md"), TRACE)).rejects.toThrow(/permission_denied/);
    } finally {
      delete process.env["FAKE_SP_DENY_VOLUME"];
    }
  });
});
