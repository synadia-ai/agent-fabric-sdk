import { invalid } from "./errors";
import unicode15Unassigned from "@unicode/unicode-15.0.0/General_Category/Unassigned/regex.mjs";

// Core protocol baseline: ScratchPad 2f59c514c9d8aed39b510eae1abbab8062185ed5.
// Optional lifecycle fields and their recovery rules are in docs/scratchpad-native.md.
export const SUBJECT_PREFIX = "sp.v1.api.v2.";
export const METADATA_HEADER = "ScratchPad-Metadata";
export const REPLY_HEADER = "ScratchPad-Reply";
export const CHUNK_SIZE = 512 * 1024;
export const MAX_NODE_BYTES = 900 * 1024;
export const MAX_CHUNKS = 20480;
export const MAX_TREE_ENTRIES = 8192;
export const MAX_DEPTH = 128;
export const MAX_CONTROL_BYTES = 16 * 1024;
export const MAX_REPLY_BYTES = 128 * 1024;
export const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_READ_BYTES = CHUNK_SIZE;
export const MAX_PREPARE_OBJECTS = 64;
export const MAX_VOLUME_OBJECTS = 65536;
export const MAX_VOLUME_BYTES = 8 * 2 ** 30;
export const MAX_ADMISSION_SLOT = 0xffffffff;
export const WRITER_SLOTS = 8;
export const RETENTION_SLOTS = 8;
export const GRANT_SLOTS = 16;
export const MAX_GRANT_SECONDS = 3600;
export const ZERO_CONTENT_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const CODES = [
  "ok",
  "invalid",
  "unauthenticated",
  "denied",
  "not_found",
  "exists",
  "conflict",
  "fenced",
  "generation_retired",
  "intent_changed",
  "capacity",
  "summary_limit",
  "closed",
  "epoch_changed",
  "expired",
  "corrupt",
  "incomplete",
  "busy",
  "unknown",
  "unavailable",
  "internal",
] as const;
export type Code = (typeof CODES)[number];
export type ContentID = string;
export interface Principal {
  account: string;
  user: string;
}
export interface Trace {
  thread_id?: string;
  root_id?: string;
  tool_call_id?: string;
}
export interface Action {
  operation_id: string;
  trace: Trace;
}
export interface Target {
  volume: string;
  creation_id: string;
}
export interface Head {
  generation: number;
  root: ContentID;
}
export interface Writer {
  slot: number;
  generation: number;
}
export interface RetentionIntent {
  enabled: boolean;
  slot: number;
  generation: number;
  until: number;
}
export interface RetentionHandle {
  slot: number;
  generation: number;
}
export interface GrantHandle {
  slot: number;
  generation: number;
}
export interface RetentionOrigin {
  writer: Writer;
  number: number;
}
export interface Command {
  creation_id: string;
  writer: Writer;
  number: number;
  operation_id: string;
  base: Head;
  root: ContentID;
  trace: Trace;
  remove_path?: string;
  retention: RetentionIntent;
}
export interface Receipt {
  volume: string;
  principal: Principal;
  command: Command;
  head: Head;
  retention: RetentionHandle;
}
export interface WriterSlot {
  generation: number;
  number: number;
  principal?: Principal;
  write: boolean;
  receipt?: Receipt;
}
export interface RetentionValue {
  root: ContentID;
  until: number;
  origin: RetentionOrigin;
}
export interface RetentionSlot {
  generation: number;
  pin?: RetentionValue;
}
export interface GrantValue {
  principal: Principal;
  root: ContentID;
  path: string;
  directory: boolean;
  retention: RetentionHandle;
  until: number;
}
export interface GrantSlot {
  generation: number;
  grant?: GrantValue;
}
export interface VolumeView {
  target: Target;
  owner: Principal;
  head: Head;
  revision: number;
  closed: boolean;
  epoch: number;
  objects: number;
  bytes: number;
  writers: WriterSlot[];
  retentions: RetentionSlot[];
  grants: GrantSlot[];
  lifetime?: LifetimeView;
}
export interface AdmissionBinding {
  slot: number;
  generation: number;
  operation_id: string;
}
export interface LifetimeView {
  admission: AdmissionBinding;
  phase: "active" | "shrinking" | "expiring";
  expires_at: number;
  grace_until: number;
  max_lease_seconds: number;
  grace_seconds: number;
  recovery_reads: boolean;
  reserve_objects: number;
  reserve_bytes: number;
}
export interface RenewRequest {
  target: Target;
  until: number;
}
export interface RemovalRequest {
  target: Target;
  command: Command;
}
export interface RemovalPlan extends RemovalRequest {
  slot: number;
  generation: number;
  sequence: number;
  added_objects: number;
  added_bytes: number;
}
export interface VolumeReleaseRequest {
  target: Target;
  operation_id: string;
  end_promises: boolean;
}
export interface ReleaseEffects {
  objects: number;
  bytes: number;
  retentions: number;
  read_grants: number;
  access_slots: number;
  references: number;
}
export interface VolumeReleasePlan {
  request: VolumeReleaseRequest;
  incarnation: string;
  slot: number;
  generation: number;
  sequence: number;
  head: Head;
  effects: ReleaseEffects;
}
export interface VolumeReleaseResult {
  target: Target;
  slot: number;
  generation: number;
  operation_id: string;
  disposed: boolean;
  capacity_returned: boolean;
}
export interface Limits {
  object_bytes: number;
  read_bytes: number;
  control_bytes: number;
  reply_bytes: number;
  writers: number;
  retentions: number;
  grants: number;
  grant_seconds: number;
}
export const PUBLIC_LIMITS: Readonly<Limits> = Object.freeze({
  object_bytes: MAX_NODE_BYTES,
  read_bytes: MAX_READ_BYTES,
  control_bytes: MAX_CONTROL_BYTES,
  reply_bytes: MAX_REPLY_BYTES,
  writers: WRITER_SLOTS,
  retentions: RETENTION_SLOTS,
  grants: GRANT_SLOTS,
  grant_seconds: MAX_GRANT_SECONDS,
});
export interface ReservedScope {
  volume: string;
  objects: number;
  bytes: number;
  admission?: AdmissionBinding;
}
export interface Info {
  principal: Principal;
  scopes: ReservedScope[];
  limits: Limits;
}
export interface ContentObject {
  kind: "chnk" | "fobj" | "tree";
  id: ContentID;
}
export interface ObjectSpec {
  object: ContentObject;
  length: number;
}
export type AllocationState = "reserved" | "verifying" | "verified" | "refused";
export interface ObjectProgress extends ObjectSpec {
  state: AllocationState;
  next: number;
  code: Code;
}
export interface PrepareRequest {
  target: Target;
  objects: ObjectSpec[];
}
export interface PrepareResult {
  epoch: number;
  objects: ObjectProgress[];
}
export interface VerifyRequest {
  target: Target;
  epoch: number;
  objects: ContentObject[];
}
export interface VerifyResult {
  epoch: number;
  objects: ObjectProgress[];
}
export interface PutRequest {
  target: Target;
  object: ContentObject;
  epoch: number;
}
export interface CreateRequest {
  volume: string;
  action: Action;
  admission?: AdmissionBinding;
}
export interface PublishRequest {
  target: Target;
  command: Command;
}
export interface ResetRequest {
  target: Target;
  writer: Writer;
}
export interface RetainRequest {
  target: Target;
  slot: number;
  generation: number;
  root: ContentID;
  until: number;
  action: Action;
}
export interface ReleaseRequest {
  target: Target;
  handle: RetentionHandle;
}
export interface GrantIssueRequest {
  target: Target;
  slot: number;
  generation: number;
  principal: Principal;
  root: ContentID;
  path: string;
  retention: RetentionHandle;
  until: number;
  action: Action;
}
export interface RevokeRequest {
  target: Target;
  handle: GrantHandle;
  action: Action;
}
export interface PathRequest {
  target: Target;
  root: ContentID;
  path: string;
  trace: Trace;
}
export interface ReadRequest extends PathRequest {
  offset: number;
  length: number;
}
export interface ListRequest extends PathRequest {
  offset: number;
  limit: number;
}
export interface Stat {
  type: "file" | "directory" | "symlink";
  object: ContentID;
  size: number;
  sha256: string;
  executable: boolean;
  link_target?: string;
}
export interface Entry {
  name: string;
  type: "file" | "directory" | "symlink";
  object: ContentID;
  executable: boolean;
  link_target?: string;
}
export interface ListResult {
  entries: Entry[];
  next: number;
  done: boolean;
}
export interface RangeMetadata {
  stat: Stat;
  offset: number;
  length: number;
}
export interface ReplyMetadata {
  code: Code;
  message: string;
  range?: RangeMetadata;
}
export interface ReadResult {
  stat: Stat;
  offset: number;
  data: Uint8Array;
}
export interface MaintenanceRequest {
  target: Target;
  revision: number;
}
export interface CollectionReport {
  inventory_objects: number;
  inventory_bytes: number;
  live_objects: number;
  live_bytes: number;
  candidate_objects: number;
  candidate_bytes: number;
  delete_objects: number;
}
export interface CollectionResult {
  volume: VolumeView;
  collection: CollectionReport;
}

export type Validator<T> = (value: unknown) => asserts value is T;
type RecordValue = Record<string, unknown>;
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw invalid(message);
}
export function record(value: unknown, required: string[], optional: string[] = []): RecordValue {
  check(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "expected JSON object",
  );
  const result = value as RecordValue;
  check(
    required.every((key) => Object.hasOwn(result, key)),
    "required field is absent",
  );
  check(
    Object.keys(result).every((key) => required.includes(key) || optional.includes(key)),
    "unknown field",
  );
  return result;
}
export function uint(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
  min = 0,
): asserts value is number {
  check(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max,
    "integer outside its bound",
  );
}
function bool(value: unknown): asserts value is boolean {
  check(typeof value === "boolean", "expected boolean");
}
export function text(value: unknown, max: number, min = 0): asserts value is string {
  check(
    typeof value === "string" && Buffer.from(value).toString("utf8") === value,
    "invalid Unicode text",
  );
  check(
    Buffer.byteLength(value) <= max && Buffer.byteLength(value) >= min,
    "text outside its byte bound",
  );
}
export function validateContentID(value: unknown): asserts value is ContentID {
  check(typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value), "invalid content identity");
  const bytes = Buffer.from(value, "base64url");
  check(
    bytes.length === 32 && bytes.toString("base64url") === value,
    "noncanonical content identity",
  );
}
export function validatePublicKey(
  value: unknown,
  kind: "account" | "user",
): asserts value is string {
  check(typeof value === "string" && /^[A-Z2-7]{56}$/.test(value), "invalid public NKEY");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    pending = 0;
  const data: number[] = [];
  for (const character of value) {
    pending = (pending << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      data.push((pending >>> bits) & 255);
    }
  }
  check(data.length === 35 && data[0] === (kind === "account" ? 0 : 160), "wrong NKEY kind");
  let crc = 0;
  for (const byte of data.slice(0, 33)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = ((crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  check(data[33] === (crc & 255) && data[34] === crc >>> 8, "NKEY checksum differs");
}
export function validatePrincipal(value: unknown): asserts value is Principal {
  const v = record(value, ["account", "user"]);
  validatePublicKey(v.account, "account");
  validatePublicKey(v.user, "user");
}
export function validateName(value: unknown): asserts value is string {
  text(value, 255, 1);
  check(value !== "." && value !== ".." && !/[\x00-\x1f\x7f/]/.test(value), "forbidden entry name");
  check(normalizeUnicode15(value) === value, "entry name is not NFC");
}
/** Unicode normalization is stable for assigned characters. Characters that
 * were unassigned in 15.0 are inert boundaries, even on newer Node runtimes.
 */
export function normalizeUnicode15(value: string): string {
  let result = "",
    assigned = "";
  for (const point of value) {
    if (unicode15Unassigned.test(point)) {
      result += assigned.normalize("NFC") + point;
      assigned = "";
    } else assigned += point;
  }
  return result + assigned.normalize("NFC");
}
export function validatePath(value: unknown, maxBytes = 4096): asserts value is string {
  text(value, maxBytes, 1);
  check(value.startsWith("/"), "path must be absolute");
  if (value === "/") return;
  const names = value.slice(1).split("/");
  check(names.length <= MAX_DEPTH, "path exceeds its depth bound");
  for (const name of names) validateName(name);
}
export function validateVolume(value: unknown): asserts value is string {
  check(typeof value === "string" && /^[0-9A-Za-z]{1,64}$/.test(value), "invalid volume name");
}
export function validateTarget(value: unknown): asserts value is Target {
  const v = record(value, ["volume", "creation_id"]);
  validateVolume(v.volume);
  check(
    typeof v.creation_id === "string" && /^[0-9a-f]{32}$/.test(v.creation_id),
    "invalid volume creation identity",
  );
}
export function validateTrace(value: unknown): asserts value is Trace {
  const v = record(value, [], ["thread_id", "root_id", "tool_call_id"]);
  for (const field of ["thread_id", "root_id"] as const) {
    if (v[field] !== undefined) text(v[field], 32);
  }
  if (v.tool_call_id !== undefined) {
    text(v.tool_call_id, 1024);
    check([...v.tool_call_id].length <= 256, "tool-call label is too long");
  }
  if (!v.thread_id && !v.root_id && !v.tool_call_id) return;
  check(
    typeof v.thread_id === "string" && /^[0-9a-f]{32}$/.test(v.thread_id),
    "invalid trace thread",
  );
  check(typeof v.root_id === "string" && /^[0-9a-f]{32}$/.test(v.root_id), "invalid trace root");
}
export function validateAction(value: unknown): asserts value is Action {
  const v = record(value, ["operation_id", "trace"]);
  text(v.operation_id, 256, 1);
  check([...v.operation_id].length <= 64, "operation identity is too long");
  validateTrace(v.trace);
}
export function validateHead(value: unknown): asserts value is Head {
  const v = record(value, ["generation", "root"]);
  uint(v.generation, undefined, 1);
  validateContentID(v.root);
}
export function validateWriter(value: unknown): asserts value is Writer {
  const v = record(value, ["slot", "generation"]);
  uint(v.slot, WRITER_SLOTS - 1);
  uint(v.generation, undefined, 1);
}
export function validateRetentionHandle(value: unknown): asserts value is RetentionHandle {
  const v = record(value, ["slot", "generation"]);
  uint(v.slot, RETENTION_SLOTS - 1);
  uint(v.generation, undefined, 1);
}
export function validateGrantHandle(value: unknown): asserts value is GrantHandle {
  const v = record(value, ["slot", "generation"]);
  uint(v.slot, GRANT_SLOTS - 1);
  uint(v.generation, undefined, 1);
}
export function validateCommand(value: unknown): asserts value is Command {
  const v = record(
    value,
    ["creation_id", "writer", "number", "operation_id", "base", "root", "trace", "retention"],
    ["remove_path"],
  );
  validateTarget({ volume: "v", creation_id: v.creation_id });
  validateWriter(v.writer);
  uint(v.number, undefined, 1);
  validateAction({ operation_id: v.operation_id, trace: v.trace });
  validateHead(v.base);
  validateContentID(v.root);
  const r = record(v.retention, ["enabled", "slot", "generation", "until"]);
  bool(r.enabled);
  uint(r.slot, RETENTION_SLOTS - 1);
  uint(r.generation);
  uint(r.until);
  check(
    r.enabled || (r.slot === 0 && r.generation === 0 && r.until === 0),
    "disabled retention must be zero",
  );
  if (v.remove_path !== undefined) {
    validatePath(v.remove_path);
    check(v.remove_path !== "/" && !r.enabled, "removal cannot retain or remove the root");
  }
}
export function validateReceipt(value: unknown): asserts value is Receipt {
  const v = record(value, ["volume", "principal", "command", "head", "retention"]);
  validateVolume(v.volume);
  validatePrincipal(v.principal);
  validateCommand(v.command);
  validateHead(v.head);
  check(
    v.head.root === v.command.root && v.head.generation - v.command.base.generation === 1,
    "receipt head differs from command",
  );
  if (v.command.retention.enabled) {
    validateRetentionHandle(v.retention);
    check(
      v.retention.slot === v.command.retention.slot &&
        v.retention.generation > v.command.retention.generation,
      "receipt retention differs from command",
    );
  } else {
    const retention = record(v.retention, ["slot", "generation"]);
    check(retention.slot === 0 && retention.generation === 0, "unexpected receipt retention");
  }
}
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as RecordValue,
    right = b as RecordValue;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

export function validateVolumeView(value: unknown): asserts value is VolumeView {
  const v = record(
    value,
    [
      "target",
      "owner",
      "head",
      "revision",
      "closed",
      "epoch",
      "objects",
      "bytes",
      "writers",
      "retentions",
      "grants",
    ],
    ["lifetime"],
  );
  if (v.lifetime !== undefined) validateLifetimeView(v.lifetime);
  validateTarget(v.target);
  validatePrincipal(v.owner);
  validateHead(v.head);
  uint(v.revision, undefined, 1);
  bool(v.closed);
  uint(v.epoch, v.revision);
  uint(v.objects, MAX_VOLUME_OBJECTS);
  uint(v.bytes, MAX_VOLUME_BYTES);
  check(
    v.head.generation <= v.revision && (!v.closed || v.epoch === v.revision),
    "inconsistent volume revision",
  );
  check(Array.isArray(v.writers) && v.writers.length === WRITER_SLOTS, "wrong writer slot count");
  for (const [index, raw] of v.writers.entries()) {
    const slot = record(raw, ["generation", "number", "write"], ["principal", "receipt"]);
    uint(slot.generation, v.revision, 1);
    uint(slot.number);
    bool(slot.write);
    if (slot.principal !== undefined) {
      validatePrincipal(slot.principal);
      check(slot.principal.account === v.owner.account, "writer belongs to another account");
    } else check(!slot.write, "writer identity absent");
    if (slot.number === 0) check(slot.receipt === undefined, "unused writer has a receipt");
    else {
      validateReceipt(slot.receipt);
      check(
        ((slot.principal === undefined && !slot.write) ||
          (slot.write && sameValue(slot.receipt.principal, slot.principal))) &&
          slot.receipt.principal.account === v.owner.account &&
          slot.receipt.volume === v.target.volume &&
          slot.receipt.command.creation_id === v.target.creation_id &&
          slot.receipt.command.writer.slot === index &&
          slot.receipt.command.writer.generation === slot.generation &&
          slot.receipt.command.number === slot.number &&
          slot.receipt.head.generation <= v.head.generation,
        "writer receipt differs from slot",
      );
    }
  }
  check(
    Array.isArray(v.retentions) && v.retentions.length === RETENTION_SLOTS,
    "wrong retention slot count",
  );
  for (const raw of v.retentions) {
    const slot = record(raw, ["generation"], ["pin"]);
    uint(slot.generation, v.revision);
    if (slot.pin !== undefined) {
      check(slot.generation > 0, "retention pin has zero generation");
      const pin = record(slot.pin, ["root", "until", "origin"]);
      validateContentID(pin.root);
      uint(pin.until);
      const origin = record(pin.origin, ["writer", "number"]);
      uint(origin.number);
      if (origin.number === 0) {
        const writer = record(origin.writer, ["slot", "generation"]);
        check(writer.slot === 0 && writer.generation === 0, "empty retention origin is not zero");
      } else {
        validateWriter(origin.writer);
        check(origin.writer.generation < slot.generation, "retention origin generation is invalid");
      }
    }
  }
  check(Array.isArray(v.grants) && v.grants.length === GRANT_SLOTS, "wrong grant slot count");
  for (const raw of v.grants) {
    const slot = record(raw, ["generation"], ["grant"]);
    uint(slot.generation, v.revision);
    if (slot.grant !== undefined) {
      check(slot.generation > 0, "grant has zero generation");
      const grant = record(slot.grant, [
        "principal",
        "root",
        "path",
        "directory",
        "retention",
        "until",
      ]);
      validatePrincipal(grant.principal);
      validateContentID(grant.root);
      validatePath(grant.path, 256);
      bool(grant.directory);
      validateRetentionHandle(grant.retention);
      uint(grant.until, undefined, 1);
      check(
        grant.principal.account === v.owner.account && grant.retention.generation < slot.generation,
        "invalid grant principal or retention generation",
      );
    }
  }
}
export function validateInfo(value: unknown): asserts value is Info {
  const v = record(value, ["principal", "scopes", "limits"]);
  validatePrincipal(v.principal);
  check(sameValue(v.limits, PUBLIC_LIMITS), "service limits differ from this client contract");
  check(Array.isArray(v.scopes) && v.scopes.length <= 16, "scope count exceeds bound");
  const seen = new Set<string>();
  for (const raw of v.scopes) {
    const scope = record(raw, ["volume", "objects", "bytes"], ["admission"]);
    if (scope.admission !== undefined) validateAdmissionBinding(scope.admission);
    validateVolume(scope.volume);
    uint(scope.objects, MAX_VOLUME_OBJECTS, 1);
    uint(scope.bytes, MAX_VOLUME_BYTES, 4);
    check(!seen.has(scope.volume), "duplicate scope");
    seen.add(scope.volume);
  }
}
export function validateContentObject(value: unknown): asserts value is ContentObject {
  const v = record(value, ["kind", "id"]);
  validateContentID(v.id);
  check(v.kind === "chnk" || v.kind === "fobj" || v.kind === "tree", "unsupported object kind");
}
export function validateAdmissionBinding(value: unknown): asserts value is AdmissionBinding {
  const v = record(value, ["slot", "generation", "operation_id"]);
  uint(v.slot, MAX_ADMISSION_SLOT);
  uint(v.generation, undefined, 1);
  validateAction({ operation_id: v.operation_id, trace: {} });
}
export function validateLifetimeView(value: unknown): asserts value is LifetimeView {
  const v = record(value, [
    "admission",
    "phase",
    "expires_at",
    "grace_until",
    "max_lease_seconds",
    "grace_seconds",
    "recovery_reads",
    "reserve_objects",
    "reserve_bytes",
  ]);
  validateAdmissionBinding(v.admission);
  for (const key of ["expires_at", "grace_until", "max_lease_seconds", "grace_seconds"])
    uint(v[key]);
  bool(v.recovery_reads);
  uint(v.reserve_objects, 128);
  uint(v.reserve_bytes, 8 * 2 ** 20);
  check((v.reserve_objects === 0) === (v.reserve_bytes === 0), "incomplete metadata reserve");
  check(
    v.phase === "active" || v.phase === "shrinking" || v.phase === "expiring",
    "invalid lifetime phase",
  );
  check(
    v.phase === "expiring"
      ? (v.expires_at as number) > 0 &&
          (v.grace_until === 0 || (v.grace_until as number) >= (v.expires_at as number))
      : v.grace_until === 0,
    "invalid lifetime grace",
  );
  check(
    v.expires_at === 0
      ? v.grace_seconds === 0
      : (v.max_lease_seconds as number) > 0 && (v.grace_seconds as number) > 0,
    "invalid lease policy",
  );
}
export function validateRenewRequest(value: unknown): asserts value is RenewRequest {
  const v = record(value, ["target", "until"]);
  validateTarget(v.target);
  uint(v.until, undefined, 1);
}
export function validateRemovalRequest(value: unknown): asserts value is RemovalRequest {
  const v = record(value, ["target", "command"]);
  validateTarget(v.target);
  validateCommand(v.command);
  check(
    v.command.remove_path && v.command.creation_id === v.target.creation_id,
    "invalid removal command",
  );
}
export function validateRemovalPlan(value: unknown): asserts value is RemovalPlan {
  const v = record(value, [
    "target",
    "slot",
    "generation",
    "sequence",
    "command",
    "added_objects",
    "added_bytes",
  ]);
  validateRemovalRequest({ target: v.target, command: v.command });
  uint(v.slot, MAX_ADMISSION_SLOT);
  uint(v.generation, undefined, 1);
  uint(v.sequence, undefined, 1);
  uint(v.added_objects, 128);
  uint(v.added_bytes, 8 * 2 ** 20);
}
export function validateVolumeReleaseRequest(
  value: unknown,
): asserts value is VolumeReleaseRequest {
  const v = record(value, ["target", "operation_id", "end_promises"]);
  validateTarget(v.target);
  validateAction({ operation_id: v.operation_id, trace: {} });
  bool(v.end_promises);
}
export function validateVolumeReleasePlan(value: unknown): asserts value is VolumeReleasePlan {
  const v = record(value, [
    "request",
    "incarnation",
    "slot",
    "generation",
    "sequence",
    "head",
    "effects",
  ]);
  validateVolumeReleaseRequest(v.request);
  text(v.incarnation, 64, 64);
  check(/^[0-9a-f]{64}$/.test(v.incarnation), "invalid release incarnation");
  uint(v.slot, MAX_ADMISSION_SLOT);
  uint(v.generation, undefined, 1);
  uint(v.sequence, undefined, 1);
  validateHead(v.head);
  const effects = record(v.effects, [
    "objects",
    "bytes",
    "retentions",
    "read_grants",
    "access_slots",
    "references",
  ]);
  uint(effects.objects, MAX_VOLUME_OBJECTS);
  uint(effects.bytes, MAX_VOLUME_BYTES);
  uint(effects.retentions, RETENTION_SLOTS);
  uint(effects.read_grants, GRANT_SLOTS);
  uint(effects.access_slots, WRITER_SLOTS);
  uint(effects.references, RETENTION_SLOTS);
}
export function validateVolumeReleaseResult(value: unknown): asserts value is VolumeReleaseResult {
  const v = record(value, [
    "target",
    "slot",
    "generation",
    "operation_id",
    "disposed",
    "capacity_returned",
  ]);
  validateTarget(v.target);
  uint(v.slot, MAX_ADMISSION_SLOT);
  uint(v.generation, undefined, 1);
  validateAction({ operation_id: v.operation_id, trace: {} });
  bool(v.disposed);
  bool(v.capacity_returned);
  check(!v.capacity_returned || v.disposed, "capacity returned before disposal");
}
export function validateObjectSpec(value: unknown): asserts value is ObjectSpec {
  const v = record(value, ["object", "length"]);
  validateContentObject(v.object);
  uint(v.length, v.object.kind === "chnk" ? CHUNK_SIZE : MAX_NODE_BYTES, 1);
}
function validateProgress(value: unknown, preparation: boolean): asserts value is ObjectProgress {
  const v = record(value, ["object", "length", "state", "next", "code"]);
  validateObjectSpec({ object: v.object, length: v.length });
  validateContentObject(v.object);
  uint(v.next);
  if (v.state === "refused") {
    check(preparation && v.next === 0 && v.code === "capacity", "invalid refusal state");
    return;
  }
  check(v.code === "ok", "invalid progress code");
  if (v.state === "reserved" || v.state === "verified")
    check(v.next === 0, "unexpected progress cursor");
  else {
    check(v.state === "verifying" && v.object.kind !== "chnk", "invalid progress state");
    uint(v.next, (v.object.kind === "tree" ? MAX_TREE_ENTRIES : MAX_CHUNKS) - 1, 1);
  }
}
function validateProgressResult(
  value: unknown,
  preparation: boolean,
): asserts value is PrepareResult {
  const v = record(value, ["epoch", "objects"]);
  uint(v.epoch);
  check(
    Array.isArray(v.objects) && v.objects.length > 0 && v.objects.length <= MAX_PREPARE_OBJECTS,
    "invalid progress count",
  );
  const seen = new Set<string>();
  for (const raw of v.objects) {
    validateProgress(raw, preparation);
    const key = raw.object.kind + ":" + raw.object.id;
    check(!seen.has(key), "duplicate object progress");
    seen.add(key);
  }
}
export function validatePrepareResult(value: unknown): asserts value is PrepareResult {
  validateProgressResult(value, true);
}
export function validateVerifyResult(value: unknown): asserts value is VerifyResult {
  validateProgressResult(value, false);
}
function validateEntryBody(v: RecordValue): void {
  validateContentID(v.object);
  bool(v.executable);
  if (v.type === "symlink") {
    text(v.link_target, 4096, 1);
    check(
      !v.link_target.includes("\0") && !v.executable && v.object === ZERO_CONTENT_ID,
      "invalid symlink metadata",
    );
  } else {
    check(v.type === "file" || v.type === "directory", "invalid entry type");
    check(v.link_target === undefined || v.link_target === "", "unexpected symlink target");
    check(v.type === "file" || !v.executable, "directory is executable");
  }
}
export function validateStat(value: unknown): asserts value is Stat {
  const v = record(value, ["type", "object", "size", "sha256", "executable"], ["link_target"]);
  validateEntryBody(v);
  uint(v.size, MAX_VOLUME_BYTES);
  if (v.type === "file")
    check(typeof v.sha256 === "string" && /^[0-9a-f]{64}$/.test(v.sha256), "invalid file digest");
  else check(v.size === 0 && v.sha256 === "", "non-file metadata contains file bytes");
}
export function validateListResult(value: unknown): asserts value is ListResult {
  const v = record(value, ["entries", "next", "done"]);
  uint(v.next, MAX_TREE_ENTRIES);
  bool(v.done);
  check(
    Array.isArray(v.entries) &&
      v.entries.length <= 64 &&
      v.entries.length <= v.next &&
      (v.done || v.entries.length > 0),
    "invalid list window",
  );
  let last = Buffer.alloc(0),
    bytes = 0;
  for (const raw of v.entries) {
    const entry = record(raw, ["name", "type", "object", "executable"], ["link_target"]);
    validateName(entry.name);
    validateEntryBody(entry);
    const name = Buffer.from(entry.name);
    check(Buffer.compare(last, name) < 0, "list names are not strictly ordered");
    last = name;
    bytes += Buffer.byteLength(goJSON(entry)) + 1;
  }
  check(bytes <= 64 * 1024, "list bytes exceed bound");
}
export function validateReplyMetadata(value: unknown): asserts value is ReplyMetadata {
  const v = record(value, ["code", "message"], ["range"]);
  check(
    typeof v.code === "string" && (CODES as readonly string[]).includes(v.code),
    "unknown reply code",
  );
  text(v.message, 256);
  if (v.code !== "ok") {
    check(v.message !== "" && v.range === undefined, "invalid error reply");
    return;
  }
  check(v.message === "", "success reply has an error message");
  if (v.range !== undefined) {
    const range = record(v.range, ["stat", "offset", "length"]);
    validateStat(range.stat);
    check(range.stat.type === "file", "range is not a file");
    uint(range.offset, range.stat.size);
    uint(range.length, MAX_READ_BYTES);
    check(range.length <= range.stat.size - range.offset, "range exceeds file");
  }
}
export function validateCollectionReport(value: unknown): asserts value is CollectionReport {
  const v = record(value, [
    "inventory_objects",
    "inventory_bytes",
    "live_objects",
    "live_bytes",
    "candidate_objects",
    "candidate_bytes",
    "delete_objects",
  ]);
  uint(v.inventory_objects, MAX_VOLUME_OBJECTS);
  uint(v.inventory_bytes, MAX_VOLUME_BYTES);
  uint(v.live_objects, v.inventory_objects);
  uint(v.live_bytes, v.inventory_bytes);
  uint(v.candidate_objects);
  uint(v.candidate_bytes);
  uint(v.delete_objects);
  check(
    v.candidate_objects === v.inventory_objects - v.live_objects &&
      v.candidate_bytes === v.inventory_bytes - v.live_bytes &&
      v.delete_objects <= v.candidate_objects,
    "collection counters differ",
  );
}
export function validateCollectionResult(value: unknown): asserts value is CollectionResult {
  const v = record(value, ["volume", "collection"]);
  validateVolumeView(v.volume);
  validateCollectionReport(v.collection);
  check(
    !v.volume.closed &&
      v.volume.objects === v.collection.live_objects &&
      v.volume.bytes === v.collection.live_bytes,
    "collection does not match reopened volume",
  );
}
export function validateEmpty(value: unknown): asserts value is Record<string, never> {
  record(value, []);
}

/** JSON's Unicode escaping matches encoding/json; HTML escaping is selectable for references. */
export function goJSON(value: unknown, escapeHTML = true): string {
  let encoded = JSON.stringify(value);
  check(encoded !== undefined, "value cannot be encoded as JSON");
  encoded = encoded.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return escapeHTML
    ? encoded.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    : encoded;
}

/** Reject duplicate keys, non-integral wire numbers, unsafe counters, and invalid UTF-8. */
export function parseStrictJSON(data: Uint8Array | string, limit: number): unknown {
  const bytes = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  check(bytes.length <= limit, "JSON exceeds its byte bound");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let cursor = 0;
  const whitespace = (): void => {
    while (/[\t\n\r ]/.test(source[cursor] ?? "!")) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    for (;;) {
      check(cursor < source.length, "unterminated JSON string");
      const char = source[cursor++];
      if (char === "\\") {
        cursor++;
        continue;
      }
      if (char === '"') break;
    }
    const value: unknown = JSON.parse(source.slice(start, cursor));
    text(value, limit);
    return value;
  };
  const value = (depth: number): unknown => {
    check(depth <= 64, "JSON nesting exceeds bound");
    whitespace();
    const first = source[cursor];
    if (first === '"') return string();
    if (first === "{") {
      cursor++;
      whitespace();
      const result: RecordValue = Object.create(null) as RecordValue;
      if (source[cursor] === "}") {
        cursor++;
        return result;
      }
      for (;;) {
        check(source[cursor] === '"', "JSON key must be a string");
        const key = string();
        whitespace();
        check(!Object.hasOwn(result, key), "duplicate JSON key");
        check(source[cursor++] === ":", "missing JSON colon");
        result[key] = value(depth + 1);
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === "}") return result;
        check(delimiter === ",", "invalid JSON object separator");
        whitespace();
      }
    }
    if (first === "[") {
      cursor++;
      whitespace();
      const result: unknown[] = [];
      if (source[cursor] === "]") {
        cursor++;
        return result;
      }
      for (;;) {
        result.push(value(depth + 1));
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === "]") return result;
        check(delimiter === ",", "invalid JSON array separator");
        whitespace();
      }
    }
    for (const [token, decoded] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (source.startsWith(token, cursor)) {
        cursor += token.length;
        return decoded;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(source.slice(cursor));
    check(match, "invalid JSON value");
    cursor += match[0].length;
    const number = Number(match[0]);
    check(
      Number.isSafeInteger(number) && !Object.is(number, -0),
      "unsafe or noncanonical JSON integer",
    );
    return number;
  };
  const result = value(0);
  whitespace();
  check(cursor === source.length, "trailing JSON data");
  return result;
}
