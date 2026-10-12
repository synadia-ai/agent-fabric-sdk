import { headers } from "@nats-io/nats-core";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { describe, expect, it, vi } from "vitest";
import { ScratchPadTransport } from "../../src/scratchpad-native/transport";
import { NativeScratchPadError } from "../../src/scratchpad-native/errors";
import { chunkID, encodeTreeNode, treeNodeID } from "../../src/scratchpad-native/codec";
import * as p from "../../src/scratchpad-native/protocol";

const principal: p.Principal = {
  account: "ACGACHUFS2GNIOTCLOF5ARXYQX2S2FCDNIRVT23OZ6D7KUELKCB67TCS",
  user: "UDK5U4TSY7GR2UDGAUGCF4QHVZSJXYA7WN5YP3EOZBBYBIMWTGY3OTKA",
};
const target: p.Target = { volume: "Replies", creation_id: "ab".repeat(16) };
const root = treeNodeID(encodeTreeNode([]));
const command: p.Command = {
  creation_id: target.creation_id,
  writer: { slot: 0, generation: 1 },
  number: 1,
  operation_id: "publish-1",
  base: { generation: 1, root },
  root,
  trace: {},
  retention: { enabled: true, slot: 0, generation: 0, until: 1900000600 },
};
const receipt: p.Receipt = {
  volume: target.volume,
  principal,
  command,
  head: { generation: 2, root },
  retention: { slot: 0, generation: 2 },
};
function volume(): p.VolumeView {
  return {
    target: structuredClone(target),
    owner: principal,
    head: { generation: 1, root },
    revision: 1,
    closed: false,
    epoch: 0,
    objects: 1,
    bytes: 4,
    writers: Array.from({ length: 8 }, () => ({ generation: 1, number: 0, write: false })),
    retentions: Array.from({ length: 8 }, () => ({ generation: 0 })),
    grants: Array.from({ length: 16 }, () => ({ generation: 0 })),
  };
}
function message(body: unknown, metadata: p.ReplyMetadata = { code: "ok", message: "" }): Msg {
  const h = headers();
  h.set(p.REPLY_HEADER, p.goJSON(metadata));
  return {
    headers: h,
    data: body instanceof Uint8Array ? body : Buffer.from(p.goJSON(body)),
  } as Msg;
}
function harness(reply: Msg | Error = message(receipt)): {
  nc: NatsConnection;
  request: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
  client: ScratchPadTransport;
} {
  const request = vi
    .fn()
    .mockImplementation(() =>
      reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
    );
  const flush = vi.fn().mockResolvedValue(undefined);
  const nc = {
    info: { max_payload: 1024 * 1024, headers: true },
    isClosed: () => false,
    isDraining: () => false,
    request,
    flush,
  } as unknown as NatsConnection;
  return { nc, request, flush, client: new ScratchPadTransport(nc, { timeoutMs: 100 }) };
}
const publication = (): p.PublishRequest => structuredClone({ target, command });

describe("native ScratchPad transport outcome boundaries", () => {
  it("accepts an exact dormant receipt without granting its former writer access", async () => {
    const view = volume(),
      saved = structuredClone(receipt);
    saved.command.writer.slot = 1;
    view.head = saved.head;
    view.revision = 2;
    view.writers[1] = { generation: 1, number: 1, write: false, receipt: saved };
    const observed = await harness(message(view)).client.getVolume(target);
    expect(observed.writers[1]).toEqual(view.writers[1]);
    expect(observed.writers[1]).not.toHaveProperty("principal");
    for (const corrupt of ["write", "account", "number", "assigned_readonly"]) {
      const changed = structuredClone(view),
        slot = changed.writers[1]!;
      if (corrupt === "write") slot.write = true;
      if (corrupt === "account")
        slot.receipt!.principal.account =
          "ADYGVCD4O7RNGXKVYEGEU6LQTJFMAWCBI66CZCGTHQ43A7LMGLQUQTME";
      if (corrupt === "number") slot.receipt!.command.number++;
      if (corrupt === "assigned_readonly") slot.principal = principal;
      await expect(harness(message(changed)).client.getVolume(target)).rejects.toMatchObject({
        code: "corrupt",
        unknown: false,
      });
    }
  });
  it("sends a publication once, after a public flush, and validates the full receipt", async () => {
    const h = harness();
    const result = await h.client.publish(publication());
    expect(result).toEqual(receipt);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.flush).toHaveBeenCalledTimes(1);
    expect(h.flush.mock.invocationCallOrder[0]).toBeLessThan(
      h.request.mock.invocationCallOrder[0]!,
    );
    const sent = h.request.mock.calls[0]!;
    expect(sent[0]).toBe("sp.v1.api.v2.checkpoint.publish");
    expect(JSON.parse(Buffer.from(sent[1] as Uint8Array).toString())).toEqual(publication());
  });
  it("matches absent zero trace values by Go value semantics", async () => {
    const h = harness();
    const request = publication();
    request.command.trace = { thread_id: "", root_id: "", tool_call_id: "" };
    await expect(h.client.publish(request)).resolves.toEqual(receipt);
  });
  it("does not transmit after a readiness failure or an already aborted signal", async () => {
    const h = harness();
    h.flush.mockRejectedValue(new Error("disconnected"));
    await expect(h.client.publish(publication())).rejects.toMatchObject({
      code: "unavailable",
      unknown: false,
      local: true,
    });
    expect(h.request).not.toHaveBeenCalled();
    const aborted = AbortSignal.abort();
    await expect(h.client.publish(publication(), { signal: aborted })).rejects.toMatchObject({
      local: true,
      unknown: false,
    });
    expect(h.request).not.toHaveBeenCalled();
  });
  for (const reason of ["timeout", "no responders", "permission violation", "reconnect"])
    it(`preserves unknown mutation outcome after ${reason}`, async () => {
      const h = harness(new Error(reason));
      await expect(h.client.publish(publication())).rejects.toMatchObject({
        code: "unknown",
        unknown: true,
        local: false,
      });
      expect(h.request).toHaveBeenCalledTimes(1);
    });
  it("cancellation after transmission stays unknown and never sends a second request", async () => {
    const h = harness(),
      controller = new AbortController();
    h.request.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error("cancelled"));
    });
    await expect(
      h.client.publish(publication(), { signal: controller.signal }),
    ).rejects.toMatchObject({ unknown: true });
    expect(h.request).toHaveBeenCalledTimes(1);
  });
  for (const code of ["unknown", "unavailable", "internal"] as const)
    it(`treats service ${code} as an ambiguous mutation`, async () => {
      const h = harness(message(Buffer.alloc(0), { code, message: "try later" }));
      await expect(h.client.publish(publication())).rejects.toMatchObject({
        code,
        unknown: true,
        local: false,
      });
    });
  it("preserves a valid explicit refusal, but refuses an error body", async () => {
    const h = harness(message(Buffer.alloc(0), { code: "denied", message: "read only" }));
    await expect(h.client.publish(publication())).rejects.toMatchObject({
      code: "denied",
      unknown: false,
    });
    h.request.mockResolvedValue(
      message({ unauthorized: true }, { code: "denied", message: "read only" }),
    );
    await expect(h.client.publish(publication())).rejects.toMatchObject({
      code: "unknown",
      unknown: true,
    });
  });
  it("does not accept a receipt for another command or retention generation", async () => {
    const wrong = structuredClone(receipt);
    wrong.command.operation_id = "someone-else";
    const h = harness(message(wrong));
    await expect(h.client.publish(publication())).rejects.toMatchObject({ unknown: true });
    wrong.command = command;
    wrong.retention.generation = 0;
    h.request.mockResolvedValue(message(wrong));
    await expect(h.client.publish(publication())).rejects.toMatchObject({ unknown: true });
  });
  it("captures the request before an await permits caller mutation", async () => {
    const h = harness(),
      request = publication();
    h.flush.mockImplementation(() => {
      request.command.operation_id = "changed";
      return Promise.resolve();
    });
    await expect(h.client.publish(request)).resolves.toEqual(receipt);
  });
  it("rejects duplicate, missing, oversized, and malformed reply headers", async () => {
    const replies: Msg[] = [];
    const duplicate = message(receipt);
    duplicate.headers!.append(p.REPLY_HEADER, '{"code":"ok","message":""}');
    replies.push(duplicate);
    const absent = { data: Buffer.from("{}") } as unknown as Msg;
    replies.push(absent);
    const oversized = message(receipt);
    oversized.headers!.append("Extra", "x".repeat(p.MAX_HEADER_BYTES));
    replies.push(oversized);
    const malformed = message(receipt);
    malformed.headers!.set(p.REPLY_HEADER, '{"code":"ok","code":"denied","message":""}');
    replies.push(malformed);
    for (const reply of replies)
      await expect(harness(reply).client.publish(publication())).rejects.toMatchObject({
        unknown: true,
      });
  });
  it("rejects unknown keys, duplicate body keys, fractions, unsafe counters and extra data", async () => {
    const encoded = p.goJSON(receipt);
    const bad = [
      encoded.replace('"volume":"Replies"', '"volume":"Replies","surprise":1'),
      encoded.replace('"volume":"Replies"', '"volume":"Replies","volume":"Replies"'),
      encoded.replace('"generation":2', '"generation":1.9'),
      encoded.replace('"generation":2', '"generation":9007199254740993'),
      encoded + "{}",
    ];
    for (const body of bad)
      await expect(
        harness(message(Buffer.from(body))).client.publish(publication()),
      ).rejects.toMatchObject({ unknown: true });
  });
  it("rejects invalid local requests before readiness or transmission", async () => {
    const h = harness(),
      request = publication();
    request.command.number = Number.MAX_SAFE_INTEGER + 1;
    await expect(h.client.publish(request)).rejects.toMatchObject({
      code: "invalid",
      local: true,
      unknown: false,
    });
    expect(h.flush).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("native ScratchPad bounded reads and upload replies", () => {
  const stat: p.Stat = {
    type: "file",
    object: root,
    size: 6,
    sha256: "ab".repeat(32),
    executable: false,
  };
  const path: p.PathRequest = { target, root, path: "/result", trace: {} };
  it("verifies raw read range offsets and exact bytes", async () => {
    const data = Buffer.from("cdef");
    const reply = message(data, { code: "ok", message: "", range: { stat, offset: 2, length: 4 } });
    const h = harness(reply);
    await expect(h.client.read({ ...path, offset: 2, length: 6 })).resolves.toEqual({
      stat,
      offset: 2,
      data,
    });
    await expect(h.client.read({ ...path, offset: 1, length: 6 })).rejects.toMatchObject({
      code: "corrupt",
      unknown: false,
    });
    h.request.mockResolvedValue(
      message(data.subarray(1), { code: "ok", message: "", range: { stat, offset: 2, length: 4 } }),
    );
    await expect(h.client.read({ ...path, offset: 2, length: 6 })).rejects.toMatchObject({
      code: "corrupt",
    });
  });
  it("checks volume incarnation on reads as well as mutations", async () => {
    const wrong = volume();
    wrong.target.creation_id = "ff".repeat(16);
    const h = harness(message(wrong));
    await expect(h.client.getVolume(target)).rejects.toMatchObject({
      code: "corrupt",
      unknown: false,
    });
    await expect(
      h.client.release({ target, handle: { slot: 0, generation: 1 } }),
    ).rejects.toMatchObject({ unknown: true });
  });
  it("matches preparation objects and verification epochs", async () => {
    const object: p.ContentObject = { kind: "chnk", id: chunkID(Buffer.from("a")) };
    const progress: p.ObjectProgress = {
      object,
      length: 1,
      state: "verified",
      next: 0,
      code: "ok",
    };
    const h = harness(message({ epoch: 7, objects: [progress] }));
    await expect(
      h.client.prepare({ target, objects: [{ object, length: 1 }] }),
    ).resolves.toMatchObject({ epoch: 7 });
    await expect(
      h.client.prepare({ target, objects: [{ object, length: 2 }] }),
    ).rejects.toMatchObject({ unknown: true });
    await expect(h.client.verify({ target, epoch: 8, objects: [object] })).rejects.toMatchObject({
      unknown: true,
    });
  });
  it("validates upload bytes before reserving or sending and checks empty success", async () => {
    const data = Buffer.from("hello"),
      object: p.ContentObject = { kind: "chnk", id: chunkID(data) };
    const h = harness(message({}));
    await expect(
      h.client.putPrepared({ target, epoch: 0, object }, Buffer.from("changed")),
    ).rejects.toMatchObject({ local: true });
    expect(h.request).not.toHaveBeenCalled();
    await h.client.putPrepared({ target, epoch: 0, object }, data);
    expect(h.request.mock.calls[0]![0]).toBe("sp.v1.api.v2.object.put");
    h.request.mockResolvedValue(message({ unexpected: true }));
    await expect(h.client.putPrepared({ target, epoch: 0, object }, data)).rejects.toMatchObject({
      unknown: true,
    });
  });
  it("checks header support and payload again after readiness", async () => {
    const h = harness();
    h.flush.mockImplementation(() => {
      h.nc.info!.max_payload = 1;
      return Promise.resolve();
    });
    await expect(h.client.publish(publication())).rejects.toMatchObject({
      local: true,
      unknown: false,
    });
    expect(h.request).not.toHaveBeenCalled();
  });
  it("validates the complete public limits and scope identity", async () => {
    const info: p.Info = {
      principal,
      scopes: [{ volume: "Replies", objects: 64, bytes: 8388608 }],
      limits: { ...p.PUBLIC_LIMITS },
    };
    const h = harness(message(info));
    await expect(h.client.info()).resolves.toEqual(info);
    info.limits.read_bytes--;
    h.request.mockResolvedValue(message(info));
    await expect(h.client.info()).rejects.toMatchObject({ code: "corrupt", unknown: false });
  });
  it("represents unknown outcome as a typed Error", () => {
    const error = new NativeScratchPadError("unknown", "lost reply", {
      unknown: true,
      cause: new Error("timeout"),
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.unknown).toBe(true);
    expect(error.cause).toBeInstanceOf(Error);
  });
});
