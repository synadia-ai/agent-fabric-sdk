import { randomUUID } from "node:crypto";
import type { GrantKind, Grantee, TraceIds } from "../scratchpad";
import type { ScratchPadClient } from "../scratchpad-cli";
import {
  chunkStream,
  decodeReference,
  encodeFileObject,
  encodeReference,
  encodeTreeNode,
  fileObjectID,
  treeNodeID,
} from "./codec";
import { NativeScratchPadError } from "./errors";
import {
  check,
  MAX_GRANT_SECONDS,
  MAX_PREPARE_OBJECTS,
  record,
  sameValue,
  text,
  uint,
  validateAction,
  validateCommand,
  validatePrincipal,
  validateReceipt,
  validateTarget,
  validateVolume,
  validateWriter,
  validatePath,
  validateRetentionHandle,
} from "./protocol";
import type {
  Action,
  Command,
  GrantHandle,
  GrantIssueRequest,
  Info,
  MaintenanceRequest,
  ObjectSpec,
  Principal,
  Receipt,
  ReleaseRequest,
  ReservedScope,
  Target,
  Trace,
  VolumeView,
  Writer,
} from "./protocol";
import { ScratchPadReader, wireTrace } from "./reader";
import type { ScratchPadReaderOptions } from "./reader";
import { ScratchPadTransport } from "./transport";
import { WorkspaceStore } from "./store";

export interface NativeScratchPadOptions extends ScratchPadReaderOptions {
  /** Private directory on a persistent local filesystem. One client owns it at a time. */
  dir: string;
  volume: string;
  /** Prompt address used only to route Fabric grant requests. It is not authentication. */
  creator: string;
  ttlSeconds?: number;
}
export interface PublishOptions {
  operationId: string;
  ttlSeconds?: number;
  trace?: TraceIds;
}
export interface PublishResult {
  reference: string;
  receipt: Receipt;
}
export interface RecoveryResult {
  kind: string;
  reference?: string;
  receipt?: Receipt;
}
interface Publication {
  kind: "publish";
  command: Command;
  path: string;
  ttl: number;
}
interface Granted {
  request: GrantIssueRequest;
  handle: GrantHandle;
  kind: GrantKind;
}
type Control =
  | { kind: "grant"; request: GrantIssueRequest; provenance: GrantKind }
  | { kind: "release"; request: ReleaseRequest }
  | { kind: "close" | "apply"; request: MaintenanceRequest };
type Pending = Publication | Control | { kind: "reset"; writer: Writer };
interface State {
  version: 1;
  principal: Principal;
  volume: string;
  creator: string;
  creation: Action;
  target?: Target;
  writer?: Writer;
  next: number;
  pending?: Pending;
  last?: PublishResult & { path: string; ttl: number };
  grants: Granted[];
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}
function refuse(
  code: "busy" | "fenced" | "capacity" | "denied" | "expired" | "intent_changed" | "closed",
  message: string,
): never {
  throw new NativeScratchPadError(code, message, { local: true });
}
function unknown(error: unknown, message: string): NativeScratchPadError {
  return new NativeScratchPadError(
    error instanceof NativeScratchPadError ? error.code : "unknown",
    message,
    { unknown: true, cause: error },
  );
}

function validateState(value: unknown): asserts value is State {
  const s = record(
    value,
    ["version", "principal", "volume", "creator", "creation", "next", "grants"],
    ["target", "writer", "pending", "last"],
  );
  check(s.version === 1, "unsupported workspace version");
  validatePrincipal(s.principal);
  validateVolume(s.volume);
  text(s.creator, 512, 1);
  validateAction(s.creation);
  uint(s.next, undefined, 1);
  if (s.target !== undefined) {
    validateTarget(s.target);
    check(s.target.volume === s.volume, "workspace target differs from volume");
  }
  if (s.writer !== undefined) {
    validateWriter(s.writer);
    check(s.writer.slot === 0 && s.target, "workspace writer binding is invalid");
  }
  check(Array.isArray(s.grants) && s.grants.length <= 16, "workspace grant ledger exceeds bound");
  for (const raw of s.grants) {
    const g = record(raw, ["request", "handle", "kind"]);
    check(g.kind === "first-hand" || g.kind === "on-request", "invalid grant provenance");
    validateGrant(g.request);
    const h = record(g.handle, ["slot", "generation"]);
    uint(h.slot, 15);
    uint(h.generation, undefined, 1);
  }
  if (s.last !== undefined) {
    const last = record(s.last, ["reference", "receipt", "path", "ttl"]);
    validateReceipt(last.receipt);
    text(last.reference, 8192, 1);
    const reference = decodeReference(last.reference);
    validatePath(last.path, 256);
    uint(last.ttl, MAX_GRANT_SECONDS, 1);
    check(
      sameValue(last.receipt.principal, s.principal) &&
        sameValue(reference.target, s.target) &&
        reference.root === last.receipt.head.root &&
        reference.path === last.path &&
        sameValue(reference.retention, last.receipt.retention),
      "saved receipt differs from workspace",
    );
  }
  if (s.pending !== undefined) {
    check(s.target, "pending operation has no target");
    const p = s.pending as Pending;
    switch (p.kind) {
      case "publish":
        record(p, ["kind", "command", "path", "ttl"]);
        validateCommand(p.command);
        validatePath(p.path, 256);
        uint(p.ttl, MAX_GRANT_SECONDS, 1);
        check(
          p.command.creation_id === s.target.creation_id &&
            sameValue(p.command.writer, s.writer) &&
            p.command.number === s.next,
          "pending writer position differs",
        );
        break;
      case "reset":
        record(p, ["kind", "writer"]);
        validateWriter(p.writer);
        break;
      case "grant":
        record(p, ["kind", "request", "provenance"]);
        validateGrant(p.request);
        check(
          p.provenance === "first-hand" || p.provenance === "on-request",
          "invalid pending grant provenance",
        );
        break;
      case "release":
        record(p, ["kind", "request"]);
        record(p.request, ["target", "handle"]);
        validateTarget(p.request.target);
        validateRetentionHandle(p.request.handle);
        break;
      case "close":
      case "apply":
        record(p, ["kind", "request"]);
        record(p.request, ["target", "revision"]);
        validateTarget(p.request.target);
        uint(p.request.revision, undefined, 1);
        break;
      default:
        check(false, "unknown workspace pending operation");
    }
    if ("request" in p)
      check(sameValue(p.request.target, s.target), "pending operation names another target");
  }
}
function validateGrant(value: unknown): asserts value is GrantIssueRequest {
  const g = record(value, [
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
  validateTarget(g.target);
  uint(g.slot, 15);
  uint(g.generation);
  validatePrincipal(g.principal);
  validatePath(g.path, 256);
  validateRetentionHandle(g.retention);
  uint(g.until, undefined, 1);
  validateAction(g.action);
  text(g.root, 43, 43);
}

/** A native writer and Fabric adapter. It borrows the caller's authenticated connection. */
export class NativeScratchPad extends ScratchPadReader implements ScratchPadClient {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(
    transport: ScratchPadTransport,
    private readonly store: WorkspaceStore,
    private state: State,
    private readonly scope: ReservedScope,
    private readonly ttl: number,
  ) {
    super(transport, state.principal);
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new NativeScratchPadError("closed", "native client is closed", { local: true }),
      );
    const result = this.tail.then(work);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private save(state: State, remote = false, clearObjects = false): void {
    try {
      validateState(state);
      this.store.save(state, remote, clearObjects);
      this.state = state;
    } catch (error) {
      if (remote)
        throw unknown(
          error,
          "remote effect may be accepted; close and reopen the workspace before recovery",
        );
      throw error;
    }
  }
  private change(pending: Pending): void {
    this.save({ ...this.state, pending });
  }
  private target(): Target {
    check(this.state.target, "workspace has no volume");
    return this.state.target;
  }

  private async ensureTarget(): Promise<VolumeView> {
    if (!this.state.target) {
      const view = await this.transport.createVolume({
        volume: this.state.volume,
        action: this.state.creation,
      });
      if (!sameValue(view.owner, this.principal))
        throw unknown(undefined, "volume creation names another owner");
      this.save({ ...this.state, target: view.target }, true);
      return view;
    }
    const view = await this.transport.getVolume(this.state.target);
    check(
      sameValue(view.owner, this.principal),
      "workspace principal is no longer the volume owner",
    );
    return view;
  }

  private async initialize(): Promise<void> {
    if (this.state.writer) return;
    const view = await this.ensureTarget();
    if (this.state.pending)
      refuse("fenced", "writer reset needs an explicit resetWriter with the observed generation");
    const slot = view.writers[0]!;
    if (slot.number !== 0)
      refuse(
        "fenced",
        "writer slot 0 has accepted commands but this workspace has no journal; inspect describe and reset explicitly",
      );
    await this.reset({ slot: 0, generation: slot.generation });
  }

  private async reset(writer: Writer): Promise<Writer> {
    const previous = this.state;
    this.change({ kind: "reset", writer });
    let result: Writer;
    try {
      result = await this.transport.resetWriter(this.target(), writer);
    } catch (error) {
      if (error instanceof NativeScratchPadError && !error.unknown) this.save(previous, true);
      throw error;
    }
    const state = { ...this.state, writer: result, next: 1 };
    delete state.pending;
    delete state.last;
    this.save(state, true, true);
    return result;
  }

  /** Explicitly abandon writer recovery, fencing the exact generation observed by describe(). */
  resetWriter(options: { expectedGeneration: number; target?: Target }): Promise<Writer> {
    return this.run(async () => {
      uint(options.expectedGeneration, undefined, 1);
      if (options.target) {
        validateTarget(options.target);
        check(
          options.target.volume === this.state.volume,
          "explicit reset target names another volume",
        );
        if (this.state.target)
          check(
            sameValue(options.target, this.state.target),
            "explicit reset target differs from workspace",
          );
        else {
          const view = await this.transport.getVolume(options.target);
          check(sameValue(view.owner, this.principal), "explicit reset target has another owner");
          this.save({ ...this.state, target: view.target });
        }
      }
      await this.ensureTarget();
      if (this.state.pending && !["reset", "publish"].includes(this.state.pending.kind))
        refuse("busy", "recover the pending control request before resetting the writer");
      return this.reset({ slot: 0, generation: options.expectedGeneration });
    });
  }

  describe(): Promise<{ volume: VolumeView; pending?: string }> {
    return this.run(async () => {
      const volume = await this.ensureTarget();
      return this.state.pending ? { volume, pending: this.state.pending.kind } : { volume };
    });
  }

  recover(): Promise<RecoveryResult> {
    return this.run(() => this.recoverPending());
  }

  private async recoverPending(): Promise<RecoveryResult> {
    if (this.state.pending?.kind === "reset")
      refuse("fenced", "reset outcome needs an explicit resetWriter with the observed generation");
    await this.initialize();
    const pending = this.state.pending;
    if (pending?.kind === "publish")
      return { kind: "publish", ...(await this.resumePublish(pending)) };
    if (pending) {
      await this.control(pending, false);
      return { kind: pending.kind };
    }
    return this.state.last
      ? { kind: "ready", reference: this.state.last.reference, receipt: this.state.last.receipt }
      : { kind: "ready" };
  }

  publishBytes(bytes: Uint8Array, path: string, options: PublishOptions): Promise<PublishResult> {
    // Own the input immediately, including while this call waits for an earlier one.
    const stable = Uint8Array.from(bytes);
    return this.publishStream([stable], path, options);
  }

  /** A publication replaces the head with one file at path. Older references keep their retained roots. */
  publishStream(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    path: string,
    options: PublishOptions,
  ): Promise<PublishResult> {
    return this.publish(source, path, options, false);
  }

  private publish(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    path: string,
    options: PublishOptions,
    recover: boolean,
  ): Promise<PublishResult> {
    options = structuredClone(options);
    return this.run(async () => {
      validatePath(path, 256);
      check(path !== "/", "a file path is required");
      const trace = wireTrace(options.trace),
        ttl = options.ttlSeconds ?? this.ttl;
      uint(ttl, MAX_GRANT_SECONDS, 1);
      validateAction({ operation_id: options.operationId, trace });
      if (recover) await this.recoverPending();
      await this.initialize();
      const pending = this.state.pending;
      if (pending) {
        if (pending.kind !== "publish" || pending.command.operation_id !== options.operationId)
          refuse("busy", "recover the pending operation before publishing another one");
        this.samePublication(pending, path, ttl, trace);
        return this.resumePublish(pending);
      }
      if (this.state.last?.receipt.command.operation_id === options.operationId) {
        const last = this.state.last;
        this.samePublication(
          { kind: "publish", command: last.receipt.command, path: last.path, ttl: last.ttl },
          path,
          ttl,
          trace,
        );
        return { reference: last.reference, receipt: last.receipt };
      }
      // Local preparation carries no remote mutation. An interrupted build can
      // be replaced; only the atomic save of the complete intent makes it pending.
      this.store.clearObjects();
      let ordinal = 0,
        totalBytes = 0;
      const put = (object: ObjectSpec["object"], data: Uint8Array): void => {
        totalBytes += data.length;
        if (totalBytes > this.scope.bytes || ordinal + 1 > this.scope.objects)
          refuse("capacity", "artifact exceeds this volume's configured capacity");
        this.store.putObject(ordinal++, object, data);
      };
      try {
        const file = await chunkStream(source, (_index, object, data) => put(object, data));
        const fileBytes = encodeFileObject(file);
        let root = fileObjectID(fileBytes);
        put({ kind: "fobj", id: root }, fileBytes);
        let type: "file" | "directory" = "file";
        for (const name of path.slice(1).split("/").reverse()) {
          const data = encodeTreeNode([{ name, type, object: root }]);
          root = treeNodeID(data);
          put({ kind: "tree", id: root }, data);
          type = "directory";
        }
        const objects = this.store.objects();
        let view = await this.transport.getVolume(this.target());
        const clock = now();
        const fullRetention = view.retentions.every((slot) => slot.pin);
        const canRelease = view.retentions.some(
          (slot, index) =>
            slot.pin &&
            slot.pin.until !== 0 &&
            slot.pin.until <= clock &&
            !view.grants.some(
              (grant) =>
                grant.grant &&
                grant.grant.until > clock &&
                sameValue(grant.grant.retention, { slot: index, generation: slot.generation }),
            ),
        );
        if (fullRetention && !canRelease)
          refuse(
            "capacity",
            "all retention slots hold live or protected handoffs; cleanup cannot free a slot",
          );
        // Conservative admission can reject an artifact whose objects overlap
        // existing content. It cannot leave a new pending intent on capacity.
        const needsCleanup =
          fullRetention ||
          view.objects + objects.length > this.scope.objects ||
          view.bytes + objects.reduce((n, object) => n + object.length, 0) > this.scope.bytes;
        if (needsCleanup) view = await this.maintainInternal();
        const slot = view.retentions.findIndex((entry) => !entry.pin);
        if (slot < 0)
          refuse(
            "capacity",
            "all retention slots are occupied; release finished handoffs or wait for their expiry",
          );
        if (
          view.objects + objects.length > this.scope.objects ||
          view.bytes + objects.reduce((n, object) => n + object.length, 0) > this.scope.bytes
        )
          refuse("capacity", "live roots and this artifact exceed the volume's capacity");
        const writer = this.state.writer!;
        const actual = view.writers[writer.slot]!;
        if (actual.generation !== writer.generation || actual.number + 1 !== this.state.next)
          refuse("fenced", "remote writer position differs from the durable workspace");
        if (view.closed) refuse("closed", "volume is closed by another maintenance interval");
        const command: Command = {
          creation_id: this.target().creation_id,
          writer,
          number: this.state.next,
          operation_id: options.operationId,
          base: view.head,
          root,
          trace,
          retention: {
            enabled: true,
            slot,
            generation: view.retentions[slot]!.generation,
            until: now() + ttl,
          },
        };
        const publication: Publication = { kind: "publish", command, path, ttl };
        this.change(publication);
        return await this.resumePublish(publication);
      } catch (error) {
        // Never remove stable payload when a command or maintenance step is pending.
        if (!this.state.pending) this.store.clearObjects();
        throw error;
      }
    });
  }

  private samePublication(publication: Publication, path: string, ttl: number, trace: Trace): void {
    if (
      publication.path !== path ||
      publication.ttl !== ttl ||
      !sameValue(publication.command.trace, trace)
    )
      refuse(
        "intent_changed",
        "operation id is already bound to another publication; recover uses its saved payload",
      );
  }

  private async resumePublish(publication: Publication): Promise<PublishResult> {
    const view = await this.transport.getVolume(this.target());
    const slot = view.writers[publication.command.writer.slot]!;
    // Read authoritative receipts before touching the spool: accepted data may
    // already have been collected, and a lost local spool does not erase success.
    if (
      slot.receipt &&
      sameValue(slot.receipt.command, publication.command) &&
      sameValue(slot.receipt.principal, this.principal)
    )
      return this.accept(publication, slot.receipt);
    if (
      slot.generation !== publication.command.writer.generation ||
      slot.number >= publication.command.number
    )
      refuse("fenced", "saved writer position has been fenced; inspect and reset explicitly");
    await this.upload();
    const receipt = await this.transport.publish({
      target: this.target(),
      command: publication.command,
    });
    if (
      !sameValue(receipt.command, publication.command) ||
      !sameValue(receipt.principal, this.principal)
    )
      throw unknown(undefined, "publish receipt differs from the saved command");
    return this.accept(publication, receipt);
  }

  private accept(publication: Publication, receipt: Receipt): PublishResult {
    const reference = encodeReference({
      version: 2,
      creator: this.state.creator,
      account: this.principal.account,
      target: this.target(),
      root: receipt.head.root,
      generation: receipt.head.generation,
      path: publication.path,
      retention: receipt.retention,
      expires_at: publication.command.retention.until,
    });
    const state: State = {
      ...this.state,
      next: receipt.command.number + 1,
      last: { reference, receipt, path: publication.path, ttl: publication.ttl },
    };
    delete state.pending;
    this.save(state, true, true);
    return { reference, receipt };
  }

  private async upload(): Promise<void> {
    const objects = this.store.objects();
    check(objects.length > 0, "saved publication payload is missing");
    const sorted = [...objects].sort((a, b) =>
      Buffer.compare(
        Buffer.from(`${a.object.kind}:${a.object.id}`),
        Buffer.from(`${b.object.kind}:${b.object.id}`),
      ),
    );
    const verified = new Set<string>();
    let epoch: number | undefined;
    const key = (o: ObjectSpec["object"]): string => o.kind + ":" + o.id;
    for (let start = 0; start < sorted.length; start += MAX_PREPARE_OBJECTS) {
      const result = await this.transport.prepare({
        target: this.target(),
        objects: sorted.slice(start, start + MAX_PREPARE_OBJECTS),
      });
      if (epoch !== undefined && epoch !== result.epoch)
        throw unknown(undefined, "upload preparation changed epoch; recover the saved publication");
      epoch = result.epoch;
      for (const object of result.objects) {
        if (object.state === "refused")
          refuse(
            "capacity",
            "object reservation refused; saved publication stays pending for recovery or explicit reset",
          );
        if (object.state === "verified") verified.add(key(object.object));
      }
    }
    check(epoch !== undefined, "publication contains no objects");
    // Spool order is dependency order: chunks, file, then directories from leaf to root.
    for (const spec of objects) {
      if (verified.has(key(spec.object))) continue;
      await this.transport.putPrepared(
        { target: this.target(), object: spec.object, epoch },
        this.store.bytes(spec.object),
      );
      let next = -1;
      for (;;) {
        const result = await this.transport.verify({
          target: this.target(),
          epoch,
          objects: [spec.object],
        });
        const progress = result.objects[0]!;
        if (progress.state === "verified") break;
        if (progress.state !== "verifying" || progress.next <= next)
          throw unknown(undefined, "object verification did not advance");
        next = progress.next;
      }
    }
  }

  async commit(value: string, path: string, trace: TraceIds | undefined): Promise<string> {
    const result = await this.publish(
      [Buffer.from(value)],
      path.startsWith("/") ? path : "/" + path,
      { operationId: randomUUID(), ...(trace ? { trace } : {}) },
      true,
    );
    return result.reference;
  }

  owns(token: string): boolean {
    try {
      const ref = this.reference(token);
      return ref.creator === this.state.creator && sameValue(ref.target, this.state.target);
    } catch {
      return false;
    }
  }

  granted(token: string, grantee: Grantee): GrantKind | undefined {
    if (!this.owns(token)) return undefined;
    const ref = this.reference(token);
    let kind: GrantKind | undefined;
    for (const grant of this.state.grants) {
      const q = grant.request;
      if (
        q.until > now() &&
        sameValue(q.principal, grantee) &&
        q.root === ref.root &&
        q.path === ref.path &&
        sameValue(q.retention, ref.retention)
      ) {
        if (grant.kind === "first-hand") return grant.kind;
        kind = grant.kind;
      }
    }
    return kind;
  }

  grantRead(
    token: string,
    grantee: Grantee,
    trace?: TraceIds,
    toolCallId?: string,
    kind: GrantKind = "first-hand",
  ): Promise<void> {
    return this.run(async () => {
      validatePrincipal(grantee);
      const labels = wireTrace(trace, toolCallId);
      if (!this.owns(token) || grantee.account !== this.principal.account)
        refuse("denied", "only the owner can grant this same-account reference");
      const ref = this.reference(token);
      if (this.state.pending) await this.recoverPending();
      const view = await this.transport.getVolume(this.target()),
        clock = now();
      const pin = view.retentions[ref.retention.slot]!;
      if (pin.generation !== ref.retention.generation || pin.pin?.root !== ref.root)
        refuse("expired", "reference retention is no longer held");
      const until = Math.min(
        clock + this.ttl,
        ref.expires_at,
        pin.pin.until || Number.MAX_SAFE_INTEGER,
      );
      if (until <= clock) refuse("expired", "reference retention has expired");
      // Reuse a still-live exact grant, preserving first-hand provenance.
      const old = this.state.grants.find(
        (g) =>
          g.request.until >= until &&
          sameValue(g.request.principal, grantee) &&
          g.request.root === ref.root &&
          g.request.path === ref.path &&
          sameValue(g.request.retention, ref.retention) &&
          view.grants[g.handle.slot]?.generation === g.handle.generation,
      );
      if (old) {
        if (kind === "first-hand" && old.kind !== kind) {
          const grants = this.state.grants.map((g) => (g === old ? { ...g, kind } : g));
          this.save({ ...this.state, grants });
        }
        return;
      }
      const slot = view.grants.findIndex((g) => !g.grant || g.grant.until <= clock);
      if (slot < 0) refuse("capacity", "all read-grant slots hold live grants");
      const control: Control = {
        kind: "grant",
        provenance: kind,
        request: {
          target: this.target(),
          slot,
          generation: view.grants[slot]!.generation,
          principal: { ...grantee },
          root: ref.root,
          path: ref.path,
          retention: ref.retention,
          until,
          action: { operation_id: randomUUID(), trace: labels },
        },
      };
      this.change(control);
      await this.control(control, true);
    });
  }

  /** Release a completed handoff. Refuses while any live grant names its retention. */
  release(token: string): Promise<void> {
    return this.run(async () => {
      if (this.state.pending) refuse("busy", "recover the pending operation before release");
      const ref = decodeReference(token);
      if (ref.account !== this.principal.account || !sameValue(ref.target, this.state.target))
        refuse("denied", "reference belongs to another workspace");
      const view = await this.transport.getVolume(this.target());
      if (
        view.grants.some(
          (g) => g.grant && g.grant.until > now() && sameValue(g.grant.retention, ref.retention),
        )
      )
        refuse("busy", "a live read grant still uses this retention");
      const control: Control = {
        kind: "release",
        request: { target: this.target(), handle: ref.retention },
      };
      this.change(control);
      await this.control(control, true);
    });
  }

  /** Collect unreferenced content in this client's own maintenance interval. */
  maintain(): Promise<VolumeView> {
    return this.run(() => this.maintainInternal());
  }

  private async maintainInternal(): Promise<VolumeView> {
    if (this.state.pending) refuse("busy", "recover the pending operation before collection");
    let view = await this.ensureTarget();
    if (view.closed) refuse("closed", "another maintenance interval owns this closed volume");
    const clock = now();
    for (const [slot, held] of view.retentions.entries()) {
      if (!held.pin || held.pin.until === 0 || held.pin.until > clock) continue;
      const handle = { slot, generation: held.generation };
      if (
        view.grants.some(
          (g) => g.grant && g.grant.until > clock && sameValue(g.grant.retention, handle),
        )
      )
        continue;
      const control: Control = { kind: "release", request: { target: this.target(), handle } };
      this.change(control);
      await this.control(control, true);
    }
    view = await this.transport.getVolume(this.target());
    const control: Control = {
      kind: "close",
      request: { target: this.target(), revision: view.revision },
    };
    this.change(control);
    await this.control(control, true);
    return this.transport.getVolume(this.target());
  }

  private async control(control: Control, fresh: boolean): Promise<void> {
    let failure: unknown, view: VolumeView | undefined, handle: GrantHandle | undefined;
    let settled = false;
    try {
      switch (control.kind) {
        case "grant":
          handle = await this.transport.issueGrant(control.request);
          break;
        case "release":
          view = await this.transport.release(control.request);
          break;
        case "close":
          view = await this.transport.closeVolume(control.request);
          break;
        case "apply":
          view = (await this.transport.applyCollection(control.request)).volume;
          break;
      }
      settled = true;
    } catch (error) {
      failure = error;
      if (control.kind !== "release") {
        try {
          view = await this.transport.getVolume(this.target());
          if (control.kind === "grant") {
            const q = control.request,
              observed = view.grants[q.slot]!,
              g = observed.grant;
            if (
              observed.generation > q.generation &&
              g &&
              sameValue(g.principal, q.principal) &&
              g.root === q.root &&
              g.path === q.path &&
              sameValue(g.retention, q.retention) &&
              g.until === q.until
            ) {
              handle = { slot: q.slot, generation: observed.generation };
              failure = undefined;
              settled = true;
            }
          } else if (control.kind === "close") {
            if (view.closed && view.revision === control.request.revision + 1) {
              failure = undefined;
              settled = true;
            } else if (view.revision !== control.request.revision) {
              settled = true;
              failure = new NativeScratchPadError(
                "conflict",
                "saved close is fenced by another revision",
              );
            }
          } else if (!view.closed) {
            failure = undefined;
            settled = true;
          }
        } catch {
          /* A failed observation cannot turn an unknown effect into absence. */
        }
      }
      if (
        error instanceof NativeScratchPadError &&
        !error.unknown &&
        (fresh ||
          control.kind === "release" ||
          (control.kind === "grant" && error.code === "expired"))
      )
        settled = true;
    }
    if (!settled)
      throw unknown(failure, `the saved ${control.kind} request stays pending; call recover()`);
    if (
      !failure &&
      control.kind === "close" &&
      (!view?.closed || view.revision !== control.request.revision + 1)
    )
      throw unknown(undefined, "close returned another maintenance interval");
    const state = { ...this.state };
    delete state.pending;
    if (!failure && control.kind === "grant") {
      check(handle, "grant acceptance has no handle");
      state.grants = state.grants.filter(
        (g) => g.request.until > now() && g.handle.slot !== handle.slot,
      );
      state.grants.push({ request: control.request, handle, kind: control.provenance });
    }
    if (!failure && control.kind === "close")
      state.pending = {
        kind: "apply",
        request: { target: this.target(), revision: view!.revision },
      };
    this.save(state, true);
    if (failure)
      throw failure instanceof Error
        ? failure
        : new Error("control request failed", { cause: failure });
    if (state.pending?.kind === "apply") await this.control(state.pending, true);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    return (this.closePromise = this.tail.then(() => this.store.close()));
  }
}

/** Construct a native client without creating a remote volume until first use. */
export async function nativeScratchPad(
  options: NativeScratchPadOptions,
): Promise<NativeScratchPad> {
  validateVolume(options.volume);
  text(options.creator, 512, 1);
  const ttl = options.ttlSeconds ?? 600;
  uint(ttl, MAX_GRANT_SECONDS, 1);
  const transport = new ScratchPadTransport(options.nc, options);
  const info: Info = await transport.info();
  const scope = info.scopes.find((scope) => scope.volume === options.volume);
  if (!scope) refuse("denied", "authenticated principal owns no provisioned scope for this volume");
  const store = await WorkspaceStore.open(options.dir);
  try {
    let state = store.load();
    if (state === undefined) {
      state = {
        version: 1,
        principal: info.principal,
        volume: options.volume,
        creator: options.creator,
        creation: { operation_id: randomUUID(), trace: {} },
        next: 1,
        grants: [],
      } satisfies State;
      store.save(state);
    }
    validateState(state);
    check(
      sameValue(state.principal, info.principal) &&
        state.volume === options.volume &&
        state.creator === options.creator,
      "workspace is bound to another principal, volume, or creator",
    );
    return new NativeScratchPad(transport, store, state, scope, ttl);
  } catch (error) {
    store.close();
    throw error;
  }
}

/** Environment configuration for SDK agents, using their existing connection. */
export async function nativeScratchPadFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: ScratchPadReaderOptions & { creator: string },
): Promise<NativeScratchPad | undefined> {
  const volume = env["SCRATCHPAD_VOLUME"];
  if (!volume) return undefined;
  const dir = env["SCRATCHPAD_DIR"];
  check(dir, "SCRATCHPAD_DIR must name a persistent private directory for the native client");
  const value = env["SCRATCHPAD_GRANT_TTL_S"];
  check(value === undefined || /^[0-9]+$/.test(value), "SCRATCHPAD_GRANT_TTL_S must be an integer");
  return nativeScratchPad({
    ...options,
    volume,
    dir,
    ...(value === undefined ? {} : { ttlSeconds: Number(value) }),
  });
}
