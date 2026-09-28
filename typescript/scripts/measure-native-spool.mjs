// Called by scripts/measure-native-spool.py with a real temporary service.
// Measure the entire publication; every pause cannot be attributed to SQLite.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { nativeScratchPad, scratchPadReader } from "../dist/index.js";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { config, directory, cycles } = JSON.parse(input);
assert(Number.isInteger(cycles) && cycles >= 1 && cycles <= 10);
const nc = await connect({
  servers: config.url,
  authenticator: credsAuthenticator(await readFile(config.users.owner.credentials)),
  reconnect: false,
});
const options = {
  nc,
  volume: config.volume,
  creator: "agents.native.spool-measurement",
  dir: directory,
};
let pad;
try {
  pad = await nativeScratchPad(options);
  await pad.describe();
  const reader = await scratchPadReader({ nc });
  for (let cycle = 0; cycle < cycles; cycle++) {
    const expected = createHash("sha256");
    let inputBytes = 0;
    function* chunks() {
      for (let index = 0; index < 14; index++) {
        const bytes = Buffer.alloc(512 * 1024, cycle * 16 + index);
        expected.update(bytes);
        inputBytes += bytes.length;
        yield bytes;
      }
    }
    const sampleStart = performance.now();
    let last = sampleStart,
      maxGap = 0,
      samples = 0,
      peakRss = 0;
    let ready;
    const started = new Promise((resolve) => {
      ready = resolve;
    });
    const timer = setInterval(() => {
      const at = performance.now();
      maxGap = Math.max(maxGap, at - last);
      last = at;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      samples++;
      ready();
    }, 5);
    let publication, publishMs, sampleEnd;
    try {
      await started;
      const begin = performance.now();
      publication = await pad.publishStream(chunks(), "/large.bin", {
        operationId: "spool-" + cycle,
      });
      publishMs = performance.now() - begin;
      await delay(5); // Observe the event loop after the last synchronous work.
      sampleEnd = performance.now();
    } finally {
      clearInterval(timer);
    }
    assert(samples >= 2);
    assert.equal(inputBytes, 7 * 1024 * 1024);
    const actual = createHash("sha256");
    let readBytes = 0;
    for await (const chunk of reader.readStream(publication.reference, {
      limitBytes: inputBytes,
    })) {
      actual.update(chunk);
      readBytes += chunk.length;
    }
    assert.equal(readBytes, inputBytes);
    const sha256 = expected.digest("hex");
    assert.equal(actual.digest("hex"), sha256);
    const occupied = (await pad.describe()).volume;
    await pad.release(publication.reference);
    const marker = await pad.publishBytes(
      new TextEncoder().encode("cycle " + cycle),
      "/marker.txt",
      { operationId: "marker-" + cycle },
    );
    await pad.release(marker.reference);
    const beforeCollection = (await pad.describe()).volume;
    const collected = await pad.maintain();
    assert(collected.bytes < occupied.bytes);
    assert(collected.objects < occupied.objects);
    await pad.close();
    const databaseBytes = (await stat(join(directory, "scratchpad.sqlite"))).size;
    console.info(
      "NATIVE_SPOOL_RESULT",
      JSON.stringify({
        language: "typescript",
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        cycle,
        artifactBytes: inputBytes,
        verifiedBytes: readBytes,
        sha256,
        publishMs,
        sampleWindowMs: sampleEnd - sampleStart,
        requestedSampleMs: 5,
        samples,
        maxSchedulingGapMs: maxGap,
        peakSampledRssBytes: peakRss,
        closedDatabaseBytes: databaseBytes,
        collectedBytes: beforeCollection.bytes - collected.bytes,
        collectedObjects: beforeCollection.objects - collected.objects,
        writerCommand: marker.receipt.command.number,
      }),
    );
    pad = await nativeScratchPad(options);
    assert.equal((await pad.describe()).pending, undefined);
  }
} finally {
  try {
    await pad?.close();
  } finally {
    await nc.close();
  }
}
