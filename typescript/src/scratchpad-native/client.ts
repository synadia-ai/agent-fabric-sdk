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
  validateAdmissionBinding,
  validateRenewRequest,
  validateRemovalPlan,
  validateVolumeReleasePlan,
  validateVolumeReleaseResult,
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
  AdmissionBinding,
  RenewRequest,
  RemovalPlan,
  VolumeReleasePlan,
  VolumeReleaseResult,
} from "./protocol";
import { ScratchPadReader, wireTrace } from "./reader";
import type { ScratchPadReaderOptions } from "./reader";
import { ScratchPadTransport } from "./transport";
import { WorkspaceStore } from "./store";
import { readScratchPadBootstrapFile } from "./bootstrap";
import {
  SHORT_REFERENCE_PREFIX,
  validateReferenceSpec,
  validateResolvedReference,
  validateReferencePublishResult,
  type ReferenceSpec,
  type ResolvedReference,
} from "./references";
import type { Reference } from "./codec";

export interface NativeScratchPadOptions extends ScratchPadReaderOptions {
  /** Private directory on a persistent local filesystem. One client owns it at a time. */
  dir: string;
  /** Required unless bootstrapFile supplies the exact volume. */
  volume?: string;
  /** Public descriptor file. Never a credentials file or an adoption target. */
  bootstrapFile?: string;
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
/** Capacity returned can be known even when this release request's acceptance is unknown. */
export type VolumeReleaseOutcome = VolumeReleaseResult & { acceptance_unknown?: true };
export interface RecoveryResult {
  kind: string;
  reference?: string;
  receipt?: Receipt;
  volume?: VolumeView;
  release?: VolumeReleaseOutcome;
}
/** Charged encoded content includes chunks, metadata, retained history and reservations. */
export interface ScratchPadDiagnostics {
  volume: string;
  status: "unbound" | "observed";
  allowance: { bytes: number; objects: number };
  pending?: string;
  target?: Target;
  revision?: number;
  head_generation?: number;
  closed?: boolean;
  charged?: { bytes: number; objects: number };
  /** Current counters only. Metadata, control slots and concurrent work can still refuse a write. */
  ordinary_headroom?: { bytes: number; objects: number };
  lifetime?: VolumeView["lifetime"];
}
interface Publication {
  kind: "publish";
  command: Command;
  path: string;
  ttl: number;
  expiry_revision?: number;
  reference?: ReferenceSpec;
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
type Lifecycle =
  | { kind: "renew"; request: RenewRequest }
  | { kind: "remove"; plan: RemovalPlan }
  | { kind: "volume_release"; plan: VolumeReleasePlan; fence_accepted?: true };
type Pending = Publication | Control | Lifecycle | { kind: "reset"; writer: Writer };
interface State {
  version: 1;
  principal: Principal;
  volume: string;
  creator: string;
  creation: Action;
  admission?: AdmissionBinding;
  target?: Target;
  writer?: Writer;
  next: number;
  pending?: Pending;
  renewal?: RenewRequest;
  last?: PublishResult & { path: string; ttl: number; resolved?: ResolvedReference };
  grants: Granted[];
  removal?: Receipt;
  disposal?: VolumeReleaseResult;
  disposal_plan?: VolumeReleasePlan;
  release_acceptance_unknown?: true;
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
    [
      "target",
      "writer",
      "pending",
      "last",
      "admission",
      "removal",
      "disposal",
      "renewal",
      "disposal_plan",
      "release_acceptance_unknown",
    ],
  );
  check(s.version === 1, "unsupported workspace version");
  validatePrincipal(s.principal);
  validateVolume(s.volume);
  text(s.creator, 512, 1);
  validateAction(s.creation);
  if (s.admission !== undefined) validateAdmissionBinding(s.admission);
  if (s.removal !== undefined) {
    validateReceipt(s.removal);
    check(
      s.removal.command.remove_path &&
        s.removal.volume === s.volume &&
        sameValue(s.removal.principal, s.principal) &&
        s.removal.command.creation_id === (s.target as Target | undefined)?.creation_id,
      "saved removal differs from workspace",
    );
  }
  if (s.disposal !== undefined) {
    validateVolumeReleaseResult(s.disposal);
    check(
      s.disposal.capacity_returned &&
        !s.pending &&
        sameValue(s.disposal.target, s.target) &&
        s.disposal.slot === s.admission?.slot &&
        s.disposal.generation === s.admission?.generation,
      "unfinished or foreign disposal",
    );
  }
  if (s.disposal_plan !== undefined) {
    validateVolumeReleasePlan(s.disposal_plan);
    check(
      s.disposal &&
        sameValue(s.disposal_plan.request.target, s.disposal.target) &&
        s.disposal_plan.slot === s.disposal.slot &&
        s.disposal_plan.generation === s.disposal.generation &&
        s.disposal_plan.request.operation_id === s.disposal.operation_id,
      "completed release plan differs from disposal",
    );
  }
  if (s.release_acceptance_unknown !== undefined)
    check(s.release_acceptance_unknown === true && s.disposal, "invalid release acceptance marker");
  uint(s.next, undefined, 1);
  if (s.target !== undefined) {
    validateTarget(s.target);
    check(s.target.volume === s.volume, "workspace target differs from volume");
  }
  if (s.writer !== undefined) {
    validateWriter(s.writer);
    check(s.writer.slot === 0 && s.target, "workspace writer binding is invalid");
  }
  if (s.renewal !== undefined) {
    validateRenewRequest(s.renewal);
    check(
      s.admission &&
        sameValue(s.renewal.target, s.target) &&
        !s.disposal &&
        !["renew", "volume_release"].includes((s.pending as Pending | undefined)?.kind ?? ""),
      "saved renewal conflicts with the workspace lifetime",
    );
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
    const last = record(s.last, ["reference", "receipt", "path", "ttl"], ["resolved"]);
    validateReceipt(last.receipt);
    text(last.reference, 8192, 1);
    let reference: Reference;
    if (last.reference.startsWith(SHORT_REFERENCE_PREFIX)) {
      validateResolvedReference(last.resolved);
      validateReferencePublishResult({ receipt: last.receipt, references: [last.resolved] });
      check(last.resolved.short === last.reference, "saved short reference differs");
      reference = last.resolved.expanded;
    } else {
      check(last.resolved === undefined, "full reference has unexpected expansion");
      reference = decodeReference(last.reference);
    }
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
      case "renew":
        record(p, ["kind", "request"]);
        validateRenewRequest(p.request);
        break;
      case "remove":
        record(p, ["kind", "plan"]);
        validateRemovalPlan(p.plan);
        check(
          sameValue(p.plan.target, s.target) &&
            sameValue(p.plan.command.writer, s.writer) &&
            p.plan.command.number === s.next,
          "saved removal writer differs",
        );
        break;
      case "volume_release":
        record(p, ["kind", "plan"], ["fence_accepted"]);
        if (p.fence_accepted !== undefined)
          check(p.fence_accepted === true, "invalid release fence marker");
        validateVolumeReleasePlan(p.plan);
        check(sameValue(p.plan.request.target, s.target), "saved disposal names another target");
        break;
      case "publish":
        record(p, ["kind", "command", "path", "ttl"], ["expiry_revision", "reference"]);
        if (p.reference !== undefined) {
          validateReferenceSpec(p.reference);
          check(
            p.reference.creator === s.creator && sameValue(p.reference.paths, [p.path]),
            "saved reference intent differs from publication",
          );
        }
        validateCommand(p.command);
        validatePath(p.path, 256);
        uint(p.ttl, MAX_GRANT_SECONDS, 1);
        if (p.expiry_revision !== undefined) uint(p.expiry_revision, undefined, 1);
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
    if (p.kind === "remove" || p.kind === "volume_release")
      check(
        s.admission &&
          p.plan.slot === s.admission.slot &&
          p.plan.generation === s.admission.generation,
        "saved plan names another lifetime",
      );
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
    private readonly scope: ReservedScope | undefined,
    private readonly ttl: number,
  ) {
    super(transport, state.principal);
  }

  private run<T>(work: () => Promise<T>, allowRenewal = false, allowDisposed = false): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new NativeScratchPadError("closed", "native client is closed", { local: true }),
      );
    const result = this.tail.then(() => {
      if (this.state.renewal && !allowRenewal)
        refuse("busy", "recover the saved renewal before another mutation");
      if (this.state.disposal && !allowDisposed)
        refuse("fenced", "this workspace lifetime has been released");
      return work();
    });
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
        ...(this.state.admission ? { admission: this.state.admission } : {}),
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
    check(
      sameValue(view.lifetime?.admission, this.state.admission),
      "workspace lifetime differs from volume",
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
    delete state.removal;
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

  /** Observe allowances and charged usage without creating or changing a volume. */
  diagnostics(): Promise<ScratchPadDiagnostics> {
    return this.run(
      async () => {
        const info = await this.transport.info();
        if (!sameValue(info.principal, this.principal))
          throw new NativeScratchPadError("unauthenticated", "authenticated principal changed", { local: true });
        const scope = info.scopes.find((entry) => entry.volume === this.state.volume);
        if (!scope) refuse("denied", "configured volume has no current allowance");
        if (!sameValue(scope.admission, this.state.admission))
          refuse("fenced", "configured volume belongs to another lifetime");
        const pending = this.state.pending?.kind ?? (this.state.renewal ? "renew" : undefined);
        const result: ScratchPadDiagnostics = {
          volume: this.state.volume,
          status: "unbound",
          allowance: { bytes: scope.bytes, objects: scope.objects },
          ...(pending ? { pending } : {}),
        };
        // A creation may have succeeded before its reply was saved. An unbound
        // workspace cannot prove remote absence or zero usage with a read.
        if (!this.state.target) return result;
        const view = await this.transport.getVolume(this.state.target);
        if (!sameValue(view.owner, this.principal)) refuse("denied", "volume owner differs");
        if (!sameValue(view.lifetime?.admission, this.state.admission))
          refuse("fenced", "volume lifetime differs");
        return {
          ...result,
          status: "observed",
          target: view.target,
          revision: view.revision,
          head_generation: view.head.generation,
          closed: view.closed,
          charged: { bytes: view.bytes, objects: view.objects },
          ordinary_headroom: {
            bytes: Math.max(0, scope.bytes - view.bytes),
            objects: Math.max(0, scope.objects - view.objects),
          },
          ...(view.lifetime ? { lifetime: view.lifetime } : {}),
        };
      },
      true,
      true,
    );
  }

  describe(): Promise<{ volume: VolumeView; pending?: string }> {
    return this.run(
      async () => {
        const volume = await this.ensureTarget();
        const pending = this.state.pending?.kind ?? (this.state.renewal ? "renew" : undefined);
        return pending ? { volume, pending } : { volume };
      },
      true,
      true,
    );
  }

  /** Save an absolute deadline before sending it. Retries never extend it implicitly. */
  renewLease(until: number): Promise<VolumeView> {
    return this.run(async () => {
      const request = { target: this.target(), until };
      validateRenewRequest(request);
      if (this.state.disposal) refuse("fenced", "this workspace lifetime has been released");
      if (this.state.pending?.kind === "volume_release")
        refuse("busy", "the saved volume release must settle before renewal");
      // Older workspaces may already have a renewal in the original pending slot.
      if (this.state.pending?.kind === "renew") {
        if (!sameValue(this.state.pending.request, request))
          refuse("busy", "recover the saved renewal before changing its deadline");
        return (await this.lifecycle(this.state.pending, false)).volume!;
      }
      const saved = this.state.renewal;
      if (saved && !sameValue(saved, request))
        refuse("busy", "recover the saved renewal before changing its deadline");
      if (!saved) this.save({ ...this.state, renewal: request });
      return this.resumeRenewal(request, !saved);
    }, true);
  }

  private async resumeRenewal(request: RenewRequest, fresh: boolean): Promise<VolumeView> {
    let volume: VolumeView;
    try {
      volume = await this.transport.renewLease(request);
      if (!sameValue(volume.lifetime?.admission, this.state.admission))
        throw unknown(undefined, "renewal names another lifetime");
    } catch (error) {
      if (
        error instanceof NativeScratchPadError &&
        !error.unknown &&
        (fresh || error.code === "expired")
      ) {
        const state = { ...this.state };
        delete state.renewal;
        this.save(state, true);
        throw error;
      }
      throw unknown(error, "the saved renewal stays pending; call recover()");
    }
    const state = { ...this.state };
    delete state.renewal;
    this.save(state, true);
    return structuredClone(volume);
  }

  /** Read-only plan for an initialized writer. The caller chooses the path to remove. */
  planRemoval(
    path: string,
    options: { operationId: string; trace?: TraceIds },
  ): Promise<RemovalPlan> {
    return this.run(async () => {
      if (this.state.pending)
        refuse("busy", "recover the pending operation before planning removal");
      check(
        this.state.writer && this.state.admission,
        "removal requires an initialized reusable writer",
      );
      const view = await this.ensureTarget();
      return this.transport.planRemoval({
        target: this.target(),
        command: {
          creation_id: this.target().creation_id,
          writer: this.state.writer,
          number: this.state.next,
          operation_id: options.operationId,
          base: view.head,
          root: view.head.root,
          trace: wireTrace(options.trace),
          remove_path: path,
          retention: { enabled: false, slot: 0, generation: 0, until: 0 },
        },
      });
    });
  }

  applyRemoval(plan: RemovalPlan): Promise<Receipt> {
    const saved = structuredClone(plan);
    return this.run(async () => {
      validateRemovalPlan(saved);
      check(
        sameValue(saved.target, this.target()) &&
          saved.slot === this.state.admission?.slot &&
          saved.generation === this.state.admission.generation,
        "removal plan names another lifetime",
      );
      if (
        !this.state.pending &&
        this.state.removal &&
        sameValue(this.state.removal.command, saved.command)
      )
        return structuredClone(this.state.removal);
      return (await this.beginLifecycle({ kind: "remove", plan: saved })).receipt!;
    });
  }

  /** Lists every promise affected. EndPromises must be explicitly true to authorize release. */
  planVolumeRelease(options: {
    operationId: string;
    endPromises?: boolean;
  }): Promise<VolumeReleasePlan> {
    return this.run(async () => {
      if (this.state.pending)
        refuse("busy", "recover the pending operation before planning release");
      check(this.state.admission, "volume release requires a reusable lifetime");
      return this.transport.planVolumeRelease({
        target: this.target(),
        operation_id: options.operationId,
        end_promises: options.endPromises ?? false,
      });
    });
  }

  applyVolumeRelease(plan: VolumeReleasePlan): Promise<VolumeReleaseOutcome> {
    const saved = structuredClone(plan);
    return this.run(
      async () => {
        validateVolumeReleasePlan(saved);
        if (!this.state.pending && this.state.disposal) {
          check(sameValue(this.state.disposal_plan, saved), "completed release differs from plan");
          return this.releaseOutcome();
        }
        return (await this.beginLifecycle({ kind: "volume_release", plan: saved })).release!;
      },
      false,
      true,
    );
  }

  private async beginLifecycle(pending: Lifecycle): Promise<RecoveryResult> {
    if (this.state.disposal) refuse("fenced", "this workspace lifetime has been released");
    if (this.state.pending) {
      const saved = this.state.pending;
      const intent =
        saved.kind === "volume_release" ? { kind: saved.kind, plan: saved.plan } : saved;
      if (!sameValue(intent, pending))
        refuse("busy", "recover the saved operation before changing intent");
      return this.lifecycle(saved as Lifecycle, false);
    }
    this.change(pending);
    return this.lifecycle(pending, true);
  }

  private async lifecycle(pending: Lifecycle, fresh: boolean): Promise<RecoveryResult> {
    let result: RecoveryResult;
    try {
      if (pending.kind === "renew") {
        const volume = await this.transport.renewLease(pending.request);
        if (!sameValue(volume.lifetime?.admission, this.state.admission))
          throw unknown(undefined, "renewal names another lifetime");
        result = { kind: pending.kind, volume };
      } else if (pending.kind === "remove") {
        const receipt = await this.transport.applyRemoval(pending.plan);
        if (!sameValue(receipt.principal, this.principal))
          throw unknown(undefined, "removal names another principal");
        result = { kind: pending.kind, receipt };
      } else {
        result = {
          kind: pending.kind,
          release: await this.transport.applyVolumeRelease(pending.plan),
        };
      }
    } catch (error) {
      if (
        pending.kind === "volume_release" &&
        error instanceof NativeScratchPadError &&
        error.code === "generation_retired" &&
        !error.unknown
      ) {
        const release: VolumeReleaseResult = {
          target: pending.plan.request.target,
          slot: pending.plan.slot,
          generation: pending.plan.generation,
          operation_id: pending.plan.request.operation_id,
          disposed: true,
          capacity_returned: true,
        };
        return this.finishRelease(pending.plan, release, !pending.fence_accepted);
      }
      if (
        pending.kind === "volume_release" &&
        !fresh &&
        !pending.fence_accepted &&
        error instanceof NativeScratchPadError &&
        !error.unknown &&
        error.code === "conflict" &&
        (await this.releaseFenced(pending.plan))
      ) {
        const state = { ...this.state };
        delete state.pending;
        this.save(state, true);
        refuse("fenced", "the saved release cannot take effect; review a new release plan");
      }
      if (
        error instanceof NativeScratchPadError &&
        !error.unknown &&
        (fresh || (pending.kind === "renew" && error.code === "expired"))
      ) {
        const state = { ...this.state };
        delete state.pending;
        this.save(state, true);
        throw error;
      }
      throw unknown(error, `the saved ${pending.kind} request stays pending; call recover()`);
    }
    if (pending.kind === "volume_release" && result.release) {
      if (result.release.capacity_returned)
        return this.finishRelease(pending.plan, result.release, false);
      this.save({ ...this.state, pending: { ...pending, fence_accepted: true } }, true);
      return structuredClone(result);
    }
    const state = { ...this.state };
    delete state.pending;
    if (result.receipt) {
      state.removal = result.receipt;
      state.next = result.receipt.command.number + 1;
    }
    this.save(state, true);
    return structuredClone(result);
  }

  private async releaseFenced(plan: VolumeReleasePlan): Promise<boolean> {
    let current: VolumeReleasePlan;
    try {
      current = await this.transport.planVolumeRelease(plan.request);
    } catch {
      // A failed read supplies no evidence about the saved fence.
      return false;
    }
    // A plan can only describe an ordinary, nonterminal lifetime. A greater
    // native position for that same lifetime stops every delayed old CAS.
    return (
      sameValue(current.request, plan.request) &&
      current.incarnation === plan.incarnation &&
      current.slot === plan.slot &&
      current.generation === plan.generation &&
      current.sequence > plan.sequence
    );
  }

  private releaseOutcome(): VolumeReleaseOutcome {
    check(this.state.disposal, "workspace has no completed release");
    return structuredClone({
      ...this.state.disposal,
      ...(this.state.release_acceptance_unknown ? { acceptance_unknown: true as const } : {}),
    });
  }

  private finishRelease(
    plan: VolumeReleasePlan,
    disposal: VolumeReleaseResult,
    acceptanceUnknown: boolean,
  ): RecoveryResult {
    const state = { ...this.state, disposal, disposal_plan: plan };
    delete state.pending;
    if (acceptanceUnknown) state.release_acceptance_unknown = true;
    this.save(state, true);
    return { kind: "volume_release", release: this.releaseOutcome() };
  }

  recover(): Promise<RecoveryResult> {
    return this.run(() => this.recoverPending(), true, true);
  }

  private async recoverPending(): Promise<RecoveryResult> {
    if (this.state.renewal)
      return { kind: "renew", volume: await this.resumeRenewal(this.state.renewal, false) };
    const lifecycle = this.state.pending;
    if (
      lifecycle?.kind === "renew" ||
      lifecycle?.kind === "remove" ||
      lifecycle?.kind === "volume_release"
    )
      return this.lifecycle(lifecycle, false);
    if (this.state.disposal) return { kind: "volume_release", release: this.releaseOutcome() };
    if (this.state.pending?.kind === "reset")
      refuse("fenced", "reset outcome needs an explicit resetWriter with the observed generation");
    await this.initialize();
    const pending = this.state.pending;
    if (pending?.kind === "publish") {
      try {
        return { kind: "publish", ...(await this.resumePublish(pending)) };
      } catch (error) {
        if (
          error instanceof NativeScratchPadError &&
          error.code === "expired" &&
          !error.unknown &&
          !this.state.pending
        )
          return { kind: "expired" };
        throw error;
      }
    }
    if (pending) {
      if (
        pending.kind === "renew" ||
        pending.kind === "remove" ||
        pending.kind === "volume_release"
      )
        return this.lifecycle(pending, false);
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
      const scope = this.scope;
      if (!scope || !sameValue(scope.admission, this.state.admission) || this.state.disposal)
        refuse("fenced", "workspace has no matching current reservation");
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
      const capabilities = await this.transport.referenceInfo();
      const reference: ReferenceSpec | undefined = capabilities?.enabled
        ? { creator: this.state.creator, paths: [path] }
        : undefined;
      if (reference) validateReferenceSpec(reference);
      // Local preparation carries no remote mutation. An interrupted build can
      // be replaced; only the atomic save of the complete intent makes it pending.
      this.store.clearObjects();
      let ordinal = 0,
        totalBytes = 0;
      const put = (object: ObjectSpec["object"], data: Uint8Array): void => {
        totalBytes += data.length;
        if (totalBytes > scope.bytes || ordinal + 1 > scope.objects)
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
          view.objects + objects.length > scope.objects ||
          view.bytes + objects.reduce((n, object) => n + object.length, 0) > scope.bytes;
        if (needsCleanup) view = await this.maintainInternal();
        const slot = view.retentions.findIndex((entry) => !entry.pin);
        if (slot < 0)
          refuse(
            "capacity",
            "all retention slots are occupied; release finished handoffs or wait for their expiry",
          );
        if (
          view.objects + objects.length > scope.objects ||
          view.bytes + objects.reduce((n, object) => n + object.length, 0) > scope.bytes
        )
          refuse("capacity", "live roots and this artifact exceed the volume's capacity");
        const writer = this.state.writer!;
        const actual = view.writers[writer.slot]!;
        if (actual.generation !== writer.generation || actual.number + 1 !== this.state.next)
          refuse("fenced", "remote writer position differs from the durable workspace");
        if (view.closed) refuse("closed", "volume is closed by another maintenance interval");
        const deadlineClock = now();
        const until = Math.min(
          deadlineClock + ttl,
          view.lifetime?.expires_at || Number.MAX_SAFE_INTEGER,
        );
        if (until <= deadlineClock)
          refuse("expired", "the observed lifetime has no remaining retention window");
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
            until,
          },
        };
        const publication: Publication = {
          kind: "publish",
          command,
          path,
          ttl,
          ...(reference ? { reference } : {}),
        };
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
    if (publication.reference) {
      try {
        const result = await this.transport.referenceReceipt({
          target: this.target(),
          command: publication.command,
          reference: publication.reference,
        });
        if (!sameValue(result.receipt.principal, this.principal))
          throw unknown(undefined, "referenced receipt names another principal");
        return this.accept(publication, result.receipt, result.references[0]);
      } catch (error) {
        if (!(
          error instanceof NativeScratchPadError &&
          error.code === "not_found" &&
          !error.unknown
        ))
          throw error;
      }
    }
    const view = await this.transport.getVolume(this.target());
    const slot = view.writers[publication.command.writer.slot]!;
    // Read authoritative receipts before touching the spool: accepted data may
    // already have been collected, and a lost local spool does not erase success.
    if (
      !publication.reference &&
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
    if (publication.expiry_revision !== undefined) {
      await this.fenceExpired(publication, view);
      throw new NativeScratchPadError("expired", "saved publication expired without acceptance");
    }
    // An accepted command still returns its receipt after expiry. An expired
    // refusal needs a durable revision fence before an earlier in-flight CAS
    // can be ruled out; a clock check alone does not provide that fence.
    if (publication.command.retention.until > now()) await this.upload();
    let receipt: Receipt, resolved: ResolvedReference | undefined;
    try {
      if (publication.reference) {
        const result = await this.transport.referencePublish({
          target: this.target(),
          command: publication.command,
          reference: publication.reference,
        });
        receipt = result.receipt;
        resolved = result.references[0];
      } else {
        receipt = await this.transport.publish({
          target: this.target(),
          command: publication.command,
        });
      }
    } catch (error) {
      if (error instanceof NativeScratchPadError && error.code === "expired" && !error.unknown) {
        await this.fenceExpired(publication, view);
      }
      throw error;
    }
    if (
      !sameValue(receipt.command, publication.command) ||
      !sameValue(receipt.principal, this.principal)
    )
      throw unknown(undefined, "publish receipt differs from the saved command");
    return this.accept(publication, receipt, resolved);
  }

  private async fenceExpired(publication: Publication, view: VolumeView): Promise<void> {
    let revision = publication.expiry_revision;
    if (revision === undefined) {
      if (view.closed) refuse("closed", "another maintenance interval owns this closed volume");
      revision = view.revision;
      publication = { ...publication, expiry_revision: revision };
      this.change(publication);
    }
    if (!(view.closed && view.revision === revision + 1)) {
      if (view.revision !== revision) {
        const pending = { ...publication };
        delete pending.expiry_revision;
        this.change(pending);
        throw new NativeScratchPadError(
          "conflict",
          "expiry fence changed; recover the saved publication again",
        );
      }
      view = await this.transport.closeVolume({ target: this.target(), revision });
    }
    const slot = view.writers[publication.command.writer.slot]!;
    if (
      !view.closed ||
      view.revision !== revision + 1 ||
      slot.generation !== publication.command.writer.generation ||
      slot.number !== publication.command.number - 1
    )
      throw unknown(undefined, "expiry fence has not established publication absence");
    // Closing advanced the same metadata record that publication CAS uses.
    // Every older in-flight write is fenced; a new attempt fails on expiry.
    const continuation: Control = {
      kind: "apply",
      request: { target: this.target(), revision: view.revision },
    };
    this.save({ ...this.state, pending: continuation }, true, true);
    await this.control(continuation, true);
  }

  private accept(
    publication: Publication,
    receipt: Receipt,
    resolved?: ResolvedReference,
  ): PublishResult {
    check(
      Boolean(publication.reference) === Boolean(resolved),
      "referenced publication lost its descriptor",
    );
    const reference =
      resolved?.short ??
      encodeReference({
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
      last: {
        reference,
        receipt,
        path: publication.path,
        ttl: publication.ttl,
        ...(resolved ? { resolved } : {}),
      },
    };
    delete state.pending;
    this.save(state, true, true);
    if (resolved) this.cacheReference(resolved);
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

  owns(token: string): boolean | Promise<boolean> {
    const matches = (ref: Reference): boolean =>
      ref.creator === this.state.creator && sameValue(ref.target, this.state.target);
    if (token.startsWith(SHORT_REFERENCE_PREFIX))
      return this.resolveReference(token).then(matches, () => false);
    try {
      return matches(this.reference(token));
    } catch {
      return false;
    }
  }

  granted(token: string, grantee: Grantee): GrantKind | undefined | Promise<GrantKind | undefined> {
    const find = (ref: Reference): GrantKind | undefined => {
      if (ref.creator !== this.state.creator || !sameValue(ref.target, this.state.target))
        return undefined;
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
    };
    if (token.startsWith(SHORT_REFERENCE_PREFIX))
      return this.resolveReference(token).then(find, () => undefined);
    try {
      return find(this.reference(token));
    } catch {
      return undefined;
    }
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
      if (!(await this.owns(token)) || grantee.account !== this.principal.account)
        refuse("denied", "only the owner can grant this same-account reference");
      const ref = await this.resolveReference(token, trace);
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
      const ref = token.startsWith(SHORT_REFERENCE_PREFIX)
        ? await this.resolveReference(token)
        : decodeReference(token);
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
    if (control.kind === "apply" && this.state.admission) {
      let view: VolumeView;
      try {
        view = await this.transport.getVolume(control.request.target);
      } catch (error) {
        throw unknown(error, "private collection completion has not been observed");
      }
      if (view.epoch > control.request.revision) {
        const state = { ...this.state };
        delete state.pending;
        this.save(state, true);
        refuse("fenced", "a later collection epoch superseded the saved interval");
      }
      if (view.epoch < control.request.revision)
        throw unknown(undefined, "saved collection epoch has not been observed");
      if (view.closed) refuse("closed", "the private worker has not reopened the saved interval");
      const state = { ...this.state };
      delete state.pending;
      this.save(state, true);
      return;
    }
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
            if (
              this.state.admission
                ? view.epoch === control.request.revision + 1
                : view.closed && view.revision === control.request.revision + 1
            ) {
              failure = undefined;
              settled = true;
            } else if (view.revision !== control.request.revision) {
              settled = true;
              failure = new NativeScratchPadError(
                this.state.admission ? "fenced" : "conflict",
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
    if (
      control.kind === "close" &&
      this.state.admission &&
      view &&
      view.epoch > control.request.revision + 1
    ) {
      const state = { ...this.state };
      delete state.pending;
      this.save(state, true);
      refuse("fenced", "a later collection epoch superseded the saved close");
    }
    if (!settled)
      throw unknown(failure, `the saved ${control.kind} request stays pending; call recover()`);
    if (
      !failure &&
      control.kind === "close" &&
      (this.state.admission
        ? view?.epoch !== control.request.revision + 1
        : !view?.closed || view.revision !== control.request.revision + 1)
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
    if (!failure && control.kind === "close" && (!this.state.admission || view!.closed))
      state.pending = {
        kind: "apply",
        request: {
          target: this.target(),
          revision: this.state.admission ? control.request.revision + 1 : view!.revision,
        },
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
  if (options.volume !== undefined) validateVolume(options.volume);
  text(options.creator, 512, 1);
  const ttl = options.ttlSeconds ?? 600;
  uint(ttl, MAX_GRANT_SECONDS, 1);
  const transport = new ScratchPadTransport(options.nc, options);
  const info: Info = await transport.info();
  const bootstrap =
    options.bootstrapFile === undefined
      ? undefined
      : readScratchPadBootstrapFile(options.bootstrapFile);
  const volume = options.volume ?? bootstrap?.volume;
  validateVolume(volume);
  if (bootstrap) {
    check(
      sameValue(bootstrap.principal, info.principal),
      "bootstrap names another authenticated principal",
    );
    check(bootstrap.volume === volume, "bootstrap differs from the configured volume");
  }
  const scope = info.scopes.find((scope) => scope.volume === volume);
  const store = await WorkspaceStore.open(options.dir);
  try {
    let state = store.load();
    if (state === undefined) {
      if (!scope)
        refuse("denied", "authenticated principal owns no provisioned scope for this volume");
      if (bootstrap && !sameValue(scope.admission, bootstrap.admission))
        refuse("fenced", "bootstrap does not match the current admission");
      state = {
        version: 1,
        principal: info.principal,
        volume,
        creator: options.creator,
        creation: bootstrap
          ? structuredClone(bootstrap.creation)
          : { operation_id: randomUUID(), trace: {} },
        ...(scope.admission ? { admission: structuredClone(scope.admission) } : {}),
        next: 1,
        grants: [],
      } satisfies State;
      store.save(state);
    }
    validateState(state);
    if (bootstrap) {
      check(
        sameValue(state.principal, bootstrap.principal) &&
          state.volume === bootstrap.volume &&
          sameValue(state.admission, bootstrap.admission) &&
          sameValue(state.creation, bootstrap.creation),
        "workspace differs from the bootstrap creation request",
      );
      if (state.disposal || state.disposal_plan || state.pending?.kind === "volume_release")
        refuse("fenced", "bootstrap cannot reopen a workspace with a saved disposal");
    }
    if (!bootstrap && !state.target && (!scope || !sameValue(state.admission, scope.admission)))
      refuse(
        "fenced",
        "saved creation does not match the current admission; it cannot adopt a new lifetime",
      );
    check(
      sameValue(state.principal, info.principal) &&
        state.volume === volume &&
        state.creator === options.creator,
      "workspace is bound to another principal, volume, or creator",
    );
    return new NativeScratchPad(transport, store, state, scope, ttl);
  } catch (error) {
    store.close();
    throw error;
  }
}

/** A volume or bootstrap file enables the native client on its existing connection. */
export async function nativeScratchPadFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: ScratchPadReaderOptions & { creator: string },
): Promise<NativeScratchPad | undefined> {
  const volume = env["SCRATCHPAD_VOLUME"];
  const bootstrapFile = env["SCRATCHPAD_BOOTSTRAP_FILE"] || undefined;
  if (!volume && !bootstrapFile) return undefined;
  const dir = env["SCRATCHPAD_DIR"];
  check(dir, "SCRATCHPAD_DIR must name a persistent private directory for the native client");
  const value = env["SCRATCHPAD_GRANT_TTL_S"];
  check(value === undefined || /^[0-9]+$/.test(value), "SCRATCHPAD_GRANT_TTL_S must be an integer");
  return nativeScratchPad({
    ...options,
    ...(volume ? { volume } : {}),
    ...(bootstrapFile ? { bootstrapFile } : {}),
    dir,
    ...(value === undefined ? {} : { ttlSeconds: Number(value) }),
  });
}
