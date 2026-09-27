import { headers } from "@nats-io/nats-core";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { verifyObject } from "./codec";
import { NativeScratchPadError, failed, invalid } from "./errors";
import * as p from "./protocol";

export interface RequestOptions {
  signal?: AbortSignal;
}
export interface TransportOptions {
  timeoutMs?: number;
}

function pathRequest(v: Record<string, unknown>): void {
  p.validateTarget(v.target);
  p.validateContentID(v.root);
  p.validatePath(v.path);
  p.validateTrace(v.trace);
}
function validateRequest(verb: string, value: unknown): void {
  switch (verb) {
    case "info":
      p.validateEmpty(value);
      return;
    case "volume.create": {
      const v = p.record(value, ["volume", "action"]);
      p.validateVolume(v.volume);
      p.validateAction(v.action);
      return;
    }
    case "volume.get": {
      const v = p.record(value, ["target"]);
      p.validateTarget(v.target);
      return;
    }
    case "object.prepare": {
      const v = p.record(value, ["target", "objects"]);
      p.validateTarget(v.target);
      p.check(
        Array.isArray(v.objects) &&
          v.objects.length > 0 &&
          v.objects.length <= p.MAX_PREPARE_OBJECTS,
        "invalid preparation count",
      );
      const seen = new Set<string>();
      for (const raw of v.objects) {
        p.validateObjectSpec(raw);
        const key = raw.object.kind + ":" + raw.object.id;
        p.check(!seen.has(key), "duplicate preparation object");
        seen.add(key);
      }
      return;
    }
    case "object.verify": {
      const v = p.record(value, ["target", "epoch", "objects"]);
      p.validateTarget(v.target);
      p.uint(v.epoch);
      p.check(
        Array.isArray(v.objects) &&
          v.objects.length > 0 &&
          v.objects.length <= p.MAX_PREPARE_OBJECTS,
        "invalid verification count",
      );
      const seen = new Set<string>();
      for (const raw of v.objects) {
        p.validateContentObject(raw);
        const key = raw.kind + ":" + raw.id;
        p.check(!seen.has(key), "duplicate verification object");
        seen.add(key);
      }
      return;
    }
    case "object.put": {
      const v = p.record(value, ["target", "object", "epoch"]);
      p.validateTarget(v.target);
      p.validateContentObject(v.object);
      p.uint(v.epoch);
      return;
    }
    case "checkpoint.publish": {
      const v = p.record(value, ["target", "command"]);
      p.validateTarget(v.target);
      p.validateCommand(v.command);
      p.check(
        v.target.creation_id === v.command.creation_id,
        "command names another creation identity",
      );
      return;
    }
    case "writer.reset": {
      const v = p.record(value, ["target", "writer"]);
      p.validateTarget(v.target);
      p.validateWriter(v.writer);
      return;
    }
    case "root.retain": {
      const v = p.record(value, ["target", "slot", "generation", "root", "until", "action"]);
      p.validateTarget(v.target);
      p.uint(v.slot, p.RETENTION_SLOTS - 1);
      p.uint(v.generation);
      p.validateContentID(v.root);
      p.uint(v.until);
      p.validateAction(v.action);
      return;
    }
    case "root.release": {
      const v = p.record(value, ["target", "handle"]);
      p.validateTarget(v.target);
      p.validateRetentionHandle(v.handle);
      return;
    }
    case "grant.issue": {
      const v = p.record(value, [
        "target",
        "slot",
        "generation",
        "principal",
        "root",
        "path",
        "retention",
        "until",
        "action",
      ]);
      p.validateTarget(v.target);
      p.uint(v.slot, p.GRANT_SLOTS - 1);
      p.uint(v.generation);
      p.validatePrincipal(v.principal);
      p.validateContentID(v.root);
      p.validatePath(v.path, 256);
      p.validateRetentionHandle(v.retention);
      p.uint(v.until, undefined, 1);
      p.validateAction(v.action);
      return;
    }
    case "grant.revoke": {
      const v = p.record(value, ["target", "handle", "action"]);
      p.validateTarget(v.target);
      p.validateGrantHandle(v.handle);
      p.validateAction(v.action);
      return;
    }
    case "content.stat": {
      const v = p.record(value, ["target", "root", "path", "trace"]);
      pathRequest(v);
      return;
    }
    case "content.read": {
      const v = p.record(value, ["target", "root", "path", "trace", "offset", "length"]);
      pathRequest(v);
      p.uint(v.offset);
      p.uint(v.length, p.MAX_READ_BYTES, 1);
      return;
    }
    case "content.list": {
      const v = p.record(value, ["target", "root", "path", "trace", "offset", "limit"]);
      pathRequest(v);
      p.uint(v.offset, 0xffffffff);
      p.uint(v.limit, 64, 1);
      return;
    }
    case "maintenance.close":
    case "maintenance.plan":
    case "maintenance.apply": {
      const v = p.record(value, ["target", "revision"]);
      p.validateTarget(v.target);
      p.uint(v.revision, undefined, 1);
      return;
    }
    default:
      throw invalid("unknown ScratchPad verb");
  }
}

/** One request per operation on a borrowed NATS connection. No retry or identity override. */
export class ScratchPadTransport {
  readonly timeoutMs: number;
  constructor(
    private readonly nc: NatsConnection,
    options: TransportOptions = {},
  ) {
    p.check(nc && !nc.isClosed() && !nc.isDraining(), "an open NATS connection is required");
    p.check(nc.info?.headers === true, "NATS header support is required");
    p.check(
      (nc.info?.max_payload ?? 0) >= p.MAX_NODE_BYTES + p.MAX_HEADER_BYTES,
      "NATS max_payload cannot carry the largest canonical object",
    );
    this.timeoutMs = options.timeoutMs ?? 10000;
    p.uint(this.timeoutMs, 5 * 60 * 1000, 1);
  }

  private async within<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    // Attach a rejection observer even if cancellation wins before the race.
    void work.catch(() => {});
    if (signal?.aborted) throw signal.reason ?? new Error("operation cancelled");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("request deadline exceeded");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("request deadline exceeded"));
      }, remaining);
      const cancel = (): void => {
        cleanup();
        const cause: unknown = signal?.reason;
        reject(cause instanceof Error ? cause : new Error("operation cancelled", { cause }));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      void work.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error instanceof Error ? error : new Error("request failed", { cause: error }));
        },
      );
    });
  }

  private async exchange(
    verb: string,
    body: Uint8Array,
    mutation: boolean,
    ranged: boolean,
    options: RequestOptions,
    metadata?: string,
  ): Promise<{ metadata: p.ReplyMetadata; body: Uint8Array }> {
    let headerBytes = 0;
    const requestHeaders = metadata === undefined ? undefined : headers();
    if (metadata !== undefined) {
      headerBytes = 12 + Buffer.byteLength(p.METADATA_HEADER) + 4 + Buffer.byteLength(metadata);
      p.check(
        headerBytes <= p.MAX_HEADER_BYTES && !/[\r\n\0]/.test(metadata),
        "invalid request header",
      );
      requestHeaders!.set(p.METADATA_HEADER, metadata);
    }
    p.check(
      body.length + headerBytes <= (this.nc.info?.max_payload ?? 0),
      "request exceeds NATS payload bound",
    );
    const deadline = performance.now() + this.timeoutMs;
    // The public JS NATS API cannot disable reconnect buffering. A failed
    // flush has sent no application request. After request(), every missing
    // reply remains unknown; the workflow must preserve the original intent.
    try {
      if (options.signal?.aborted || this.nc.isClosed() || this.nc.isDraining())
        throw new Error("connection or signal closed before transmission");
      await this.within(this.nc.flush(), deadline, options.signal);
      if (options.signal?.aborted || this.nc.isClosed() || this.nc.isDraining())
        throw new Error("connection or signal closed before transmission");
      if (deadline <= performance.now()) throw new Error("deadline ended before transmission");
      p.check(this.nc.info?.headers === true, "NATS header support is required");
      p.check(
        body.length + headerBytes <= (this.nc.info?.max_payload ?? 0),
        "request exceeds current NATS payload bound",
      );
    } catch (cause) {
      throw new NativeScratchPadError("unavailable", "request not transmitted", {
        local: true,
        cause,
      });
    }
    let reply: Msg;
    try {
      const request = this.nc.request(p.SUBJECT_PREFIX + verb, body, {
        timeout: Math.max(1, Math.ceil(deadline - performance.now())),
        ...(requestHeaders === undefined ? {} : { headers: requestHeaders }),
      });
      reply = await this.within(request, deadline, options.signal);
    } catch (cause) {
      throw new NativeScratchPadError(
        mutation ? "unknown" : "unavailable",
        "request returned no trustworthy reply",
        { unknown: mutation, cause },
      );
    }
    try {
      let count = 0,
        size = 12,
        value = "";
      for (const [key, values] of reply.headers ?? []) {
        for (const item of values) size += Buffer.byteLength(key) + 4 + Buffer.byteLength(item);
        if (key.toLowerCase() === p.REPLY_HEADER.toLowerCase()) {
          count += values.length;
          value = values[0] ?? "";
        }
      }
      p.check(
        size <= p.MAX_HEADER_BYTES && count === 1,
        "reply must have one bounded ScratchPad-Reply header",
      );
      const meta = p.parseStrictJSON(value, p.MAX_HEADER_BYTES);
      p.validateReplyMetadata(meta);
      if (meta.code !== "ok") {
        p.check(reply.data.length === 0, "error reply has a body");
        throw new NativeScratchPadError(meta.code, meta.message, {
          unknown: mutation && ["unknown", "unavailable", "internal"].includes(meta.code),
        });
      }
      p.check(ranged === (meta.range !== undefined), "reply range does not match verb");
      p.check(
        reply.data.length <= (ranged ? p.MAX_READ_BYTES : p.MAX_REPLY_BYTES),
        "reply body exceeds bound",
      );
      return { metadata: meta, body: reply.data };
    } catch (cause) {
      if (cause instanceof NativeScratchPadError && !cause.local) throw cause;
      throw failed(mutation, "reply metadata is malformed", cause);
    }
  }

  private async control<T>(
    verb: string,
    request: unknown,
    validate: p.Validator<T>,
    mutation: boolean,
    options: RequestOptions,
  ): Promise<T> {
    validateRequest(verb, request);
    const body = Buffer.from(p.goJSON(request));
    p.check(body.length <= p.MAX_CONTROL_BYTES, "control request exceeds bound");
    const reply = await this.exchange(verb, body, mutation, false, options);
    try {
      const result = p.parseStrictJSON(reply.body, p.MAX_REPLY_BYTES);
      validate(result);
      return result;
    } catch (cause) {
      throw failed(mutation, "reply body is malformed", cause);
    }
  }
  private matching(condition: boolean, mutation: boolean, detail: string): void {
    if (!condition) throw failed(mutation, detail);
  }
  private async view(
    verb: string,
    target: p.Target,
    request: unknown,
    mutation: boolean,
    options: RequestOptions,
  ): Promise<p.VolumeView> {
    const result = await this.control(verb, request, p.validateVolumeView, mutation, options);
    this.matching(
      p.sameValue(result.target, target),
      mutation,
      "reply names another volume incarnation",
    );
    return result;
  }

  info(options: RequestOptions = {}): Promise<p.Info> {
    return this.control("info", {}, p.validateInfo, false, options);
  }
  async createVolume(
    request: p.CreateRequest,
    options: RequestOptions = {},
  ): Promise<p.VolumeView> {
    const expected = structuredClone(request);
    const result = await this.control(
      "volume.create",
      expected,
      p.validateVolumeView,
      true,
      options,
    );
    this.matching(result.target.volume === expected.volume, true, "reply names another volume");
    return result;
  }
  getVolume(target: p.Target, options: RequestOptions = {}): Promise<p.VolumeView> {
    const expected = structuredClone(target);
    return this.view("volume.get", expected, { target: expected }, false, options);
  }
  async prepare(request: p.PrepareRequest, options: RequestOptions = {}): Promise<p.PrepareResult> {
    const expected = structuredClone(request);
    const result = await this.control(
      "object.prepare",
      expected,
      p.validatePrepareResult,
      true,
      options,
    );
    this.matching(
      result.objects.length === expected.objects.length &&
        result.objects.every(
          (progress, index) =>
            p.sameValue(progress.object, expected.objects[index]!.object) &&
            progress.length === expected.objects[index]!.length,
        ),
      true,
      "preparation reply names other objects",
    );
    return result;
  }
  async putPrepared(
    request: p.PutRequest,
    data: Uint8Array,
    options: RequestOptions = {},
  ): Promise<void> {
    const expected = structuredClone(request),
      bytes = Uint8Array.from(data);
    validateRequest("object.put", expected);
    p.check(bytes.length > 0 && bytes.length <= p.MAX_NODE_BYTES, "object bytes exceed bound");
    try {
      verifyObject(expected.object, bytes);
    } catch (cause) {
      throw invalid("object bytes differ from canonical identity", cause);
    }
    const reply = await this.exchange(
      "object.put",
      bytes,
      true,
      false,
      options,
      p.goJSON(expected),
    );
    try {
      p.validateEmpty(p.parseStrictJSON(reply.body, p.MAX_REPLY_BYTES));
    } catch (cause) {
      throw failed(true, "put reply body is malformed", cause);
    }
  }
  async verify(request: p.VerifyRequest, options: RequestOptions = {}): Promise<p.VerifyResult> {
    const expected = structuredClone(request);
    const result = await this.control(
      "object.verify",
      expected,
      p.validateVerifyResult,
      true,
      options,
    );
    this.matching(
      result.epoch === expected.epoch &&
        result.objects.length === expected.objects.length &&
        result.objects.every((progress, index) =>
          p.sameValue(progress.object, expected.objects[index]),
        ),
      true,
      "verification reply names other objects or epoch",
    );
    return result;
  }
  async publish(request: p.PublishRequest, options: RequestOptions = {}): Promise<p.Receipt> {
    const expected = structuredClone(request);
    const result = await this.control(
      "checkpoint.publish",
      expected,
      p.validateReceipt,
      true,
      options,
    );
    const normalize = (command: p.Command): p.Command => ({
      ...command,
      trace: Object.fromEntries(Object.entries(command.trace).filter(([, value]) => value !== "")),
    });
    this.matching(
      result.volume === expected.target.volume &&
        p.sameValue(normalize(result.command), normalize(expected.command)),
      true,
      "receipt names another command",
    );
    return result;
  }
  async resetWriter(
    target: p.Target,
    writer: p.Writer,
    options: RequestOptions = {},
  ): Promise<p.Writer> {
    const expected = structuredClone({ target, writer });
    const result = await this.control("writer.reset", expected, p.validateWriter, true, options);
    this.matching(
      result.slot === expected.writer.slot && result.generation > expected.writer.generation,
      true,
      "reset reply names another writer generation",
    );
    return result;
  }
  retain(request: p.RetainRequest, options: RequestOptions = {}): Promise<p.VolumeView> {
    const expected = structuredClone(request);
    return this.view("root.retain", expected.target, expected, true, options);
  }
  release(request: p.ReleaseRequest, options: RequestOptions = {}): Promise<p.VolumeView> {
    const expected = structuredClone(request);
    return this.view("root.release", expected.target, expected, true, options);
  }
  async issueGrant(
    request: p.GrantIssueRequest,
    options: RequestOptions = {},
  ): Promise<p.GrantHandle> {
    const expected = structuredClone(request);
    const result = await this.control(
      "grant.issue",
      expected,
      p.validateGrantHandle,
      true,
      options,
    );
    this.matching(
      result.slot === expected.slot && result.generation > expected.generation,
      true,
      "grant reply names another slot generation",
    );
    return result;
  }
  revokeGrant(request: p.RevokeRequest, options: RequestOptions = {}): Promise<p.VolumeView> {
    const expected = structuredClone(request);
    return this.view("grant.revoke", expected.target, expected, true, options);
  }
  stat(request: p.PathRequest, options: RequestOptions = {}): Promise<p.Stat> {
    return this.control("content.stat", structuredClone(request), p.validateStat, false, options);
  }
  async list(request: p.ListRequest, options: RequestOptions = {}): Promise<p.ListResult> {
    const expected = structuredClone(request);
    const result = await this.control(
      "content.list",
      expected,
      p.validateListResult,
      false,
      options,
    );
    this.matching(
      result.entries.length <= expected.limit &&
        result.next === expected.offset + result.entries.length,
      false,
      "list result differs from requested window",
    );
    return result;
  }
  async read(request: p.ReadRequest, options: RequestOptions = {}): Promise<p.ReadResult> {
    const expected = structuredClone(request);
    validateRequest("content.read", expected);
    const data = Buffer.from(p.goJSON(expected));
    p.check(data.length <= p.MAX_CONTROL_BYTES, "read request exceeds bound");
    const reply = await this.exchange("content.read", data, false, true, options),
      range = reply.metadata.range!;
    this.matching(
      range.offset === expected.offset &&
        range.length === Math.min(expected.length, range.stat.size - range.offset) &&
        reply.body.length === range.length,
      false,
      "range result differs from request",
    );
    return { stat: range.stat, offset: range.offset, data: reply.body };
  }
  closeVolume(request: p.MaintenanceRequest, options: RequestOptions = {}): Promise<p.VolumeView> {
    const expected = structuredClone(request);
    return this.view("maintenance.close", expected.target, expected, true, options);
  }
  planCollection(
    request: p.MaintenanceRequest,
    options: RequestOptions = {},
  ): Promise<p.CollectionReport> {
    return this.control(
      "maintenance.plan",
      structuredClone(request),
      p.validateCollectionReport,
      false,
      options,
    );
  }
  async applyCollection(
    request: p.MaintenanceRequest,
    options: RequestOptions = {},
  ): Promise<p.CollectionResult> {
    const expected = structuredClone(request);
    const result = await this.control(
      "maintenance.apply",
      expected,
      p.validateCollectionResult,
      true,
      options,
    );
    this.matching(
      p.sameValue(result.volume.target, expected.target),
      true,
      "collection names another volume incarnation",
    );
    return result;
  }
}
