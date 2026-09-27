import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeScratchPad, scratchPadReader } from "../../src/scratchpad-native.js";
import { decodeReference, encodeReference } from "../../src/scratchpad-native/codec.js";
import type { Receipt } from "../../src/scratchpad-native/protocol.js";
import { NativeServiceFixture } from "../harness/scratchpad-native.js";
import { startNativeWorker } from "../harness/scratchpad-native-worker.js";

const coreRoot = process.env["SCRATCHPAD_CORE_ROOT"];
const bytesFor = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, index) => index % 251);
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe.skipIf(!coreRoot)("native ScratchPad against the real public service", () => {
  let fixture: NativeServiceFixture;
  let directory: string;
  let emptyPath: string;
  let ownerNC: NatsConnection;
  let readerNC: NatsConnection;
  let intruderNC: NatsConnection;
  let pad: Awaited<ReturnType<typeof nativeScratchPad>> | undefined;
  let finalCounts: Record<string, number> | undefined;
  const connections: NatsConnection[] = [];
  const workers: ReturnType<typeof startNativeWorker>[] = [];

  beforeAll(async () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(22);
    fixture = await NativeServiceFixture.start(coreRoot!);
    directory = await mkdtemp(join(tmpdir(), "scratchpad-native-client-"));
    emptyPath = join(directory, "no-executables");
    await mkdir(emptyPath, { mode: 0o700 });
    async function as(user: "owner" | "reader" | "intruder"): Promise<NatsConnection> {
      const nc = await connect({
        servers: fixture.config.url,
        authenticator: credsAuthenticator(await readFile(fixture.config.users[user].credentials)),
        reconnect: false,
      });
      connections.push(nc);
      await nc.flush();
      return nc;
    }
    ownerNC = await as("owner");
    readerNC = await as("reader");
    intruderNC = await as("intruder");
  }, 120_000);

  afterAll(async () => {
    for (const worker of workers) await worker.kill();
    await pad?.close();
    for (const nc of connections) await nc.close();
    if (fixture && !finalCounts)
      console.info("NATIVE_CLIENT_SERVICE", JSON.stringify(await fixture.close()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("round-trips multiple chunks, enforces grants, interoperates with Go, and recovers after SIGKILL", async () => {
    const stateDirectory = join(directory, "owner-state");
    await mkdir(stateDirectory, { mode: 0o700 });
    const creator = "agents.native.fixture";
    pad = await nativeScratchPad({
      nc: ownerNC,
      volume: fixture.config.volume,
      dir: stateDirectory,
      creator,
      timeoutMs: 5000,
    });
    const reader = await scratchPadReader({ nc: readerNC, timeoutMs: 5000 });
    const intruder = await scratchPadReader({ nc: intruderNC, timeoutMs: 5000 });
    const ownerReader = await scratchPadReader({ nc: ownerNC, timeoutMs: 5000 });
    const payload = bytesFor(1024 * 1024 + 137);
    const published = await pad.publishBytes(payload, "/payload/report.bin", {
      operationId: "native-roundtrip",
      ttlSeconds: 600,
    });
    await expect(
      nativeScratchPad({
        nc: ownerNC,
        volume: fixture.config.volume,
        dir: stateDirectory,
        creator,
      }),
    ).rejects.toMatchObject({ code: "busy", local: true });
    const lockProbe = startNativeWorker(
      {
        url: fixture.config.url,
        credentials: fixture.config.users.owner.credentials,
        volume: fixture.config.volume,
        dir: stateDirectory,
        creator,
        timeoutMs: 5000,
        bytes: 0,
        path: "/unused",
        operationId: "lock-probe",
        emptyPath,
      },
      "lock-probe",
    );
    workers.push(lockProbe);
    const lockRefusal = await lockProbe.event();
    expect(lockRefusal).toEqual({
      event: "refused",
      code: "busy",
      local: true,
      successfulOpens: 0,
    });
    expect(await lockProbe.exited()).toEqual({ code: 0, signal: null });
    const missingJournal = join(directory, "missing-journal");
    await mkdir(missingJournal, { mode: 0o700 });
    const beforeRefusal = await pad.describe();
    const unjournaled = await nativeScratchPad({
      nc: ownerNC,
      volume: fixture.config.volume,
      dir: missingJournal,
      creator,
    });
    try {
      await expect(
        unjournaled.publishBytes(bytesFor(3), "/refused.bin", {
          operationId: "missing-journal-must-refuse",
        }),
      ).rejects.toMatchObject({ code: "exists" });
    } finally {
      await unjournaled.close();
    }
    expect((await pad.describe()).volume).toEqual(beforeRefusal.volume);
    expect(pad.owns(published.reference)).toBe(true);
    expect(published.receipt.principal).toEqual({
      account: fixture.config.users.owner.account,
      user: fixture.config.users.owner.user,
    });
    await expect(reader.readBytes(published.reference)).rejects.toMatchObject({
      code: "denied",
      local: false,
    });
    await pad.grantRead(published.reference, {
      account: fixture.config.users.reader.account,
      user: fixture.config.users.reader.user,
    });
    await expect(pad.release(published.reference)).rejects.toMatchObject({ code: "busy" });
    const received = await reader.readBytes(published.reference, {
      limitBytes: payload.byteLength,
    });
    expect(Uint8Array.from(received)).toEqual(payload);
    const streamedDigest = createHash("sha256");
    let streamedBytes = 0;
    let streamedChunks = 0;
    for await (const chunk of reader.readStream(published.reference, {
      limitBytes: payload.byteLength,
    })) {
      streamedDigest.update(chunk);
      streamedBytes += chunk.byteLength;
      streamedChunks++;
    }
    expect(streamedBytes).toBe(payload.byteLength);
    expect(streamedDigest.digest("hex")).toBe(digest(payload));
    expect(streamedChunks).toBeGreaterThanOrEqual(3);
    await expect(intruder.readBytes(published.reference)).rejects.toMatchObject({
      code: "denied",
      local: false,
    });
    const parentReference = encodeReference({
      ...decodeReference(published.reference),
      path: "/payload",
    });
    await expect(reader.readBytes(parentReference)).rejects.toMatchObject({
      code: "denied",
      local: false,
    });
    const siblingReference = encodeReference({
      ...decodeReference(published.reference),
      path: "/payload/other.bin",
    });
    await expect(reader.readBytes(siblingReference)).rejects.toMatchObject({
      code: "denied",
      local: false,
    });
    const goRead = await fixture.command<{ bytes: number; sha256: string }>("go_read", {
      user: "reader",
      reference: published.reference,
    });
    expect(goRead).toMatchObject({ bytes: payload.byteLength, sha256: digest(payload) });
    const goPublished = await fixture.command<{ reference: string; bytes: number; sha256: string }>(
      "go_publish",
      {
        path: "/from-go.bin",
        bytes: 4097,
      },
    );
    const fromGo = await reader.readBytes(goPublished.reference);
    expect(Uint8Array.from(fromGo)).toEqual(bytesFor(goPublished.bytes));
    expect(digest(fromGo)).toBe(goPublished.sha256);

    await pad.close();
    pad = undefined;
    expect(ownerNC.isClosed()).toBe(false);
    await fixture.command("drop_publish", { operation_id: "native-lost-publish" });
    const workerOptions = {
      url: fixture.config.fault_url,
      credentials: fixture.config.users.owner.credentials,
      volume: fixture.config.volume,
      dir: stateDirectory,
      creator,
      timeoutMs: 1000,
      bytes: 1024 * 1024 + 157,
      path: "/payload/recovered.bin",
      operationId: "native-lost-publish",
      emptyPath,
    };
    const lost = startNativeWorker(workerOptions, "publish");
    workers.push(lost);
    expect(await lost.event()).toMatchObject({ event: "unknown", unknown: true });
    const accepted = await fixture.command<{ receipt: Receipt }>("accepted", {
      operation_id: workerOptions.operationId,
    });
    expect(accepted.receipt.command.operation_id).toBe(workerOptions.operationId);
    expect(await lost.kill()).toEqual({ code: null, signal: "SIGKILL" });
    pad = await nativeScratchPad({
      nc: ownerNC,
      volume: fixture.config.volume,
      dir: stateDirectory,
      creator,
      timeoutMs: 5000,
    });
    const beforeStaleReset = await pad.describe();
    expect(beforeStaleReset.pending).toBe("publish");
    await expect(
      pad.resetWriter({ expectedGeneration: accepted.receipt.command.writer.generation - 1 }),
    ).rejects.toMatchObject({ code: "fenced", local: false });
    expect(await pad.describe()).toEqual(beforeStaleReset);
    await pad.close();
    pad = undefined;
    await fixture.command("restart_service");
    const resumed = startNativeWorker(
      { ...workerOptions, url: fixture.config.url, timeoutMs: 5000 },
      "recover",
    );
    workers.push(resumed);
    const event = await resumed.event();
    expect(event["event"]).toBe("recovered");
    const recovered = event["result"] as { kind: string; reference: string; receipt: Receipt };
    expect(recovered.kind).toBe("publish");
    expect(recovered.receipt).toEqual(accepted.receipt);
    expect(decodeReference(recovered.reference)).toMatchObject({
      path: workerOptions.path,
      root: accepted.receipt.head.root,
      generation: accepted.receipt.head.generation,
      retention: accepted.receipt.retention,
      expires_at: accepted.receipt.command.retention.until,
    });
    expect(await resumed.exited()).toEqual({ code: 0, signal: null });
    const recoveredBytes = await ownerReader.readBytes(recovered.reference, {
      limitBytes: workerOptions.bytes,
    });
    expect(Uint8Array.from(recoveredBytes)).toEqual(bytesFor(workerOptions.bytes));
    const goRecovered = await fixture.command<{ bytes: number; sha256: string }>("go_read", {
      user: "owner",
      reference: recovered.reference,
    });
    expect(goRecovered).toMatchObject({
      bytes: workerOptions.bytes,
      sha256: digest(recoveredBytes),
    });
    pad = await nativeScratchPad({
      nc: ownerNC,
      volume: fixture.config.volume,
      dir: stateDirectory,
      creator,
      timeoutMs: 5000,
    });
    await pad.release(recovered.reference);
    const reusedSlots = new Set<number>();
    for (let cycle = 0; cycle < 10; cycle++) {
      const value = bytesFor(513 + cycle);
      const item = await pad.publishBytes(value, "/reuse.bin", {
        operationId: `native-reuse-${cycle}`,
        ttlSeconds: 600,
      });
      expect(Uint8Array.from(await ownerReader.readBytes(item.reference))).toEqual(value);
      reusedSlots.add(item.receipt.retention.slot);
      await pad.release(item.reference);
      const view = await pad.maintain();
      expect(view.closed).toBe(false);
      expect(view.retentions.filter((slot) => slot.pin)).toHaveLength(1);
    }
    expect(reusedSlots.size).toBe(1);
    const retained: string[] = [];
    for (let slot = 0; slot < 7; slot++) {
      retained.push(
        (
          await pad.publishBytes(bytesFor(20 + slot), "/capacity.bin", {
            operationId: `native-retention-capacity-${slot}`,
            ttlSeconds: 600,
          })
        ).reference,
      );
    }
    const full = await pad.describe();
    expect(full.volume.retentions.filter((slot) => slot.pin)).toHaveLength(8);
    await expect(
      pad.publishBytes(bytesFor(42), "/refused-capacity.bin", {
        operationId: "native-ninth-retention",
        ttlSeconds: 600,
      }),
    ).rejects.toMatchObject({ code: "capacity" });
    expect(await pad.describe()).toEqual(full);
    for (const reference of retained) await pad.release(reference);
    await pad.maintain();
    await pad.close();
    const faultNC = await connect({
      servers: fixture.config.fault_url,
      authenticator: credsAuthenticator(await readFile(fixture.config.users.owner.credentials)),
      reconnect: false,
    });
    connections.push(faultNC);
    await faultNC.flush();
    pad = await nativeScratchPad({
      nc: faultNC,
      volume: fixture.config.volume,
      dir: stateDirectory,
      creator,
      timeoutMs: 1000,
    });
    await fixture.command("drop_next_publish");
    await expect(
      pad.commit("first commit survived", "/first-commit.txt", undefined),
    ).rejects.toMatchObject({ unknown: true });
    const firstCommit = await fixture.command<{ receipt: Receipt }>("accepted_latest");
    expect((await pad.describe()).pending).toBe("publish");
    const secondReference = await pad.commit(
      "second commit succeeded",
      "/second-commit.txt",
      undefined,
    );
    expect(await ownerReader.read(secondReference)).toBe("second commit succeeded");
    const afterCommit = await pad.describe();
    expect(afterCommit.pending).toBeUndefined();
    expect(afterCommit.volume.writers[0]!.receipt!.command).toMatchObject({
      number: firstCommit.receipt.command.number + 1,
      base: firstCommit.receipt.head,
    });
    const firstReference = encodeReference({
      ...decodeReference(secondReference),
      root: firstCommit.receipt.head.root,
      generation: firstCommit.receipt.head.generation,
      retention: firstCommit.receipt.retention,
      expires_at: firstCommit.receipt.command.retention.until,
      path: "/first-commit.txt",
    });
    expect(await ownerReader.read(firstReference)).toBe("first commit survived");
    await pad.close();
    pad = undefined;
    finalCounts = await fixture.close();
    expect(finalCounts).toEqual({
      commands: 9,
      accepted_receipts: 2,
      dropped_replies: 2,
      go_publications: 1,
      go_reads: 2,
      service_restarts: 1,
    });
    console.info(
      "NATIVE_CLIENT",
      JSON.stringify({
        bytes: payload.byteLength,
        streamedBytes,
        streamedChunks,
        recoveredBytes: recoveredBytes.byteLength,
        deniedReads: 4,
        goReads: finalCounts["go_reads"],
        goPublications: finalCounts["go_publications"],
        actualDroppedReceipts: finalCounts["dropped_replies"],
        killedClients: 1,
        serviceRestarts: finalCounts["service_restarts"],
        exactRecoveredReceipts: 1,
        workerPathExecutables: 0,
        lockedWorkspaceRefusals: 2,
        liveProcessLockRefusals: 1,
        competingProcessSuccessfulOpens: lockRefusal["successfulOpens"],
        missingJournalRefusals: 1,
        liveGrantReleaseRefusals: 1,
        retentionReuseCycles: 10,
        reusedRetentionSlots: reusedSlots.size,
        staleResetPreservedPending: 1,
        liveRetentionsAtCapacity: full.volume.retentions.filter((slot) => slot.pin).length,
        fullRetentionRefusalsWithoutMutation: 1,
        implicitCommitRecoveries: 1,
        fixture: finalCounts,
      }),
    );
  }, 60_000);
});
