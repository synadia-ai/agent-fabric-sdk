import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { describe, expect, it } from "vitest";
import { nativeScratchPad, scratchPadReader } from "../../src/scratchpad-native.js";
import type { Receipt, VolumeView } from "../../src/scratchpad-native/protocol.js";
import { deadline, NativeServiceFixture } from "../harness/scratchpad-native.js";

const coreRoot = process.env["SCRATCHPAD_CORE_ROOT"];
type Pad = Awaited<ReturnType<typeof nativeScratchPad>>;
type ControlKind = "grant" | "close" | "apply";
interface ControlStatus {
  verb: string;
  request: Record<string, unknown>;
  reply: Record<string, unknown>;
  view: VolumeView;
  control_requests: number;
  same_requests: number;
  dropped_control_replies: number;
  dropped_observation_replies: number;
}

async function withFixture(
  run: (fixture: NativeServiceFixture, directory: string) => Promise<void>,
): Promise<void> {
  const fixture = await NativeServiceFixture.start(coreRoot!);
  const directory = await mkdtemp(join(tmpdir(), "scratchpad-native-controls-"));
  try {
    await run(fixture, directory);
  } finally {
    try {
      console.info("NATIVE_CONTROL_SERVICE", JSON.stringify(await fixture.close()));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function owner(fixture: NativeServiceFixture, reconnect = false): Promise<NatsConnection> {
  const nc = await connect({
    servers: reconnect ? [fixture.config.fault_url, fixture.config.url] : fixture.config.fault_url,
    noRandomize: true,
    authenticator: credsAuthenticator(await readFile(fixture.config.users.owner.credentials)),
    reconnect,
    reconnectTimeWait: 50,
    reconnectJitter: 0,
    maxReconnectAttempts: 10,
  });
  await nc.flush();
  return nc;
}

function options(fixture: NativeServiceFixture, nc: NatsConnection, directory: string) {
  return {
    nc,
    volume: fixture.config.volume,
    creator: "agents.native.control-fixture",
    dir: join(directory, "writer"),
    timeoutMs: 1000,
  };
}

describe.skipIf(!coreRoot)("native control recovery through the actual service", () => {
  it.each<[ControlKind, string]>([
    ["grant", "grant.issue"],
    ["close", "maintenance.close"],
    ["apply", "maintenance.apply"],
  ])(
    "recovers an accepted %s after losing its reply and reopening the workspace",
    async (kind, verb) => {
      await withFixture(async (fixture, directory) => {
        const nc = await owner(fixture);
        let pad: Pad | undefined;
        try {
          pad = await nativeScratchPad(options(fixture, nc, directory));
          const old = await pad.publishBytes(
            new TextEncoder().encode("obsolete payload"),
            "/old.txt",
            {
              operationId: "old-publication",
            },
          );
          await pad.release(old.reference);
          const data = new TextEncoder().encode("retained exact payload");
          const published = await pad.publishBytes(data, "/result.txt", {
            operationId: "protected-publication",
          });
          const before = (await pad.describe()).volume;
          const grantee = {
            account: fixture.config.users.reader.account,
            user: fixture.config.users.reader.user,
          };
          expect(await fixture.command("drop_control", { verb })).toEqual({ armed: verb });
          const operation =
            kind === "grant" ? pad.grantRead(published.reference, grantee) : pad.maintain();
          await expect(operation).rejects.toMatchObject({ unknown: true });
          const captured = await fixture.command<ControlStatus>("control_status");
          expect(captured).toMatchObject({
            verb,
            control_requests: 1,
            same_requests: 1,
            dropped_control_replies: 1,
            dropped_observation_replies: 1,
          });
          expect(captured.view.closed).toBe(kind === "close");
          expect(captured.view.head).toEqual(before.head);
          expect((await pad.describe()).pending).toBe(kind);
          await expect(
            pad.publishBytes(new TextEncoder().encode("blocked"), "/blocked.txt", {
              operationId: "blocked-by-control",
            }),
          ).rejects.toMatchObject({ code: "busy", unknown: false, local: true });
          await pad.close();
          pad = await nativeScratchPad(options(fixture, nc, directory));
          expect((await pad.describe()).pending, "reopened workspace retains its control").toBe(
            kind,
          );
          await expect(pad.recover()).resolves.toMatchObject({ kind });
          const replay = await fixture.command<ControlStatus>("control_status");
          expect(replay.control_requests).toBe(2);
          expect(replay.same_requests).toBe(2);
          expect(replay.request).toEqual(captured.request);
          const settled = await pad.describe();
          expect(settled.pending).toBeUndefined();
          expect(settled.volume.closed).toBe(false);
          expect(settled.volume.head).toEqual(before.head);
          expect(settled.volume.writers).toEqual(before.writers);
          if (kind === "close") {
            expect(settled.volume.revision).toBe(captured.view.revision + 1);
            expect(settled.volume.objects).toBeLessThan(before.objects);
          } else {
            expect(settled.volume).toEqual(captured.view);
          }
          if (kind === "apply") expect(settled.volume.objects).toBeLessThan(before.objects);
          if (kind === "grant") {
            expect(settled.volume.grants.filter((slot) => slot.grant)).toHaveLength(1);
            expect(pad.granted(published.reference, grantee)).toBe("first-hand");
            await fixture.command("go_read", { user: "reader", reference: published.reference });
            await expect(pad.release(published.reference)).rejects.toMatchObject({ code: "busy" });
          }
          const reader = await scratchPadReader({ nc });
          expect(await reader.readBytes(published.reference)).toEqual(data);
          const following = await pad.publishBytes(
            new TextEncoder().encode("after recovery"),
            "/next.txt",
            {
              operationId: "after-control-recovery",
            },
          );
          expect(following.receipt.command.number).toBe(published.receipt.command.number + 1);
          console.info(
            "NATIVE_CONTROL_RESULT",
            JSON.stringify({
              language: "typescript",
              kind,
              requests: replay.control_requests,
              identicalRequests: replay.same_requests,
              droppedReplies: 2,
              recoveredPending: 1,
              preservedBytes: data.length,
              reclaimedObjects: before.objects - settled.volume.objects,
              writerGeneration: following.receipt.command.writer.generation,
            }),
          );
        } finally {
          try {
            await pad?.close();
          } finally {
            await nc.close();
          }
        }
      });
    },
    120_000,
  );

  it("recovers an exact accepted publication after a real reconnect", async () => {
    await withFixture(async (fixture, directory) => {
      const nc = await owner(fixture, true);
      let pad: Pad | undefined;
      const events: string[] = [];
      let reconnected!: () => void;
      const ready = new Promise<void>((resolve) => {
        reconnected = resolve;
      });
      const observe = (async () => {
        for await (const status of nc.status()) {
          events.push(status.type);
          if (status.type === "reconnect") reconnected();
        }
      })();
      try {
        expect(nc.getServer()).toBe(new URL(fixture.config.fault_url).host);
        pad = await nativeScratchPad(options(fixture, nc, directory));
        await fixture.command("drop_publish", { operation_id: "reconnect-publication" });
        const data = new TextEncoder().encode("accepted before disconnect");
        await expect(
          pad.publishBytes(data, "/reconnect.txt", {
            operationId: "reconnect-publication",
          }),
        ).rejects.toMatchObject({ unknown: true });
        const accepted = await fixture.command<{ receipt: Receipt }>("accepted", {
          operation_id: "reconnect-publication",
        });
        await pad.close();
        expect(await fixture.command("disconnect_fault_proxy")).toEqual({ closed: true });
        await deadline(ready, 5000, "real native reconnect");
        expect(events).toContain("disconnect");
        expect(nc.getServer()).toBe(new URL(fixture.config.url).host);
        await nc.flush();
        pad = await nativeScratchPad(options(fixture, nc, directory));
        const result = await pad.recover();
        expect(result.kind).toBe("publish");
        if (result.kind !== "publish" || !result.reference || !result.receipt)
          throw new Error("publication recovery was omitted");
        expect(result.receipt).toEqual(accepted.receipt);
        const reader = await scratchPadReader({ nc });
        expect(await reader.readBytes(result.reference)).toEqual(data);
        expect((await pad.describe()).volume.writers[0]!.number).toBe(1);
        console.info(
          "NATIVE_RECONNECT_RESULT",
          JSON.stringify({
            language: "typescript",
            disconnects: events.filter((e) => e === "disconnect").length,
            reconnects: events.filter((e) => e === "reconnect").length,
            exactReceipts: 1,
            bytes: data.length,
            acceptedCommands: 1,
          }),
        );
      } finally {
        try {
          await pad?.close();
        } finally {
          try {
            await nc.close();
          } finally {
            await observe;
          }
        }
      }
    });
  }, 120_000);

  it("refuses an unrelated closed volume and resumes after explicit operator collection", async () => {
    await withFixture(async (fixture, directory) => {
      const nc = await owner(fixture);
      let pad: Pad | undefined;
      try {
        pad = await nativeScratchPad(options(fixture, nc, directory));
        const published = await pad.publishBytes(
          new TextEncoder().encode("operator preserved"),
          "/result.txt",
          {
            operationId: "before-operator-close",
          },
        );
        const closed = await fixture.command<{ view: VolumeView }>("operator_close", {
          reference: published.reference,
        });
        expect(closed.view.closed).toBe(true);
        await expect(pad.maintain()).rejects.toMatchObject({ code: "closed", unknown: false });
        expect(await pad.describe()).toEqual({ volume: closed.view });
        await pad.close();
        pad = await nativeScratchPad(options(fixture, nc, directory));
        await expect(pad.maintain()).rejects.toMatchObject({ code: "closed", unknown: false });
        await expect(pad.recover()).resolves.toEqual({ kind: "ready", ...published });
        expect(await pad.describe()).toEqual({ volume: closed.view });
        const reopened = await fixture.command<{ view: VolumeView }>("operator_collect", {
          reference: published.reference,
        });
        expect(reopened.view.closed).toBe(false);
        expect(reopened.view.writers).toEqual(closed.view.writers);
        const reader = await scratchPadReader({ nc });
        expect(new TextDecoder().decode(await reader.readBytes(published.reference))).toBe(
          "operator preserved",
        );
        const following = await pad.publishBytes(
          new TextEncoder().encode("usable again"),
          "/next.txt",
          {
            operationId: "after-operator-collection",
          },
        );
        expect(following.receipt.command.number).toBe(published.receipt.command.number + 1);
        console.info(
          "NATIVE_OPERATOR_RESULT",
          JSON.stringify({
            language: "typescript",
            takeoverRefusals: 2,
            nonAdoptingRecoveries: 1,
            explicitCollections: 1,
            continuedCommands: 1,
          }),
        );
      } finally {
        try {
          await pad?.close();
        } finally {
          await nc.close();
        }
      }
    });
  }, 120_000);

  it("preserves all live handoffs under byte, retention, and grant pressure", async () => {
    await withFixture(async (fixture, directory) => {
      const nc = await owner(fixture);
      const readers: NatsConnection[] = [];
      let pad: Pad | undefined;
      try {
        pad = await nativeScratchPad(options(fixture, nc, directory));
        const initial = await pad.publishBytes(
          new TextEncoder().encode("initial"),
          "/initial.txt",
          {
            operationId: "quota-initial",
          },
        );
        const before = await pad.describe();
        function* oversized(): Generator<Uint8Array> {
          for (let index = 0; index < 17; index++) yield new Uint8Array(512 * 1024).fill(index);
        }
        await expect(
          pad.publishStream(oversized(), "/oversized.bin", {
            operationId: "byte-quota-refusal",
          }),
        ).rejects.toMatchObject({ code: "capacity", local: true });
        expect(await pad.describe()).toEqual(before);
        await pad.release(initial.reference);
        const writer = pad;
        const publications = await Promise.all(
          Array.from({ length: 8 }, (_, index) =>
            writer.publishBytes(
              new TextEncoder().encode(`handoff ${index}`),
              `/result-${index}.txt`,
              {
                operationId: `concurrent-handoff-${index}`,
              },
            ),
          ),
        );
        expect(publications.map((p) => p.receipt.command.number)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
        const recipients = [fixture.config.users.reader, fixture.config.users.intruder];
        await Promise.all(
          publications.flatMap((p) =>
            recipients.map((user) =>
              writer.grantRead(p.reference, { account: user.account, user: user.user }),
            ),
          ),
        );
        const full = await pad.describe();
        expect(full.pending).toBeUndefined();
        expect(full.volume.retentions.filter((entry) => entry.pin)).toHaveLength(8);
        expect(full.volume.grants.filter((entry) => entry.grant)).toHaveLength(16);
        await expect(
          pad.publishBytes(new TextEncoder().encode("ninth"), "/ninth.txt", {
            operationId: "ninth-handoff",
          }),
        ).rejects.toMatchObject({ code: "capacity" });
        await expect(
          pad.grantRead(publications[0]!.reference, {
            account: fixture.config.users.owner.account,
            user: fixture.config.users.owner.user,
          }),
        ).rejects.toMatchObject({ code: "capacity" });
        expect(await pad.describe()).toEqual(full);
        let reads = 0;
        for (const recipient of recipients) {
          const connection = await connect({
            servers: fixture.config.url,
            authenticator: credsAuthenticator(await readFile(recipient.credentials)),
            reconnect: false,
          });
          readers.push(connection);
          const reader = await scratchPadReader({ nc: connection });
          for (const [index, publication] of publications.entries()) {
            expect(new TextDecoder().decode(await reader.readBytes(publication.reference))).toBe(
              `handoff ${index}`,
            );
            reads++;
          }
        }
        console.info(
          "NATIVE_PRESSURE_RESULT",
          JSON.stringify({
            language: "typescript",
            byteRefusals: 1,
            retentionRefusals: 1,
            grantRefusals: 1,
            concurrentPublications: publications.length,
            retainedRoots: 8,
            liveGrants: 16,
            verifiedReads: reads,
          }),
        );
      } finally {
        try {
          await pad?.close();
        } finally {
          try {
            await Promise.all(readers.map((reader) => reader.close()));
          } finally {
            await nc.close();
          }
        }
      }
    });
  }, 120_000);
});

describe.skipIf(!coreRoot)("native retained-data quota headroom", () => {
  it.each(["bytes", "objects"] as const)(
    "refuses %s headroom until released roots are collected",
    async (quota) => {
      await withFixture(async (fixture, directory) => {
        const nc = await owner(fixture);
        let pad: Pad | undefined;
        try {
          pad = await nativeScratchPad(options(fixture, nc, directory));
          const chunkBytes = 512 * 1024;
          const chunkData = (count: number, first: number): Uint8Array => {
            const data = new Uint8Array(count * chunkBytes);
            for (let index = 0; index < count; index++)
              data.fill(first + index, index * chunkBytes, (index + 1) * chunkBytes);
            return data;
          };
          const seeds =
            quota === "bytes"
              ? [chunkData(6, 1), new TextEncoder().encode("retained current head")]
              : [0, 1, 2].map((index) => new TextEncoder().encode(`retained object root ${index}`));
          const path = (index: number): string =>
            quota === "bytes"
              ? `/artifact-${index}.bin`
              : "/" +
                [
                  ...Array.from({ length: 15 }, (_, part) => `d${part}`),
                  `artifact-${index}.bin`,
                ].join("/");
          const publications: { reference: string; receipt: Receipt }[] = [];
          const observedObjects: number[] = [];
          for (const [index, data] of seeds.entries()) {
            publications.push(
              await pad.publishBytes(data, path(index), { operationId: `headroom-seed-${index}` }),
            );
            observedObjects.push((await pad.describe()).volume.objects);
          }
          await pad.maintain();
          const before = await pad.describe();
          const candidate =
            quota === "bytes"
              ? chunkData(12, 101)
              : new TextEncoder().encode("candidate object root");
          const operationId = `headroom-candidate-${quota}`;
          if (quota === "bytes") {
            expect(candidate.length).toBeLessThan(8 * 1024 * 1024);
            expect(before.volume.bytes + candidate.length).toBeGreaterThan(8 * 1024 * 1024);
            expect(before.volume.objects).toBe(11);
          } else {
            expect(observedObjects).toEqual([18, 36, 54]);
            expect(before.volume.objects).toBe(54);
            expect(before.volume.bytes).toBeLessThan(64 * 1024);
          }
          await expect(
            pad.publishBytes(candidate, path(seeds.length), { operationId }),
          ).rejects.toMatchObject({ code: "capacity", unknown: false, local: true });
          const refused = await pad.describe();
          expect(refused.pending).toBeUndefined();
          expect(refused.volume.closed).toBe(false);
          for (const field of [
            "head",
            "writers",
            "grants",
            "retentions",
            "objects",
            "bytes",
          ] as const)
            expect(refused.volume[field]).toEqual(before.volume[field]);
          const reader = await scratchPadReader({ nc });
          for (const [index, publication] of publications.entries())
            expect(await reader.readBytes(publication.reference)).toEqual(seeds[index]);

          for (const publication of publications.slice(0, -1))
            await pad.release(publication.reference);
          const released = (await pad.describe()).volume;
          const collected = await pad.maintain();
          const deletedObjects = released.objects - collected.objects;
          const deletedBytes = released.bytes - collected.bytes;
          expect(deletedObjects).toBeGreaterThan(0);
          expect(deletedBytes).toBeGreaterThan(0);
          expect(collected.head).toEqual(before.volume.head);
          expect(collected.writers).toEqual(before.volume.writers);
          if (quota === "objects") expect(collected.objects).toBe(18);
          const accepted = await pad.publishBytes(candidate, path(seeds.length), { operationId });
          expect(accepted.receipt.command.operation_id).toBe(operationId);
          expect(accepted.receipt.command.writer).toEqual(
            publications.at(-1)!.receipt.command.writer,
          );
          expect(accepted.receipt.command.number).toBe(
            publications.at(-1)!.receipt.command.number + 1,
          );
          expect(await reader.readBytes(accepted.reference)).toEqual(candidate);
          expect(await reader.readBytes(publications.at(-1)!.reference)).toEqual(seeds.at(-1));
          const after = await pad.describe();
          expect(after.pending).toBeUndefined();
          const admittedObjects = after.volume.objects - collected.objects;
          expect(admittedObjects).toBe(quota === "bytes" ? 14 : 18);
          expect(after.volume.objects).toBeLessThanOrEqual(64);
          expect(after.volume.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
          console.info(
            "NATIVE_HEADROOM_RESULT",
            JSON.stringify({
              language: "typescript",
              quota,
              observedObjects,
              occupiedObjects: before.volume.objects,
              occupiedBytes: before.volume.bytes,
              refusalRevisionDelta: refused.volume.revision - before.volume.revision,
              deletedObjects,
              deletedBytes,
              admittedObjects,
              acceptedNumber: accepted.receipt.command.number,
              verifiedCandidateBytes: candidate.length,
            }),
          );
        } finally {
          try {
            await pad?.close();
          } finally {
            await nc.close();
          }
        }
      });
    },
    120_000,
  );
});
