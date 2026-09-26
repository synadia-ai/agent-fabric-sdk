#!/usr/bin/env node
// A stand-in for the `sp` command line, for the tests: it answers every verb
// the ScratchPad wrapper uses with a reply of the real CLI's shape, and
// writes what it was called with to a log the test reads back.
//
//   FAKE_SP_LOG          one JSON line per call: {"argv": [...], "stdin": ...}
//   FAKE_SP_STATE        a JSON file where `put` keeps content by path, so a
//                        later `cat` returns what was committed
//   FAKE_SP_VOLUME       the name `volume list` reports for the one volume,
//                        `vol-own` (default "test-volume")
//   FAKE_SP_DENY_VOLUME  a volume id whose `cat` is refused the way the real
//                        CLI refuses one: JSON on stderr, exit 13
//
// Nothing here talks to NATS. The wrapper's job is to call the CLI with the
// right verbs and flags in the right order; that is what this lets a test see.

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flags = {};
const words = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("-")) {
    if (a === "-json" || a === "-apply") flags[a.slice(1)] = true;
    else flags[a.slice(1)] = argv[++i];
  } else words.push(a);
}
const verb = words.join(" ");
const stdin = flags.source === "-" ? readFileSync(0, "utf8") : null;

if (process.env.FAKE_SP_LOG) {
  appendFileSync(process.env.FAKE_SP_LOG, `${JSON.stringify({ argv, stdin })}\n`);
}
const stateFile = process.env.FAKE_SP_STATE;
const state = (() => {
  try {
    return stateFile ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  } catch {
    return {};
  }
})();
const save = () => stateFile && writeFileSync(stateFile, JSON.stringify(state));

function refuse(code, message, exit) {
  process.stderr.write(`${JSON.stringify({ error: { code, message } })}\n`);
  process.exit(exit);
}

const now = Date.now();
let reply;
switch (verb) {
  case "volume list":
    reply = {
      volumes: [
        { id: "vol-own", name: process.env.FAKE_SP_VOLUME ?? "test-volume", root: "root-0" },
      ],
    };
    break;
  case "volume create":
    reply = { volume: { id: "vol-own", root: "root-0" } };
    break;
  case "session open":
    reply = { session: { id: "sess-1" } };
    break;
  case "put":
    state[flags.path] = stdin;
    save();
    reply = { change: { path: flags.path } };
    break;
  case "commit":
    reply = { receipt: { new_root: `root-${now}` } };
    break;
  case "ref make":
    reply = {
      ref: {
        type: "handoff",
        handoff_id: `hnd-${now}`,
        volume_id: flags["volume-id"],
        root: flags.root,
        path: flags.path,
        expires_at: Number(flags["expires-at"]),
      },
      source_sequence: 7,
    };
    break;
  case "ref resolve":
    reply = { ok: true };
    break;
  case "cat":
    if (process.env.FAKE_SP_DENY_VOLUME === flags["volume-id"]) {
      refuse("permission_denied", "no grant covers this read", 13);
    }
    reply = {
      data_base64: Buffer.from(
        state[flags.path] ?? `content of ${flags["volume-id"]}@${flags.root}${flags.path}`,
      ).toString("base64"),
    };
    break;
  case "grant issue":
    reply = {
      grant: {
        id: `grant-${now}`,
        volume_id: flags["volume-id"],
        grantee: { account: flags["grantee-account"], user: flags["grantee-user"] },
        scope: { subtree: flags.subtree },
        actions: (flags.actions ?? "").split(","),
        expires_at: Number(flags["expires-at"]),
      },
      source_sequence: 9,
    };
    break;
  default:
    refuse("invalid_request", `unknown command ${verb}`, 10);
}
process.stdout.write(`${JSON.stringify(reply)}\n`);
