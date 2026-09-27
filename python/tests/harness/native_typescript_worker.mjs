// Test-only bridge through the already qualified TypeScript public package.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [packageRoot, mode, encoded] = process.argv.slice(2);
const options = JSON.parse(encoded);
const require = createRequire(resolve(packageRoot, "package.json"));
const { connect, credsAuthenticator } = await import(
  pathToFileURL(require.resolve("@nats-io/transport-node")).href
);
const { nativeScratchPad, scratchPadReader } = await import(
  pathToFileURL(resolve(packageRoot, "dist/index.js")).href
);
const nc = await connect({
  servers: options.url,
  authenticator: credsAuthenticator(await readFile(options.credentials)),
  reconnect: false,
});
await nc.flush();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (mode === "read") {
  const reader = await scratchPadReader({ nc });
  const bytes = await reader.readBytes(options.reference, {
    limitBytes: options.bytes,
  });
  console.log(
    JSON.stringify({
      event: "read",
      bytes: bytes.length,
      sha256: digest(bytes),
    }),
  );
} else if (mode === "publish") {
  const pad = await nativeScratchPad({
    nc,
    volume: options.volume,
    dir: options.dir,
    creator: "agents.ts.python.interop",
  });
  const bytes = Uint8Array.from(
    { length: options.bytes },
    (_, index) => index % 251,
  );
  const result = await pad.publishBytes(bytes, "/from-typescript.bin", {
    operationId: "typescript-python-interop",
    ttlSeconds: 600,
  });
  await pad.grantRead(result.reference, options.grantee);
  console.log(
    JSON.stringify({
      event: "published",
      ...result,
      bytes: bytes.length,
      sha256: digest(bytes),
    }),
  );
  await pad.close();
} else {
  throw new Error("TypeScript worker needs read or publish mode");
}
await nc.close();
