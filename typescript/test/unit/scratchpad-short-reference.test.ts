import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { headers, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { describe, expect, it, vi } from "vitest";
import vector from "../../../test-fixtures/scratchpad/reference-short-v1.json";
import intentVector from "../../../test-fixtures/scratchpad/reference-intent-v1.json";
import {
  validateReference,
  chunkID,
  decodeReference,
  encodeFileObject,
  encodeReference,
  fileObjectID,
} from "../../src/scratchpad-native/codec";
import { nativeScratchPad } from "../../src/scratchpad-native/client";
import { ScratchPadReader } from "../../src/scratchpad-native/reader";
import { WorkspaceStore } from "../../src/scratchpad-native/store";
import * as p from "../../src/scratchpad-native/protocol";
import * as r from "../../src/scratchpad-native/references";
import { ScratchPadTransport } from "../../src/scratchpad-native/transport";
import { findReferences, removeReferences } from "../../src/scratchpad";

const pair = vector.resolved;
const ref = pair.expanded;
validateReference(ref);
const principal = {
  account: ref.account,
  user: "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
};
const command: p.Command = {
  creation_id: ref.target.creation_id,
  writer: { slot: 0, generation: 1 },
  number: 1,
  operation_id: "reference-fixture",
  base: { generation: 6, root: ref.root },
  root: ref.root,
  trace: {},
  retention: {
    enabled: true,
    slot: ref.retention.slot,
    generation: ref.retention.generation - 1,
    until: ref.expires_at,
  },
};
const receipt: p.Receipt = {
  volume: ref.target.volume,
  principal,
  command,
  head: { generation: ref.generation, root: ref.root },
  retention: ref.retention,
};
const request: r.ReferencePublishRequest = {
  target: ref.target,
  command,
  reference: { creator: ref.creator, paths: [ref.path] },
};
const result = { receipt, references: [pair] };
const capabilities: r.ReferenceCapabilities = {
  enabled: true,
  version: 1,
  prefix: "sp-r1:",
  token_bytes: 66,
  paths_per_retention: 8,
  max_intent_bytes: 3072,
  max_metadata_bytes: 32768,
};
function message(body: unknown, code: p.Code = "ok"): Msg {
  const h = headers();
  h.set(p.REPLY_HEADER, p.goJSON({ code, message: code === "ok" ? "" : code }));
  return {
    headers: h,
    data: code === "ok" ? Buffer.from(p.goJSON(body)) : new Uint8Array(),
  } as unknown as Msg;
}
function connection(respond: (verb: string, body: unknown) => Msg | Promise<Msg>) {
  const request = vi.fn(async (subject: string, data: Uint8Array) =>
    respond(subject.slice(p.SUBJECT_PREFIX.length), JSON.parse(Buffer.from(data).toString())),
  );
  const nc = {
    info: { max_payload: 1024 * 1024, headers: true },
    isClosed: () => false,
    isDraining: () => false,
    request,
    flush: async () => {},
  } as unknown as NatsConnection;
  return { nc, request, transport: new ScratchPadTransport(nc, { timeoutMs: 100 }) };
}

describe("durable short references", () => {
  it("shares the exact locator, route and expanded identity across languages", () => {
    expect(pair.short).toHaveLength(66);
    expect(r.decodeShortReference(pair.short)).toEqual(vector.locator);
    r.validateResolvedReference(pair);
    expect(encodeReference(ref)).toBe(vector.full_token);
    expect(decodeReference(vector.full_token)).toEqual(ref);
    expect(findReferences(`${pair.short}, ${vector.full_token}`)).toEqual([
      pair.short,
      vector.full_token,
    ]);
    expect(removeReferences(`read ${pair.short}`)).toBe("read");
  });
  it("refuses copying errors and mismatched metadata without attempting repair", () => {
    const packed = Buffer.from(pair.short.slice(6), "base64url");
    packed[32] = 64;
    const generation = Buffer.from(pair.short.slice(6), "base64url");
    generation.fill(0, 24, 32);
    for (const token of [
      pair.short + "=",
      pair.short.slice(0, -1),
      pair.short + "a",
      "sp-r1:" + packed.toString("base64url"),
      "sp-r1:" + generation.toString("base64url"),
    ])
      expect(() => r.decodeShortReference(token)).toThrow();
    expect(() =>
      r.validateResolvedReference({
        ...pair,
        expanded: { ...ref, target: { ...ref.target, volume: "Other" } },
      }),
    ).toThrow();
    expect(() => r.validateReferenceSpec({ creator: "writer", paths: ["/b", "/a"] })).toThrow();
    expect(() => r.validateReferenceSpec({ creator: "<".repeat(512), paths: ["/a"] })).toThrow(
      /byte bound/,
    );
  });
  it("falls back only for an older service's explicit unknown-operation reply", async () => {
    const old = connection(() => message({}, "invalid"));
    expect(await old.transport.referenceInfo()).toBeUndefined();
    const disabled = connection(() => message({ ...capabilities, enabled: false }));
    expect((await disabled.transport.referenceInfo())?.enabled).toBe(false);
    for (const changed of [{ version: 2 }, { max_intent_bytes: 4096 }]) {
      await expect(
        connection(() => message({ ...capabilities, ...changed })).transport.referenceInfo(),
      ).rejects.toThrow(/reply body is malformed/);
    }
    for (const code of ["denied", "unavailable", "unauthenticated"] as const) {
      const h = connection(() => message({}, code));
      await expect(h.transport.referenceInfo()).rejects.toMatchObject({ code });
    }
    await expect(
      connection(() => {
        throw new Error("transport lost");
      }).transport.referenceInfo(),
    ).rejects.toThrow();
  });
  it("counts Go JSON escaping at the exact reference intent byte bound", () => {
    expect(p.goJSON(intentVector.reference)).toBe(intentVector.go_json);
    expect(Buffer.byteLength(intentVector.go_json)).toBe(3072);
    r.validateReferenceSpec(intentVector.reference);
    const below = structuredClone(intentVector.reference);
    below.paths[1] = below.paths[1]!.slice(0, -1);
    expect(Buffer.byteLength(p.goJSON(below))).toBe(3071);
    r.validateReferenceSpec(below);
    const above = structuredClone(intentVector.reference);
    above.paths[1] += "x";
    expect(Buffer.byteLength(p.goJSON(above))).toBe(3073);
    expect(() => r.validateReferenceSpec(above)).toThrow(/byte bound/);
  });
  it("binds publication and read-only receipt replies to the complete intent", async () => {
    const h = connection(() => message(result));
    expect(await h.transport.referencePublish(request)).toEqual(result);
    expect(await h.transport.referenceReceipt(request)).toEqual(result);
    expect(h.request.mock.calls.map(([subject]) => subject)).toEqual([
      p.SUBJECT_PREFIX + "reference.publish",
      p.SUBJECT_PREFIX + "reference.receipt",
    ]);
    for (const changed of [
      { creator: "another", paths: [ref.path] },
      { creator: ref.creator, paths: ["/other"] },
    ]) {
      await expect(
        h.transport.referenceReceipt({ ...request, reference: changed }),
      ).rejects.toMatchObject({ code: "corrupt", unknown: false });
      await expect(
        h.transport.referencePublish({ ...request, reference: changed }),
      ).rejects.toMatchObject({ code: "unknown", unknown: true });
    }
    await expect(
      connection(() => message({}, "not_found")).transport.referenceReceipt(request),
    ).rejects.toMatchObject({ code: "not_found", unknown: false });
  });
  it("checks current content authority on every read, including an empty file and a warm cache", async () => {
    const digest = createHash("sha256").update("").digest("hex");
    const stat: p.Stat = {
      type: "file",
      object: fileObjectID(encodeFileObject({ size: 0, digest, chunks: [] })),
      size: 0,
      sha256: digest,
      executable: false,
    };
    let allowed = true;
    const h = connection((verb) =>
      verb === "reference.resolve"
        ? message(pair)
        : allowed
          ? message({ reference: pair, stat })
          : message({}, "denied"),
    );
    const reader = new ScratchPadReader(h.transport, principal);
    expect(await reader.resolveReference(pair.short)).toEqual(ref);
    expect(await reader.readBytes(pair.short)).toEqual(new Uint8Array());
    allowed = false;
    await expect(reader.readBytes(pair.short)).rejects.toMatchObject({ code: "denied" });
    expect(h.request.mock.calls.map(([subject]) => subject)).toEqual(
      ["reference.resolve", "reference.stat", "reference.stat"].map((v) => p.SUBJECT_PREFIX + v),
    );
    allowed = true;
    expect(await new ScratchPadReader(h.transport, principal).readBytes(pair.short)).toEqual(
      new Uint8Array(),
    );
  });
  it("recovers the same short token from a fresh workspace connection without a payload or metadata cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fabric-short-reference-"));
    const state = {
      version: 1,
      principal,
      volume: ref.target.volume,
      creator: ref.creator,
      creation: { operation_id: "created", trace: {} },
      target: ref.target,
      writer: command.writer,
      next: 1,
      grants: [],
      pending: { kind: "publish", command, path: ref.path, ttl: 600, reference: request.reference },
    };
    const store = await WorkspaceStore.open(dir);
    store.save(state);
    store.close();
    let changed = true;
    const h = connection((verb, body) => {
      if (verb === "info")
        return message({
          principal,
          scopes: [{ volume: ref.target.volume, objects: 64, bytes: 8 * 1024 * 1024 }],
          limits: p.PUBLIC_LIMITS,
        });
      expect(verb).toBe("reference.receipt");
      expect(body).toEqual(request);
      return message(
        changed
          ? { receipt, references: [{ ...pair, expanded: { ...ref, creator: "changed" } }] }
          : result,
      );
    });
    try {
      const first = await nativeScratchPad({
        nc: h.nc,
        dir,
        volume: ref.target.volume,
        creator: ref.creator,
      });
      await expect(first.recover()).rejects.toMatchObject({ unknown: false, code: "corrupt" });
      await first.close();
      changed = false;
      const reopened = await nativeScratchPad({
        nc: h.nc,
        dir,
        volume: ref.target.volume,
        creator: ref.creator,
      });
      expect(await reopened.recover()).toEqual({ kind: "publish", reference: pair.short, receipt });
      await reopened.close();
      const again = await nativeScratchPad({
        nc: h.nc,
        dir,
        volume: ref.target.volume,
        creator: ref.creator,
      });
      expect(await again.recover()).toEqual({ kind: "ready", reference: pair.short, receipt });
      await again.close();
      expect(
        h.request.mock.calls.filter(([subject]) => subject.endsWith("reference.receipt")),
      ).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

for (const token of [pair.short, vector.full_token]) {
  it(`enforces the descriptor deadline after ranges and final yields for ${token.slice(0, 6)}`, async () => {
    let clock = (ref.expires_at - 1) * 1000,
      overrun = false;
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const bytes = Buffer.from("a"),
      digest = createHash("sha256").update(bytes).digest("hex");
    const stat: p.Stat = {
      type: "file",
      size: 1,
      sha256: digest,
      executable: false,
      object: fileObjectID(
        encodeFileObject({ size: 1, digest, chunks: [{ id: chunkID(bytes), length: 1 }] }),
      ),
    };
    const h = connection((verb) => {
      if (verb === "reference.stat") return message({ reference: pair, stat });
      if (verb === "content.stat") return message(stat);
      expect(verb).toBe("content.read");
      if (overrun) clock = ref.expires_at * 1000;
      const replyHeaders = headers();
      replyHeaders.set(
        p.REPLY_HEADER,
        p.goJSON({ code: "ok", message: "", range: { stat, offset: 0, length: 1 } }),
      );
      return { headers: replyHeaders, data: bytes } as unknown as Msg;
    });
    try {
      const reader = new ScratchPadReader(h.transport, principal);
      const stream = reader.readStream(token, { limitBytes: 1 });
      expect((await stream.next()).value).toEqual(bytes);
      clock = ref.expires_at * 1000;
      await expect(stream.next()).rejects.toMatchObject({ code: "expired" });
      clock -= 1000;
      overrun = true;
      await expect(reader.readBytes(token)).rejects.toMatchObject({ code: "expired" });
    } finally {
      time.mockRestore();
    }
  });

  it(`refuses an empty file whose stat crosses the deadline for ${token.slice(0, 6)}`, async () => {
    let clock = (ref.expires_at - 1) * 1000;
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const digest = createHash("sha256").update("").digest("hex");
    const stat: p.Stat = {
      type: "file",
      size: 0,
      sha256: digest,
      executable: false,
      object: fileObjectID(encodeFileObject({ size: 0, digest, chunks: [] })),
    };
    const h = connection((verb) => {
      clock = ref.expires_at * 1000;
      return message(verb === "reference.stat" ? { reference: pair, stat } : stat);
    });
    try {
      await expect(
        new ScratchPadReader(h.transport, principal).readBytes(token),
      ).rejects.toMatchObject({ code: "expired" });
      expect(h.request).toHaveBeenCalledTimes(1);
    } finally {
      time.mockRestore();
    }
  });
}
