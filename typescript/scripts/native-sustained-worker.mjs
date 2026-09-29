// JSON-lines worker for scripts/native-sustained.py. Use the public client only.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { nativeScratchPad, scratchPadReader } from "../dist/index.js";

const language = "typescript";
const languageId = 1;
const chunkBytes = 524_288;
const maxWatchSamples = 1900;
const privateValues = new Set();
let config, options, directory, grantTtlSeconds, ownerConnection, readerConnection, pad, reader;
let watcher;

function requireValue(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: "invalid" });
}

function errorValue(error) {
  let message = error instanceof Error ? error.message : "worker operation failed";
  for (const secret of privateValues) message = message.split(secret).join("[redacted]");
  message = message.replace(/(nats:\/\/)[^/@\s]+@/g, "$1[redacted]@");
  const result = {
    code:
      typeof error?.code === "string" && /^[a-zA-Z0-9_-]+$/.test(error.code)
        ? error.code
        : "worker_error",
    message,
  };
  if (typeof error?.unknown === "boolean") result.unknown = error.unknown;
  if (typeof error?.local === "boolean") result.local = error.local;
  if (error?.code === "watch_failed") {
    result.samples = error.samples;
    result.failures = error.failures;
  }
  return result;
}

async function authenticatedConnection(url, credentials) {
  const bytes = await readFile(credentials);
  const content = bytes.toString("utf8");
  privateValues.add(content);
  for (const line of content.split(/\r?\n/)) {
    if (line && !line.startsWith("-")) privateValues.add(line);
  }
  return connect({ servers: url, authenticator: credsAuthenticator(bytes), reconnect: false });
}

async function grant(reference) {
  const grantee = { account: config.users.reader.account, user: config.users.reader.user };
  await pad.grantRead(reference, grantee);
  // The public method validates the reference. Decode its public JSON envelope
  // only to identify the exact grant in the subsequent service observation.
  const ref = JSON.parse(Buffer.from(reference.slice("sp-ref:".length), "base64url").toString());
  const description = await pad.describe();
  const matches = description.volume.grants
    .map((slot) => slot.grant)
    .filter(
      (item) =>
        item &&
        item.principal.account === grantee.account &&
        item.principal.user === grantee.user &&
        item.root === ref.root &&
        item.path === ref.path &&
        !item.directory &&
        item.retention.slot === ref.retention.slot &&
        item.retention.generation === ref.retention.generation,
    );
  requireValue(matches.length === 1, "expected exactly one observed handoff grant");
  return { until: matches[0].until };
}

async function read(reference, limitBytes) {
  requireValue(
    Number.isSafeInteger(limitBytes) && limitBytes > 0,
    "read needs a positive byte limit",
  );
  const monotonicStartMs = performance.now();
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of reader.readStream(reference, { limitBytes })) {
      bytes += chunk.length;
      digest.update(chunk);
    }
  } catch (error) {
    const monotonicEndMs = performance.now();
    return {
      bytes,
      sha256: digest.digest("hex"),
      monotonicStartMs,
      monotonicEndMs,
      durationMs: monotonicEndMs - monotonicStartMs,
      error: errorValue(error),
    };
  }
  const monotonicEndMs = performance.now();
  return {
    bytes,
    sha256: digest.digest("hex"),
    monotonicStartMs,
    monotonicEndMs,
    durationMs: monotonicEndMs - monotonicStartMs,
  };
}

async function publish(request) {
  requireValue(
    Number.isInteger(request.cycle) && request.cycle >= 0 && request.cycle <= 0xffffffff,
    "cycle must be an unsigned 32-bit integer",
  );
  requireValue(
    [1 << 20, 8 << 20, 32 << 20].includes(request.bytes),
    "artifact size outside workload contract",
  );
  requireValue(
    request.operationId === `sustained-${language}-${request.cycle}`,
    "publication operation ID differs from the fixed workload",
  );
  const digest = createHash("sha256");
  let inputBytes = 0;
  function* chunks() {
    for (let index = 0; index < request.bytes / chunkBytes; index++) {
      const chunk = Buffer.alloc(chunkBytes, (languageId * 67 + request.cycle * 17 + index) % 256);
      chunk.writeUInt32BE(languageId, 0);
      chunk.writeUInt32BE(request.cycle, 4);
      chunk.writeUInt32BE(index, 8);
      digest.update(chunk);
      inputBytes += chunk.length;
      yield chunk;
    }
  }
  let last = performance.now(),
    maxGapMs = 0,
    samples = 0;
  let ready;
  const samplingStarted = new Promise((resolve) => {
    ready = resolve;
  });
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
    samples++;
    ready();
  }, 5);
  await samplingStarted;
  const begin = performance.now();
  let publication, failure, publishMs;
  try {
    try {
      publication = await pad.publishStream(chunks(), "/artifact.bin", {
        operationId: request.operationId,
        ttlSeconds: 3600,
      });
    } catch (error) {
      failure = errorValue(error);
    }
    publishMs = performance.now() - begin;
    // Let the timer observe synchronous work at the end, including a refusal.
    await delay(5);
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
  } finally {
    clearInterval(timer);
  }
  return {
    inputBytes,
    sha256: digest.digest("hex"),
    publishMs,
    samples,
    maxGapMs,
    ...(failure ? { error: failure } : { publication }),
  };
}

function startWatch(request) {
  requireValue(!watcher, "a canary watch is already active");
  requireValue(
    Number.isSafeInteger(request.bytes) &&
      request.bytes > 0 &&
      typeof request.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(request.sha256),
    "watch needs an exact size and SHA-256 digest",
  );
  const state = {
    monotonicStartMs: performance.now(),
    samples: [],
    failures: [],
    maintenance: false,
    stopping: false,
    wake: undefined,
    task: undefined,
  };
  watcher = state;
  state.task = (async () => {
    let deadline = performance.now();
    while (!state.stopping) {
      if (state.samples.length + state.failures.length >= maxWatchSamples) {
        state.failures.push({
          error: { code: "watch_capacity", message: "canary evidence reached its sample limit" },
        });
        return;
      }
      const maintenanceAtStart = state.maintenance;
      const measured = await read(request.reference, request.bytes);
      const maintenanceAtEnd = state.maintenance;
      const sample = { ...measured, maintenanceAtStart, maintenanceAtEnd };
      if (measured.error) {
        if (measured.error.code === "closed" && (maintenanceAtStart || maintenanceAtEnd)) {
          delete sample.error;
          state.samples.push({ ...sample, outcome: "closed" });
        } else state.failures.push(sample);
      } else if (measured.bytes !== request.bytes || measured.sha256 !== request.sha256) {
        state.failures.push({
          ...sample,
          error: {
            code: "content_mismatch",
            message: "canary bytes differ from the expected size or SHA-256 digest",
          },
        });
      } else state.samples.push({ ...sample, outcome: "ok" });
      deadline += 1000;
      if (!state.stopping) {
        await new Promise((resolve) => {
          const timer = setTimeout(
            () => {
              state.wake = undefined;
              resolve();
            },
            Math.max(0, deadline - performance.now()),
          );
          state.wake = () => {
            clearTimeout(timer);
            state.wake = undefined;
            resolve();
          };
        });
      }
    }
  })().catch((error) => {
    state.failures.push({ error: errorValue(error) });
  });
  return { watching: true, monotonicStartMs: state.monotonicStartMs };
}

async function stopWatch() {
  requireValue(watcher, "no canary watch is active");
  const state = watcher;
  state.stopping = true;
  state.wake?.();
  await state.task;
  const monotonicEndMs = performance.now();
  watcher = undefined;
  if (state.failures.length) {
    throw Object.assign(new Error("canary watch recorded unexpected results"), {
      code: "watch_failed",
      samples: state.samples,
      failures: state.failures,
    });
  }
  return { samples: state.samples, monotonicStartMs: state.monotonicStartMs, monotonicEndMs };
}

async function fileBytes(file, required = false) {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if (!required && error.code === "ENOENT") return 0;
    throw error;
  }
}

async function close() {
  let failure;
  if (watcher) {
    try {
      await stopWatch();
    } catch (error) {
      failure = error;
    }
  }
  for (const resource of [pad, ownerConnection, readerConnection]) {
    try {
      await resource?.close();
    } catch (error) {
      failure ??= error;
    }
  }
  pad = reader = ownerConnection = readerConnection = undefined;
  if (failure) throw failure;
}

async function command(request) {
  if (request.command === "open") {
    requireValue(!pad && !ownerConnection && !readerConnection, "worker is already open");
    ({ config, directory, grantTtlSeconds } = request);
    requireValue(
      Number.isInteger(grantTtlSeconds) && grantTtlSeconds > 0,
      "grant TTL must be positive",
    );
    try {
      ownerConnection = await authenticatedConnection(
        config.fault_url,
        config.users.owner.credentials,
      );
      readerConnection = await authenticatedConnection(config.url, config.users.reader.credentials);
      options = {
        nc: ownerConnection,
        volume: request.volume,
        dir: directory,
        creator: `agents.native.sustained.${language}`,
        timeoutMs: 2000,
      };
      pad = await nativeScratchPad({ ...options, ttlSeconds: grantTtlSeconds });
      reader = await scratchPadReader({ nc: readerConnection, timeoutMs: 2000 });
      return { description: await pad.describe(), pid: process.pid };
    } catch (error) {
      await close();
      throw error;
    }
  }
  if (request.command === "stop") {
    await close();
    return { stopped: true };
  }
  requireValue(pad && reader, "open the worker before issuing commands");
  switch (request.command) {
    case "canary": {
      await pad.close();
      pad = undefined;
      pad = await nativeScratchPad({ ...options, ttlSeconds: 3600 });
      try {
        const bytes = Buffer.alloc(4096, languageId);
        const publication = await pad.publishBytes(bytes, "/canary.bin", {
          operationId: `canary-${language}`,
          ttlSeconds: 3600,
        });
        await grant(publication.reference);
        return {
          publication,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      } finally {
        await pad.close();
        pad = undefined;
        pad = await nativeScratchPad({ ...options, ttlSeconds: grantTtlSeconds });
      }
    }
    case "publish":
      return publish(request);
    case "grant":
      return grant(request.reference);
    case "read": {
      const measured = await read(request.reference, request.bytes);
      if (measured.error) throw Object.assign(new Error(measured.error.message), measured.error);
      return measured;
    }
    case "release":
      await pad.release(request.reference);
      return { released: true };
    case "maintain": {
      const before = (await pad.describe()).volume;
      const begin = performance.now();
      const after = await pad.maintain();
      return { before, after, durationMs: performance.now() - begin };
    }
    case "recover":
      return pad.recover();
    case "inspect":
      return {
        description: await pad.describe(),
        databaseBytes: await fileBytes(join(directory, "scratchpad.sqlite"), true),
        walBytes: await fileBytes(join(directory, "scratchpad.sqlite-wal")),
        journalBytes: await fileBytes(join(directory, "scratchpad.sqlite-journal")),
        maxRssBytes: process.resourceUsage().maxRSS * 1024,
      };
    case "watch":
      return startWatch(request);
    case "watch-phase":
      requireValue(
        watcher && typeof request.maintenance === "boolean",
        "watch-phase needs an active watch and a boolean",
      );
      watcher.maintenance = request.maintenance;
      return { maintenance: watcher.maintenance };
    case "watch-stop":
      return stopWatch();
    default:
      throw Object.assign(new Error("unknown worker command"), { code: "invalid" });
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    let request;
    try {
      try {
        request = JSON.parse(line);
      } catch {
        throw Object.assign(new Error("request is not valid JSON"), { code: "invalid" });
      }
      requireValue(
        request &&
          typeof request === "object" &&
          (typeof request.id === "string" || Number.isSafeInteger(request.id)),
        "request needs an ID",
      );
      const value = await command(request);
      process.stdout.write(JSON.stringify({ id: request.id, value }) + "\n");
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ id: request?.id ?? null, error: errorValue(error) }) + "\n",
      );
    }
    if (request?.command === "stop") break;
  }
} finally {
  lines.close();
  try {
    await close();
  } catch (error) {
    process.stderr.write(JSON.stringify(errorValue(error)) + "\n");
    process.exitCode = 1;
  }
}
