import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { describe, expect, it } from "vitest";
import { nativeScratchPad } from "../../src/scratchpad-native.js";
import type { Receipt, PublishRequest, VolumeView } from "../../src/scratchpad-native/protocol.js";
import { NativeServiceFixture } from "../harness/scratchpad-native.js";

const coreRoot = process.env["SCRATCHPAD_CORE_ROOT"];
describe.skipIf(!coreRoot)("native publication expiry recovery", () => {
  it.each([false, true])(
    "settles an expired publication with accepted=%s",
    async (accepted) => {
      const fixture = await NativeServiceFixture.start(coreRoot!);
      const directory = await mkdtemp(join(tmpdir(), "scratchpad-expiry-"));
      const state = join(directory, "state");
      await mkdir(state, { mode: 0o700 });
      const nc = await connect({
        servers: fixture.config.fault_url,
        authenticator: credsAuthenticator(await readFile(fixture.config.users.owner.credentials)),
        reconnect: false,
      });
      let pad: Awaited<ReturnType<typeof nativeScratchPad>> | undefined;
      let counts: Record<string, number> | undefined;
      try {
        await nc.flush();
        pad = await nativeScratchPad({
          nc,
          volume: fixture.config.volume,
          dir: state,
          creator: "agents.ts.expiry",
          timeoutMs: 1000,
        });
        const operationId = accepted ? "accepted-expiry" : "unaccepted-expiry";
        await fixture.command(accepted ? "drop_publish" : "drop_unaccepted_publish", {
          operation_id: operationId,
        });
        await expect(
          pad.publishBytes(new TextEncoder().encode("short-lived"), "/expires.txt", {
            operationId,
            ttlSeconds: 3,
          }),
        ).rejects.toMatchObject({ unknown: true });
        const observation = accepted
          ? await fixture.command<{ receipt: Receipt; view: VolumeView }>("accepted", {
              operation_id: operationId,
            })
          : await fixture.command<{
              request: PublishRequest;
              view: VolumeView;
              dropped_requests: number;
            }>("observed_unaccepted", { operation_id: operationId });
        const command =
          "receipt" in observation ? observation.receipt.command : observation.request.command;
        if ("request" in observation) {
          expect(observation.dropped_requests).toBe(1);
          expect(observation.view.writers[command.writer.slot]!.number).toBeLessThan(
            command.number,
          );
        }
        const beforeRecovery = await pad.describe();
        expect(beforeRecovery.pending).toBe("publish");
        const expiry = await fixture.command<{ now: number; until: number; expired: boolean }>(
          "wait_expired",
          { operation_id: operationId },
        );
        expect(expiry.expired).toBe(true);
        expect(expiry.until).toBe(command.retention.until);
        expect(expiry.now).toBeGreaterThanOrEqual(expiry.until);
        const result = await pad.recover();
        if ("receipt" in observation) {
          expect(result.kind).toBe("publish");
          expect(result.receipt).toEqual(observation.receipt);
        } else {
          expect(result).toEqual({ kind: "expired" });
        }
        const settled = await pad.describe();
        expect(settled.pending).toBeUndefined();
        expect(settled.volume.head).toEqual(beforeRecovery.volume.head);
        expect(settled.volume.writers).toEqual(beforeRecovery.volume.writers);
        if (!accepted) {
          expect(settled.volume.closed).toBe(false);
          expect(settled.volume.revision).toBeGreaterThanOrEqual(
            beforeRecovery.volume.revision + 2,
          );
          expect(settled.volume.epoch).toBeGreaterThan(beforeRecovery.volume.epoch);
        }
        const next = await pad.commit("writer remains usable", "/next.txt", undefined);
        expect(await pad.read(next)).toBe("writer remains usable");
        const writer = (await pad.describe()).volume.writers[command.writer.slot]!;
        expect(writer.generation).toBe(command.writer.generation);
        expect(writer.number).toBe(command.number + (accepted ? 1 : 0));
        await pad.close();
        pad = undefined;
        counts = await fixture.close();
        expect(counts).toEqual({
          commands: 4,
          accepted_receipts: accepted ? 1 : 0,
          dropped_replies: accepted ? 1 : 0,
          go_publications: 0,
          go_reads: 0,
          service_restarts: 0,
          ...(accepted ? {} : { dropped_requests: 1 }),
        });
        console.info(
          "NATIVE_EXPIRY",
          JSON.stringify({
            accepted,
            observedExpiry: expiry,
            recovery: result.kind,
            revisionBefore: beforeRecovery.volume.revision,
            revisionAfter: settled.volume.revision,
            epochBefore: beforeRecovery.volume.epoch,
            epochAfter: settled.volume.epoch,
            sameWriter: true,
            nextNumber: writer.number,
            fixture: counts,
          }),
        );
      } finally {
        await pad?.close();
        await nc.close();
        if (!counts) await fixture.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
