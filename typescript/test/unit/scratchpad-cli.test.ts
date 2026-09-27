// The ScratchPad wrapper against a stand-in for the sp v2 command line
// (`../harness/fake-sp.mjs`): what the wrapper asks the CLI to do, in which
// order, with which flags and input, and what it keeps in its own ledger.
// The stand-in proves nothing about ScratchPad itself; the real CLI and
// service are tested in their own repository and on a running fabric. The
// same test as the Python package's `test_scratchpad_cli.py`.
//
// The grant is the point: on a reference into the agent's own volume, one
// `grant` to one principal, on the root and path the reference names, with
// a lifetime no longer than the reference's, and a line in the ledger of
// whom this agent granted what; on a reference into someone else's volume,
// nothing: no read, no copy, no grant. Only the creator grants
// (`grant-request.test.ts`). The wrapper is the `ScratchPad` port with a
// commit and a read, `spCliScratchPad`; the vocabulary of references is
// tested in `scratchpad-vocabulary.test.ts`.

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  referenceCreator,
  ScratchPadError,
  spCliScratchPad,
  type ScratchPadClient,
  type SpCliScratchPadOptions,
} from "../../src/index.js";
import { decodeDescribe, decodeReference } from "../../src/scratchpad-cli.js";

const FAKE_SP = fileURLToPath(new URL("../harness/fake-sp.mjs", import.meta.url));
const TRACE = { threadId: "1".repeat(32), rootId: "2".repeat(32) };
const CREATOR = "agents.prompt.assistant.test.main";
// The fake CLI's own account and volume incarnation. A grant goes only to
// a principal in the reference's account, as the CLI enforces.
const OWN_ACCOUNT = `A${"O".repeat(55)}`;
const GRANTEE = { account: OWN_ACCOUNT, user: `U${"C".repeat(55)}` };
const CREATION_ID = "0123456789abcdef0123456789abcdef";
const NATS = { url: "nats://127.0.0.1:4222", creds: "/nowhere/agent.creds" };

interface Call {
  readonly argv: string[];
  readonly stdin: string;
}

/** The command of a call and its `--flag value` pairs. */
function parse(call: Call): { command: string; flags: Record<string, string | true> } {
  const [command, ...rest] = call.argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--apply") flags["apply"] = true;
    else flags[a.slice(2)] = rest[++i]!;
  }
  return { command: command!, flags };
}

/** A token of the version 2 shape, with fields replaced. */
function token(fields: Record<string, unknown> = {}): string {
  const ref = {
    version: 2,
    creator: "agents.prompt.assistant.test.other",
    account: `A${"X".repeat(55)}`,
    target: { volume: "theirreplies", creation_id: "f".repeat(32) },
    root: "r".repeat(43),
    generation: 3,
    path: "/replies/theirs.md",
    retention: { slot: 1, generation: 4 },
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...fields,
  };
  return `sp-ref:${Buffer.from(JSON.stringify(ref)).toString("base64url")}`;
}

describe("the ScratchPad wrapper over the sp command line", () => {
  let dir: string;
  let log: string;
  let faults: string;
  let pad: ScratchPadClient;

  const make = (extra: Partial<SpCliScratchPadOptions> = {}): ScratchPadClient =>
    spCliScratchPad({
      bin: FAKE_SP,
      dir: join(dir, "work"),
      volume: "testreplies",
      nats: NATS,
      grantTtlS: 60,
      creator: CREATOR,
      ...extra,
    });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "fabric-examples-sp-"));
    log = join(dir, "calls.jsonl");
    faults = join(dir, "faults.json");
    process.env["FAKE_SP_LOG"] = log;
    process.env["FAKE_SP_STATE"] = join(dir, "state.json");
    process.env["FAKE_SP_FAULTS"] = faults;
    process.env["FAKE_SP_LOCK"] = join(dir, "lock");
    await writeFile(log, "");
    pad = make();
  });

  afterEach(async () => {
    for (const k of ["FAKE_SP_LOG", "FAKE_SP_STATE", "FAKE_SP_FAULTS", "FAKE_SP_LOCK"])
      delete process.env[k];
    await rm(dir, { recursive: true, force: true });
  });

  async function raw(): Promise<Call[]> {
    return (await readFile(log, "utf8"))
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Call);
  }
  const calls = async (): Promise<ReturnType<typeof parse>[]> => (await raw()).map(parse);
  const clear = (): Promise<void> => writeFile(log, "");
  const inject = (f: Record<string, unknown[]>): Promise<void> =>
    writeFile(faults, JSON.stringify(f));
  /** The fake CLI's state of this agent's volume. */
  interface FakeState {
    closed: boolean;
    control: { kind: string } | null;
    retention: { generation: number; pin: { root: string; until: number } | null }[];
    last: { reference: string };
  }
  const stateFile = (): string => join(dir, "state.json");
  const store = async (): Promise<{ volumes: Record<string, FakeState> }> =>
    JSON.parse(await readFile(stateFile(), "utf8")) as { volumes: Record<string, FakeState> };
  const state = async (): Promise<FakeState> => (await store()).volumes["testreplies"]!;
  async function edit(change: (s: FakeState) => void): Promise<void> {
    const s = await store();
    change(s.volumes["testreplies"]!);
    await writeFile(stateFile(), JSON.stringify(s));
  }
  /** Eight live handoffs: every retention slot holds a pin. */
  async function fill(): Promise<string[]> {
    const refs: string[] = [];
    for (let i = 0; i < 8; i++)
      refs.push(await pad.commit(`reply ${i}`, `/replies/full${i}.md`, TRACE));
    return refs;
  }
  /** Moves the deadline of the pin in `slot` into the past. */
  const expire = (slot: number): Promise<void> =>
    edit((s) => {
      s.retention[slot]!.pin!.until = Math.floor(Date.now() / 1000) - 10;
    });

  it("commits by publishing one file, retained for ten minutes, and returns the CLI's reference as it is", async () => {
    const reference = await pad.commit("hello", "/replies/t1.md", TRACE);
    const seen = await calls();
    // The first commit of a process initializes the workspace and finishes
    // anything a previous process left pending; nothing else starts.
    expect(seen.map((c) => c.command)).toEqual(["init", "recover", "publish-file"]);
    const publish = seen[2]!;
    expect(publish.flags).toMatchObject({
      url: NATS.url,
      creds: NATS.creds,
      dir: await realpath(join(dir, "work")),
      volume: "testreplies",
      source: "-",
      path: "/replies/t1.md",
      creator: CREATOR,
      "ttl-seconds": "600",
      "thread-id": TRACE.threadId,
      "root-id": TRACE.rootId,
    });
    expect(String(publish.flags["operation-id"])).toMatch(/^[0-9a-f-]{36}$/);
    // The content went in on stdin, not through a file.
    expect((await raw())[2]!.stdin).toBe("hello");
    // The token is the CLI's, and names this agent as its creator.
    const ref = decodeReference(reference);
    expect(ref).toMatchObject({
      version: 2,
      account: OWN_ACCOUNT,
      path: "/replies/t1.md",
      creator: CREATOR,
    });
    expect(ref.target).toEqual({ volume: "testreplies", creation_id: CREATION_ID });
    expect(referenceCreator(reference)).toBe(CREATOR);
    expect(reference).toBe((await state()).last.reference);

    // Later commits publish and nothing more; every call carries the connection.
    await clear();
    await pad.commit("again", "/replies/t2.md", TRACE);
    expect((await calls()).map((c) => c.command)).toEqual(["publish-file"]);
  });

  it("reads by handing the CLI the reference, and returns exactly the bytes published", async () => {
    const text = "what was committed: ünïcödé, \u{1F600}, and a newline\n";
    const reference = await pad.commit(text, "/replies/t2.md", TRACE);
    await clear();
    expect(await make({ volume: "Reader" }).read(reference, TRACE)).toBe(text);
    const seen = await calls();
    expect(seen.map((c) => c.command)).toEqual(["read"]);
    expect(seen[0]!.flags).toMatchObject({
      ref: reference,
      "thread-id": TRACE.threadId,
      "root-id": TRACE.rootId,
    });
    expect(seen[0]!.flags).not.toHaveProperty("volume");
  });

  it("refuses a read reply whose data does not match its length", async () => {
    const reference = await pad.commit("four", "/replies/t2b.md", TRACE);
    await inject({ read: [{ reply: { bytes: 5 } }] });
    await expect(pad.read(reference, TRACE)).rejects.toThrow(/does not match its length/);
  });

  it("leaves no file behind per operation: the CLI's workspace is all there is", async () => {
    for (let i = 0; i < 5; i++) {
      const reference = await pad.commit(`reply ${i}`, `/replies/t${i}.md`, TRACE);
      await pad.read(reference, TRACE);
      await pad.grantRead(reference, GRANTEE, TRACE);
    }
    // The fake CLI writes nothing there; the wrapper wrote nothing either.
    expect(await readdir(join(dir, "work"))).toEqual([]);
  });

  it("grants read on its own reference: one principal, the reference itself, a bounded lifetime", async () => {
    const reference = await pad.commit("mine", "/replies/t3.md", TRACE);
    await clear();
    expect(await pad.owns(reference)).toBe(true);
    expect(pad.granted(reference, GRANTEE)).toBeUndefined();
    await pad.grantRead(reference, GRANTEE, TRACE, "call_7");
    const seen = await calls();
    expect(seen.map((c) => c.command)).toEqual(["grant"]);
    const { flags } = seen[0]!;
    expect(flags).toMatchObject({
      ref: reference,
      "grantee-account": GRANTEE.account,
      "grantee-user": GRANTEE.user,
      "ttl-seconds": "60",
      "thread-id": TRACE.threadId,
      "root-id": TRACE.rootId,
      "tool-call-id": "call_7",
    });
    expect(String(flags["operation-id"])).toMatch(/^[0-9a-f-]{36}$/);
    // The ledger: that principal, that reference, and nobody and nothing
    // else. A grant this agent makes of its own accord is first-hand.
    expect(pad.granted(reference, GRANTEE)).toBe("first-hand");
    expect(pad.granted(reference, { ...GRANTEE, user: `U${"D".repeat(55)}` })).toBeUndefined();
    expect(
      pad.granted(await pad.commit("other", "/replies/t3b.md", TRACE), GRANTEE),
    ).toBeUndefined();
  });

  it("keeps a first-hand grant to one root from covering a new root at the same path", async () => {
    const first = await pad.commit("first reply", "/replies/thread.md", TRACE);
    const second = await pad.commit("second reply", "/replies/thread.md", TRACE);
    expect(decodeReference(first).root).not.toBe(decodeReference(second).root);
    await pad.grantRead(first, GRANTEE, TRACE);
    expect(pad.granted(first, GRANTEE)).toBe("first-hand");
    expect(pad.granted(second, GRANTEE)).toBeUndefined();
  });

  it("keeps apart the grants it made first-hand and those it made on request", async () => {
    const reference = await pad.commit("mine", "/replies/t3d.md", TRACE);
    const other = { ...GRANTEE, user: `U${"E".repeat(55)}` };
    // Made because another agent asked: recorded as such, and the CLI call is the same.
    await clear();
    await pad.grantRead(reference, other, TRACE, "call_8", "on-request");
    expect(pad.granted(reference, other)).toBe("on-request");
    expect((await calls()).map((c) => c.command)).toEqual(["grant"]);
    // A first-hand grant still running is not hidden by a later one made on request.
    await pad.grantRead(reference, GRANTEE, TRACE);
    await pad.grantRead(reference, GRANTEE, TRACE, undefined, "on-request");
    expect(pad.granted(reference, GRANTEE)).toBe("first-hand");
  });

  it("records the expiry the CLI reports, not one it guessed", async () => {
    const reference = await pad.commit("soon gone", "/replies/t3c.md", TRACE);
    await inject({ grant: [{ reply: { expires_at: Math.floor(Date.now() / 1000) - 1 } }] });
    await pad.grantRead(reference, GRANTEE, TRACE);
    expect(pad.granted(reference, GRANTEE)).toBeUndefined();
  });

  it("never asks for a grant that outlives the reference, or for one at all when the reference expired", async () => {
    const long = make({ grantTtlS: 3600 });
    const reference = await long.commit("mine", "/replies/t6.md", TRACE);
    await clear();
    await long.grantRead(reference, GRANTEE, TRACE);
    const ttl = Number((await calls())[0]!.flags["ttl-seconds"]);
    // Short of the reference's ten minutes by a margin for the CLI's clock.
    expect(ttl).toBeGreaterThan(585);
    expect(ttl).toBeLessThanOrEqual(595);

    const soon = Math.floor(Date.now() / 1000) + 30;
    const brief = token({
      account: OWN_ACCOUNT,
      target: { volume: "testreplies", creation_id: CREATION_ID },
      expires_at: soon,
    });
    await clear();
    await long.grantRead(brief, GRANTEE, TRACE);
    expect(Number((await calls())[0]!.flags["ttl-seconds"])).toBeLessThanOrEqual(25);

    const gone = token({
      account: OWN_ACCOUNT,
      target: { volume: "testreplies", creation_id: CREATION_ID },
      expires_at: soon - 60,
    });
    await clear();
    await expect(long.grantRead(gone, GRANTEE, TRACE)).rejects.toThrow(/expired/);
    await expect(long.read(gone, TRACE)).rejects.toThrow(/expired/);
    expect(await calls()).toEqual([]);
  });

  it("keeps the ledger finite: a seventeenth live grant is refused before ScratchPad is asked", async () => {
    const reference = await pad.commit("mine", "/replies/t7.md", TRACE);
    for (let i = 0; i < 16; i++) {
      await pad.grantRead(
        reference,
        { account: GRANTEE.account, user: `U${String.fromCharCode(65 + i).repeat(55)}` },
        TRACE,
      );
    }
    await clear();
    await expect(
      pad.grantRead(reference, { account: GRANTEE.account, user: `U${"Z".repeat(55)}` }, TRACE),
    ).rejects.toThrow(/16 live grants/);
    expect(await calls()).toEqual([]);
  });

  it("grants nothing on a reference into someone else's volume, and neither reads nor copies it", async () => {
    await pad.commit("mine", "/replies/t4.md", TRACE); // the wrapper knows its own volume
    await clear();
    const theirs = token();
    expect(await pad.owns(theirs)).toBe(false);
    await expect(pad.grantRead(theirs, GRANTEE, TRACE)).rejects.toThrow(
      /only its creator can grant/,
    );
    expect(pad.granted(theirs, GRANTEE)).toBeUndefined();
    // Not one call to ScratchPad: being handed content is not a right to pass it on.
    expect(await calls()).toEqual([]);
    // Another incarnation of the same volume is not this agent's either.
    const recreated = token({
      account: OWN_ACCOUNT,
      target: { volume: "testreplies", creation_id: "e".repeat(32) },
    });
    expect(await pad.owns(recreated)).toBe(false);
  });

  it("owns nothing before it has a volume, and does not create one to find out", async () => {
    expect(await pad.owns(token())).toBe(false);
    expect((await calls()).map((c) => c.command)).toEqual(["describe"]);
  });

  it("refuses a malformed or oversized token before it starts the CLI", async () => {
    const good = token();
    const bad = [
      "sp-ref:",
      "sp-ref:!!!",
      `sp-ref:${"A".repeat(16 * 1024)}`,
      `sp-ref:${Buffer.from("not json").toString("base64url")}`,
      `${good}=`,
      token({ version: 1 }),
      token({ extra: true }),
      token({ account: "$G" }),
      token({ creator: "" }),
      token({ generation: 0 }),
      token({ path: "replies/x.md" }),
      token({ path: `/${"x".repeat(300)}` }),
      token({ retention: { slot: 8, generation: 1 } }),
      token({ target: { volume: "their-replies", creation_id: "f".repeat(32) } }),
      // The token the earlier CLI made.
      `sp-ref:${Buffer.from(JSON.stringify({ ref: { volume_id: "v", root: "r", path: "/x" }, source_sequence: 1 })).toString("base64url")}`,
    ];
    for (const t of bad) {
      await expect(pad.read(t, TRACE)).rejects.toThrow(/malformed ScratchPad reference/);
      expect(await pad.owns(t)).toBe(false);
      expect(pad.granted(t, GRANTEE)).toBeUndefined();
    }
    expect(await calls()).toEqual([]);
  });

  it("keeps an unknown commit pending: an error now, and the same command finished before the next", async () => {
    await pad.commit("first", "/replies/t8.md", TRACE);
    await inject({ "publish-file": [{ code: "unavailable", unknown: true, after: true }] });
    const failed = pad.commit("lost reply", "/replies/t9.md", TRACE);
    await expect(failed).rejects.toBeInstanceOf(ScratchPadError);
    await expect(failed).rejects.toMatchObject({ code: "unavailable", unknown: true });
    await clear();
    await pad.commit("next", "/replies/t10.md", TRACE);
    // Recovery repeats the saved command; nothing resets the writer.
    expect((await calls()).map((c) => c.command)).toEqual(["recover", "publish-file"]);
  });

  it("stops when recovery itself is unknown, rather than starting a different command", async () => {
    await pad.commit("first", "/replies/t8.md", TRACE);
    await inject({
      "publish-file": [{ code: "unavailable", unknown: true }],
      recover: [{ code: "unavailable", unknown: true }],
    });
    await expect(pad.commit("lost", "/replies/t9.md", TRACE)).rejects.toMatchObject({
      unknown: true,
    });
    await clear();
    await expect(pad.commit("next", "/replies/t10.md", TRACE)).rejects.toMatchObject({
      unknown: true,
    });
    expect((await calls()).map((c) => c.command)).toEqual(["recover"]);
  });

  it("counts a reply it cannot read as an unknown outcome", async () => {
    await inject({ "publish-file": [{ reply: { reference: 7 } }] });
    await expect(pad.commit("x", "/replies/t11.md", TRACE)).rejects.toMatchObject({
      unknown: true,
    });
  });

  it("cleans up when ScratchPad is full, then tries the same commit once more", async () => {
    await pad.commit("first", "/replies/t12.md", TRACE);
    await inject({ "publish-file": [{ code: "capacity", unknown: false }] });
    await clear();
    const reference = await pad.commit("after cleanup", "/replies/t13.md", TRACE);
    const seen = await calls();
    // A free retention slot, and the content allowance full: cleanup can help.
    expect(seen.map((c) => c.command)).toEqual([
      "publish-file",
      "describe",
      "maintain",
      "publish-file",
    ]);
    expect(seen[2]!.flags["apply"]).toBe(true);
    expect(seen[3]!.flags["operation-id"]).toBe(seen[0]!.flags["operation-id"]);
    expect(await pad.read(reference, TRACE)).toBe("after cleanup");
  });

  it("evicts no live handoff and closes nothing: with every retention slot live the commit fails, and the others still read", async () => {
    const refs = await fill();
    await clear();
    const failed = pad.commit("one too many", "/replies/full8.md", TRACE);
    await expect(failed).rejects.toMatchObject({ code: "capacity", unknown: false });
    await expect(failed).rejects.toThrow(/every retention slot holds a live pin/);
    const reader = make({ volume: "Reader" });
    for (let i = 0; i < 8; i++) expect(await reader.read(refs[i]!, TRACE)).toBe(`reply ${i}`);
    // The describe decided it: no maintenance, and every earlier handoff read.
    expect((await calls()).map((c) => c.command)).toEqual([
      "publish-file",
      "describe",
      ...Array<string>(8).fill("read"),
    ]);
    expect((await state()).closed).toBe(false);
  });

  it("collects when an expired pin can be released, and the retried commit takes its slot", async () => {
    const refs = await fill();
    await expire(3);
    await clear();
    const reference = await pad.commit("after release", "/replies/full8.md", TRACE);
    expect((await calls()).map((c) => c.command)).toEqual([
      "publish-file",
      "describe",
      "maintain",
      "publish-file",
    ]);
    expect(decodeReference(reference).retention.slot).toBe(3);
    expect(await pad.read(reference, TRACE)).toBe("after release");
    expect(await pad.read(refs[4]!, TRACE)).toBe("reply 4");
    expect((await state()).closed).toBe(false);
  });

  it("counts an expired pin a live grant names as live, and closes nothing", async () => {
    const refs = await fill();
    await pad.grantRead(refs[2]!, GRANTEE, TRACE);
    await expire(2);
    await clear();
    await expect(pad.commit("one too many", "/replies/full8.md", TRACE)).rejects.toMatchObject({
      code: "capacity",
      unknown: false,
    });
    expect((await calls()).map((c) => c.command)).toEqual(["publish-file", "describe"]);
  });

  it("never reopens a volume someone else closed", async () => {
    await fill();
    await expire(0);
    await edit((s) => {
      s.closed = true;
    });
    await clear();
    await expect(pad.commit("while closed", "/replies/full8.md", TRACE)).rejects.toThrow(
      /no cleanup of this agent's is saved/,
    );
    expect((await calls()).map((c) => c.command)).toEqual(["publish-file", "describe"]);
    expect((await state()).closed).toBe(true);
  });

  it("keeps an unknown cleanup unknown, and finishes it before the next publication", async () => {
    await fill();
    await expire(5);
    await inject({ maintain: [{ stage: "closed", code: "unavailable", unknown: true }] });
    const failed = pad.commit("during cleanup", "/replies/full8.md", TRACE);
    await expect(failed).rejects.toBeInstanceOf(ScratchPadError);
    await expect(failed).rejects.toMatchObject({ code: "unavailable", unknown: true });
    // The close happened; the saved apply is what remains.
    expect(await state()).toMatchObject({ closed: true, control: { kind: "apply" } });
    await clear();
    const reference = await pad.commit("next", "/replies/full9.md", TRACE);
    expect((await calls()).map((c) => c.command)).toEqual(["recover", "publish-file"]);
    expect(await state()).toMatchObject({ closed: false, control: null });
    expect(await pad.read(reference, TRACE)).toBe("next");
  });

  it("finishes an unfinished cleanup before a grant", async () => {
    const refs = await fill();
    await expire(6);
    await inject({ maintain: [{ stage: "closed", code: "unavailable", unknown: true }] });
    await expect(pad.commit("during cleanup", "/replies/full8.md", TRACE)).rejects.toMatchObject({
      unknown: true,
    });
    await clear();
    await pad.grantRead(refs[0]!, GRANTEE, TRACE);
    expect((await calls()).map((c) => c.command)).toEqual(["recover", "grant"]);
    expect(pad.granted(refs[0]!, GRANTEE)).toBe("first-hand");
  });

  it("keeps a definite cleanup failure a capacity refusal, and still recovers before the next mutation", async () => {
    await fill();
    await expire(1);
    await inject({ maintain: [{ stage: "closed", code: "invalid", unknown: false }] });
    await expect(pad.commit("during cleanup", "/replies/full8.md", TRACE)).rejects.toMatchObject({
      code: "capacity",
      unknown: false,
    });
    await clear();
    await pad.commit("next", "/replies/full9.md", TRACE);
    expect((await calls()).map((c) => c.command)).toEqual(["recover", "publish-file"]);
  });

  it("after a restart, finishes the cleanup an earlier process left saved", async () => {
    await fill();
    await expire(7);
    await inject({ maintain: [{ stage: "closed", code: "unavailable", unknown: true }] });
    await expect(pad.commit("during cleanup", "/replies/full8.md", TRACE)).rejects.toMatchObject({
      unknown: true,
    });
    await clear();
    const restarted = make();
    await restarted.commit("after restart", "/replies/full9.md", TRACE);
    expect((await calls()).map((c) => c.command)).toEqual(["init", "recover", "publish-file"]);
    expect((await state()).closed).toBe(false);
  });

  it("closes nothing when the describe reply is out of shape", async () => {
    await fill();
    await expire(0);
    await inject({
      describe: [{ reply: { volume: { closed: false, retentions: [], grants: [] } } }],
    });
    await clear();
    await expect(pad.commit("x", "/replies/full8.md", TRACE)).rejects.toMatchObject({
      code: "capacity",
      unknown: false,
    });
    expect((await calls()).map((c) => c.command)).toEqual(["publish-file", "describe"]);
  });

  it("decodes the describe view only in the CLI's exact shape", () => {
    const slot = { generation: 1 };
    const good = {
      control: null,
      volume: {
        closed: false,
        retentions: Array(8).fill(slot),
        grants: Array(16).fill({ generation: 0 }),
      },
    };
    expect(decodeDescribe(good).retentions).toHaveLength(8);
    for (const bad of [
      { ...good, control: { kind: "reset" } },
      { ...good, volume: { ...good.volume, closed: "no" } },
      { ...good, volume: { ...good.volume, retentions: Array(7).fill(slot) } },
      {
        ...good,
        volume: {
          ...good.volume,
          retentions: [
            ...Array<object>(7).fill(slot),
            { generation: 1, pin: { root: "r", until: -1 } },
          ],
        },
      },
      {
        ...good,
        volume: {
          ...good.volume,
          grants: [
            ...Array<object>(15).fill({ generation: 0 }),
            { generation: 1, grant: { until: 5, retention: { slot: 8, generation: 1 } } },
          ],
        },
      },
    ]) {
      expect(() => decodeDescribe(bad)).toThrow(/sp describe/);
    }
  });

  it("keeps an unknown grant out of the ledger, and finishes that same grant before the next", async () => {
    const reference = await pad.commit("mine", "/replies/t14.md", TRACE);
    await inject({ grant: [{ code: "unavailable", unknown: true }] });
    await clear();
    await expect(pad.grantRead(reference, GRANTEE, TRACE, "call_1")).rejects.toMatchObject({
      unknown: true,
    });
    expect(pad.granted(reference, GRANTEE)).toBeUndefined();
    const other = { ...GRANTEE, user: `U${"F".repeat(55)}` };
    await pad.grantRead(reference, other, TRACE, "call_2");
    const seen = await calls();
    expect(seen.map((c) => c.command)).toEqual(["grant", "grant", "grant"]);
    // The retry is the same grant: same operation, lifetime and labels.
    expect(seen[1]!.flags).toEqual(seen[0]!.flags);
    expect(pad.granted(reference, GRANTEE)).toBe("first-hand");
    expect(pad.granted(reference, other)).toBe("first-hand");
  });

  it("runs one mutation at a time, without waiting on a clock", async () => {
    const paths = [0, 1, 2, 3, 4, 5].map((i) => `/replies/c${i}.md`);
    const results = await Promise.all(paths.map((p) => pad.commit(p, p, TRACE)));
    await Promise.all(
      results.flatMap((r) => [
        Promise.resolve(pad.grantRead(r, GRANTEE, TRACE)),
        pad.read(r, TRACE),
      ]),
    );
    // The fake CLI fails with `busy` when two mutations overlap; none did.
    expect(results.map((r) => decodeReference(r).path)).toEqual(paths);
    expect(results.every((r) => pad.granted(r, GRANTEE) === "first-hand")).toBe(true);
  });

  /** A credentials file for one more principal: the fake CLI reads the user JWT's claims. */
  async function credsFor(user: string, account = OWN_ACCOUNT): Promise<string> {
    const claims = Buffer.from(
      JSON.stringify({ sub: user, iss: account, nats: { type: "user" } }),
    ).toString("base64url");
    const file = join(dir, `${user.slice(0, 8)}.creds`);
    await writeFile(
      file,
      `-----BEGIN NATS USER JWT-----\neyJ0eXAiOiJKV1QifQ.${claims}.sig\n------END NATS USER JWT------\n`,
    );
    return file;
  }

  it("hands over to another agent in its account: its grant opens the read, and nothing else does", async () => {
    const reader = make({
      dir: join(dir, "reader"),
      volume: "Reader",
      nats: { url: NATS.url, creds: await credsFor(GRANTEE.user) },
    });
    const reference = await pad.commit("for the reader", "/replies/t15.md", TRACE);
    await expect(reader.read(reference, TRACE)).rejects.toMatchObject({
      code: "denied",
      unknown: false,
    });
    await pad.grantRead(reference, GRANTEE, TRACE);
    expect(await reader.read(reference, TRACE)).toBe("for the reader");
  });

  it("leaves a grant the CLI refuses out of the ledger: a principal in another account", async () => {
    const reference = await pad.commit("mine", "/replies/t16.md", TRACE);
    const elsewhere = { account: `A${"B".repeat(55)}`, user: GRANTEE.user };
    const refused = pad.grantRead(reference, elsewhere, TRACE);
    await expect(refused).rejects.toMatchObject({ code: "denied", unknown: false });
    await expect(refused).rejects.toThrow(/limited to the reference's account/);
    expect(pad.granted(reference, elsewhere)).toBeUndefined();
    // A definite refusal is settled: the next grant goes ahead on its own.
    await clear();
    await pad.grantRead(reference, GRANTEE, TRACE);
    expect((await calls()).map((c) => c.command)).toEqual(["grant"]);
  });

  it("reports a refused read with the CLI's error code", async () => {
    await expect(pad.read(token(), TRACE)).rejects.toThrow(/sp read: denied/);
  });

  it("needs a URL and a credentials file, and a creator to commit", async () => {
    expect(() =>
      spCliScratchPad({
        bin: FAKE_SP,
        dir: join(dir, "work"),
        volume: "testreplies",
        nats: { context: "dev" },
      }),
    ).toThrow(/NATS_URL and NATS_CREDS; a NATS context or an nkey seed alone is not supported/);
    const anonymous = spCliScratchPad({
      bin: FAKE_SP,
      dir: join(dir, "work"),
      volume: "testreplies",
      nats: NATS,
    });
    await expect(anonymous.commit("x", "/replies/x.md", TRACE)).rejects.toThrow(
      /names its creator/,
    );
    expect(await calls()).toEqual([]);
  });

  it("hands the CLI its directory's real path", async () => {
    // As on macOS, where /tmp and $TMPDIR are symlinks.
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "link"));
    const linked = make({ dir: join(dir, "link", "work") });
    await linked.commit("hello", "/replies/t5.md", TRACE);
    const used = new Set((await calls()).map((c) => c.flags["dir"]));
    expect([...used]).toEqual([join(await realpath(dir), "real", "work")]);
  });
});
