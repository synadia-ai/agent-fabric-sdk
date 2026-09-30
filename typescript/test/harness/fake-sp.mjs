#!/usr/bin/env node
// A stand-in for the sp v2 command line, for the tests: it answers every
// command the ScratchPad wrapper uses with a reply of the CLI's shape, and
// writes what it was called with to a log the test reads back. Success is
// JSON on stdout; a refusal is `{"error": {"code", "message", "unknown"}}` on
// stderr with a non-zero exit. The same stand-in as the Python tests'
// `fake_sp.py`.
//
//   FAKE_SP_LOG     one JSON line per call: {"argv": [...], "stdin": ...}
//   FAKE_SP_STATE   a JSON file: each volume's workspace, retention and
//                   grant slots, and each root's one file, so a later `read`
//                   returns what was published. One file can serve several
//                   agents, each with its own volume
//   FAKE_SP_LOCK    a file each mutating command holds while it runs; a
//                   second one that finds it held fails with `busy`, so a
//                   test sees two mutations overlap
//   FAKE_SP_FAULTS  a JSON file `{"<command>": [fault, ...]}`; each call of
//                   that command takes the first fault off its list. A fault
//                   is `{"code", "unknown"}` (refuse), with `"after": true`
//                   to take effect first and then report the refusal, or
//                   `{"reply": {...}}` to replace the reply's fields. A
//                   `maintain` fault with `"stage": "closed"` closes the
//                   volume, saves the apply step, and then refuses
//
// The caller is the principal its `--creds` file names (the user JWT's
// subject and issuing account); a file that does not exist stands for one
// fixed principal. As the real CLI does, it reads only a token of its own
// account, and grants only to a principal in the token's account; the
// volume's owner reads without a grant, anyone else only with a live one on
// that root and path. It refuses `describe` and `recover` before `init` with
// `workspace`, and `recover` with nothing pending returns the last receipt.
// As the CLI at ScratchPad `a28bb49` does, a definite `capacity` refusal of
// `publish-file` leaves its preparation's spool in the workspace, and
// `publish-file` and `recover` refuse with `pending` until
// `spool-remove --apply` removes it.
//
// Nothing here talks to NATS. The wrapper's job is to call the CLI with the
// right commands and flags, one at a time, and to keep its own ledger; that
// is what this lets a test see.

import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

const OWN = { account: `A${"O".repeat(55)}`, user: `U${"O".repeat(55)}` };
const CREATION_ID = "0123456789abcdef0123456789abcdef";

const [command, ...rest] = process.argv.slice(2);

// The lock first, so it covers nearly the whole run: two mutations the
// wrapper let run side by side then collide here.
const lock = process.env.FAKE_SP_LOCK;
if (
  lock &&
  ["init", "recover", "publish-file", "maintain", "grant", "spool-remove"].includes(command)
) {
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    fail("busy", "another mutation is running");
  }
  process.on("exit", () => rmSync(lock, { force: true }));
}
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (!a.startsWith("--")) fail("usage", `unexpected argument ${a}`);
  if (a === "--apply") flags.apply = true;
  else flags[a.slice(2)] = rest[++i];
}
const stdin = readFileSync(0, "utf8");

if (process.env.FAKE_SP_LOG) {
  appendFileSync(
    process.env.FAKE_SP_LOG,
    `${JSON.stringify({ argv: process.argv.slice(2), stdin })}\n`,
  );
}

function load(file, empty) {
  try {
    return file ? JSON.parse(readFileSync(file, "utf8")) : empty;
  } catch {
    return empty;
  }
}
const store = load(process.env.FAKE_SP_STATE, {});
// Whole-file replacement, so a read running beside a mutation never sees half a file.
const save = () => {
  const file = process.env.FAKE_SP_STATE;
  if (!file) return;
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(store));
  renameSync(`${file}.${process.pid}`, file);
};

function fail(code, message, unknown = false) {
  process.stderr.write(`${JSON.stringify({ error: { code, message, unknown } })}\n`);
  process.exit(1);
}

for (const f of ["read", "resolve"].includes(command)
  ? ["url", "creds"]
  : ["url", "creds", "dir", "volume"]) {
  if (!flags[f]) fail("usage", `--${f} is required`);
}

// Whom the server would authenticate: the user JWT in the credentials file.
function principal(creds) {
  try {
    const jwt = /-----BEGIN NATS USER JWT-----\s*(\S+)/.exec(readFileSync(creds, "utf8"))?.[1];
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    return { account: claims.nats?.issuer_account ?? claims.iss, user: claims.sub };
  } catch {
    return OWN;
  }
}
const caller = principal(flags.creds);

const faults = load(process.env.FAKE_SP_FAULTS, {});
const fault = faults[command]?.shift();
if (fault !== undefined) writeFileSync(process.env.FAKE_SP_FAULTS, JSON.stringify(faults));
// A publication's capacity refusal comes after its preparation, below.
const refusedPreparation = command === "publish-file" && fault?.code === "capacity" && !fault.after;
if (fault?.code !== undefined && !fault.after && !fault.stage && !refusedPreparation)
  fail(fault.code, "injected", fault.unknown);

// An explicit public vector exercises short adapter reads independently of this
// older full-reference simulator's deliberately synthetic NKEYs.
if (process.env.FAKE_SP_REFERENCE_FILE && ["resolve", "read"].includes(command)) {
  const fixture = load(process.env.FAKE_SP_REFERENCE_FILE, {});
  if (flags.ref !== fixture.resolved.short) fail("not_found", "unknown fixture reference");
  console.log(
    JSON.stringify(
      command === "resolve"
        ? { reference: fixture.resolved.expanded, full_reference: fixture.full_token }
        : { data_base64: Buffer.from("short read").toString("base64"), bytes: 10 },
    ),
  );
  process.exit(0);
}
const now = Math.floor(Date.now() / 1000);
const token = (ref) => `sp-ref:${Buffer.from(JSON.stringify(ref)).toString("base64url")}`;
const decode = (t) => {
  try {
    return JSON.parse(Buffer.from(t.slice("sp-ref:".length), "base64url").toString());
  } catch {
    return fail("invalid", "reference token is invalid");
  }
};

store.volumes ??= {};
store.roots ??= {};
// The volume this call's workspace names; a read names the reference's.
const name = command === "read" ? decode(flags.ref).target?.volume : flags.volume;
// Eight retention and sixteen grant slots, as in the CLI's volume view. A
// pin stays in its slot past its deadline until `maintain --apply` releases
// it; a slot's generation never repeats.
// A read never creates one: a volume nobody initialized has no owner.
const fresh = () => ({
  owner: caller,
  init: false,
  retention: Array.from({ length: 8 }, () => ({ generation: 1, pin: null })),
  grants: Array.from({ length: 16 }, () => ({ generation: 0, grant: null })),
  revision: 1,
  closed: false,
  control: null,
});
const state =
  command === "read"
    ? (store.volumes[name] ?? { ...fresh(), owner: null })
    : (store.volumes[name] ??= fresh());
const target = { volume: name, creation_id: CREATION_ID };
const binding = () => ({ principal: state.owner, target });
const needInit = () => state.init || fail("workspace", "workspace has no created volume; run init");
// The spool a refused preparation left: nothing publishes past it.
const refuseCapacity = (message, unknown = false) => {
  state.spool = { phase: "preparing", files: 1, bytes: Buffer.byteLength(stdin) };
  save();
  fail("capacity", message, unknown);
};
const spoolView = (applied) =>
  state.spool
    ? { present: true, ...state.spool, removable: true, applied }
    : { present: false, files: 0, bytes: 0, removable: false, applied: false };

const protectedBy = (slot, i) =>
  state.grants.some(
    (g) =>
      g.grant &&
      g.grant.retention.slot === i &&
      g.grant.retention.generation === slot.generation &&
      g.grant.until > now,
  );
// Release every expired pin no live grant names, as `maintain --apply` does.
const releaseExpired = () => {
  const released = [];
  state.retention.forEach((slot, i) => {
    if (slot.pin && slot.pin.until !== 0 && slot.pin.until <= now && !protectedBy(slot, i)) {
      released.push({ slot: i, generation: slot.generation });
      slot.pin = null;
      slot.generation += 1;
      state.revision += 1;
    }
  });
  return released;
};
// Collection reopens the volume and settles the saved maintenance interval.
const reopen = () => {
  state.revision += 1;
  state.closed = false;
  state.control = null;
};
const view = () => ({
  target,
  owner: state.owner,
  head: { generation: state.generation ?? 1, root: "e".repeat(43) },
  revision: state.revision,
  closed: state.closed,
  epoch: state.closed ? state.revision : 0,
  objects: 0,
  bytes: 0,
  writers: Array.from({ length: 8 }, (_, i) => ({
    generation: 1,
    number: 0,
    principal: state.owner,
    write: i === 0,
  })),
  retentions: state.retention.map((slot) =>
    slot.pin
      ? {
          generation: slot.generation,
          pin: {
            root: slot.pin.root,
            until: slot.pin.until,
            origin: { writer: { slot: 0, generation: 1 }, number: 1 },
          },
        }
      : { generation: slot.generation },
  ),
  grants: state.grants.map((g) =>
    g.grant
      ? {
          generation: g.generation,
          grant: {
            principal: g.grant.principal,
            root: g.grant.root,
            path: g.grant.path,
            directory: false,
            retention: g.grant.retention,
            until: g.grant.until,
          },
        }
      : { generation: g.generation },
  ),
});
let reply;
switch (command) {
  case "init":
    state.init = true;
    reply = {
      ...binding(),
      writer: { status: "ready", writer: { slot: 0, generation: 1 }, next: 1 },
    };
    break;
  case "describe":
    needInit();
    reply = {
      ...binding(),
      established: true,
      writer: {
        status: state.pending ? "pending" : "ready",
        writer: { slot: 0, generation: 1 },
        next: 1,
      },
      pending_command: null,
      publication: null,
      control: state.control,
      volume: view(),
    };
    break;
  case "recover": {
    needInit();
    if (state.spool)
      fail("pending", "preparation is incomplete; inspect and remove its spool explicitly");
    let control = null;
    if (state.pending) {
      state.last = state.pending;
      state.pending = undefined;
    }
    if (state.control) {
      // The saved maintenance interval runs to its end: collect and reopen.
      control = { kind: state.control.kind };
      reopen();
    }
    // Nothing pending is no error: the last receipt comes back as it was.
    const writer = { status: "ready", writer: { slot: 0, generation: 1 }, next: 1 };
    reply = {
      writer,
      receipt: state.last?.receipt ?? null,
      reference: state.last?.reference ?? null,
      control,
    };
    break;
  }
  case "publish-file": {
    needInit();
    for (const f of ["path", "operation-id", "creator", "ttl-seconds"])
      if (!flags[f]) fail("usage", `--${f} is required`);
    if (flags.source !== "-") fail("usage", "--source - expected");
    if (state.pending && state.pending.operation_id !== flags["operation-id"]) {
      fail("pending", "a different command is pending; run recover");
    }
    if (state.spool) fail("pending", "saved spool requires recover or spool-remove --apply");
    if (refusedPreparation) refuseCapacity("injected", fault.unknown);
    const free = state.retention.findIndex((slot) => slot.pin === null);
    if (free < 0) refuseCapacity("no retention slot is free");
    if (state.closed) fail("closed", "volume: closed for maintenance");
    state.generation = (state.generation ?? 0) + 1;
    const root = randomBytes(32).toString("base64url");
    store.roots[root] = { volume: name, path: flags.path, data: stdin };
    const slot = state.retention[free];
    slot.pin = { root, until: now + Number(flags["ttl-seconds"]) };
    state.revision += 1;
    const ref = {
      version: 2,
      creator: flags.creator,
      account: state.owner.account,
      target,
      root,
      generation: state.generation,
      path: flags.path,
      retention: { slot: free, generation: slot.generation },
      expires_at: slot.pin.until,
    };
    reply = {
      receipt: { volume: flags.volume, head: { root, generation: state.generation } },
      reference: token(ref),
      operation_id: flags["operation-id"],
    };
    if (fault?.after) state.pending = reply;
    else state.last = reply;
    break;
  }
  case "maintain": {
    needInit();
    let released = [];
    if (flags.apply) {
      if (state.control?.kind !== "apply") {
        released = releaseExpired();
        // A successful close moves the saved control straight to apply.
        state.revision += 1;
        state.closed = true;
        state.control = { kind: "apply", maintenance: { target, revision: state.revision } };
        if (fault?.stage === "closed") {
          save();
          fail(fault.code, "injected after the close", fault.unknown);
        }
      }
      reopen();
    }
    reply = {
      applied: Boolean(flags.apply),
      resumed: null,
      released,
      expired: [],
      collection: null,
      volume: view(),
    };
    break;
  }
  case "spool-inspect":
    needInit();
    reply = spoolView(false);
    break;
  case "spool-remove": {
    needInit();
    const applied = Boolean(flags.apply) && state.spool !== undefined;
    reply = spoolView(applied);
    if (applied) state.spool = undefined;
    break;
  }
  case "read": {
    const ref = decode(flags.ref);
    if (flags.volume && flags.volume !== ref.target.volume)
      fail("usage", "--volume differs from the reference volume");
    if (ref.expires_at <= now) fail("expired", "reference has expired");
    if (ref.account !== caller.account) fail("denied", "reference names another account");
    const mine = state.owner?.account === caller.account && state.owner?.user === caller.user;
    const granted = state.grants.some(
      (g) =>
        g.grant &&
        g.grant.principal.user === caller.user &&
        g.grant.root === ref.root &&
        g.grant.path === ref.path &&
        g.grant.until > now,
    );
    if (!mine && !granted) fail("denied", "scratchpad denied: denied");
    if (state.closed) fail("closed", "volume: closed for maintenance");
    const file = store.roots[ref.root];
    if (file === undefined || file.volume !== name || file.path !== ref.path)
      fail("not_found", "no such root and path");
    const data = Buffer.from(file.data);
    reply = { data_base64: data.toString("base64"), bytes: data.length };
    break;
  }
  case "grant": {
    needInit();
    const ref = decode(flags.ref);
    for (const f of ["grantee-account", "grantee-user", "operation-id", "ttl-seconds"])
      if (!flags[f]) fail("usage", `--${f} is required`);
    if (ref.account !== caller.account) fail("denied", "reference names another account");
    if (ref.target.volume !== name || ref.target.creation_id !== CREATION_ID) {
      fail("denied", "reference names another volume incarnation than this workspace");
    }
    if (flags["grantee-account"] !== ref.account)
      fail("denied", "grants are limited to the reference's account");
    if (state.control)
      fail("pending", `a ${state.control.kind} request is unresolved; run recover`);
    const ttl = Number(flags["ttl-seconds"]);
    if (!(ttl >= 1 && ttl <= 3600) || now + ttl > ref.expires_at)
      fail("usage", "the grant outlives its reference");
    const free = state.grants.findIndex((g) => g.grant === null || g.grant.until <= now);
    if (free < 0) fail("capacity", "all read-grant slots hold live grants");
    const slot = state.grants[free];
    slot.generation += 1;
    const grantee = { account: flags["grantee-account"], user: flags["grantee-user"] };
    slot.grant = {
      principal: grantee,
      root: ref.root,
      path: ref.path,
      retention: ref.retention,
      until: now + ttl,
    };
    state.revision += 1;
    reply = { handle: { slot: free, generation: slot.generation }, expires_at: now + ttl };
    break;
  }
  default:
    fail("usage", `unknown command ${command}`);
}
save();
if (fault?.code !== undefined) fail(fault.code, "injected after the effect", fault.unknown);
if (fault?.reply !== undefined) reply = { ...reply, ...fault.reply };
process.stdout.write(`${JSON.stringify(reply)}\n`);
