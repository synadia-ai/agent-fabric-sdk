// Mints the caller fixtures from caller-permissions.json: erin.creds (an ACME
// user with exactly those permissions) and erin-no-user-info.creds (the same
// without $SYS.REQ.USER.INFO). erin's user nkey is the one ../keys.json names;
// ACME's seed is in keys.json here. One-off: no JWT library is a dependency of
// the packages. From a scratch directory with @nats-io/jwt@0.0.10-5 installed:
//
//   node <this repo>/test-fixtures/identity/operator/mint-callers.mjs
//
// run with that directory as the working directory, so the import resolves.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(join(process.cwd(), "noop.js"));
const { Algorithms, encodeUser, fmtCreds, fromSeed } = require("@nats-io/jwt");

const HERE = dirname(fileURLToPath(import.meta.url));
const enc = new TextEncoder();
const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const perms = read(join(HERE, "caller-permissions.json"));
const acme = fromSeed(enc.encode(read(join(HERE, "keys.json")).accounts.ACME.seed));
const erin = fromSeed(enc.encode(read(join(HERE, "..", "keys.json")).users.erin.seed));

async function mint(file, pub) {
  const jwt = await encodeUser(
    "erin",
    erin,
    acme,
    { pub: { allow: pub }, sub: { allow: perms.sub } },
    { algorithm: Algorithms.v2 },
  );
  writeFileSync(join(HERE, file), fmtCreds(jwt, erin));
}

await mint("erin.creds", perms.pub);
await mint(
  "erin-no-user-info.creds",
  perms.pub.filter((s) => s !== "$SYS.REQ.USER.INFO"),
);
