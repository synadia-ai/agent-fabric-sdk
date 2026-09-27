// Run the built public package in a separate Node process. The parent removes
// executables from PATH and kills this process after a real unknown outcome.
import { readFile } from "node:fs/promises";

const [sdkURL, transportURL, encodedOptions, mode] = process.argv.slice(2);
const { nativeScratchPad } = await import(sdkURL);
const { connect, credsAuthenticator } = await import(transportURL);
const options = JSON.parse(encodedOptions);
const nc = await connect({
  servers: options.url,
  authenticator: credsAuthenticator(await readFile(options.credentials)),
  reconnect: false,
});
await nc.flush();
const pad = await nativeScratchPad({
  nc,
  volume: options.volume,
  dir: options.dir,
  creator: options.creator,
  timeoutMs: options.timeoutMs,
});

if (mode === "publish") {
  const bytes = Uint8Array.from({ length: options.bytes }, (_, index) => index % 251);
  try {
    const result = await pad.publishBytes(bytes, options.path, {
      operationId: options.operationId,
      ttlSeconds: 600,
    });
    console.log(JSON.stringify({ event: "unexpected_success", result }));
    process.exitCode = 2;
    await pad.close();
    await nc.close();
  } catch (error) {
    if (!error.unknown) throw error;
    console.log(JSON.stringify({ event: "unknown", code: error.code, unknown: error.unknown }));
    process.stdin.resume();
    await new Promise(() => {});
  }
} else if (mode === "recover") {
  const result = await pad.recover();
  console.log(JSON.stringify({ event: "recovered", result }));
  await pad.close();
  await nc.close();
} else {
  throw new Error("worker needs an explicit publish or recover mode");
}
