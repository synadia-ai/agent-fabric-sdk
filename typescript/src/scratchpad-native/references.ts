import { createHash } from "node:crypto";
import { validateReference, type Reference } from "./codec";
import * as p from "./protocol";

export const SHORT_REFERENCE_PREFIX = "sp-r1:";
export const SHORT_REFERENCE_BYTES = 66;
export const REFERENCE_PATHS = 8;
export const MAX_REFERENCE_INTENT_BYTES = 3072;
export const MAX_REFERENCE_METADATA_BYTES = 32768;

export interface ShortReference {
  route: string;
  creation_id: string;
  retention: p.RetentionHandle;
  path_index: number;
}
export interface ReferenceSpec {
  creator: string;
  paths: string[];
}
export interface ResolvedReference {
  short: string;
  expanded: Reference;
}
export interface ReferenceCapabilities {
  enabled: boolean;
  version: number;
  prefix: string;
  token_bytes: number;
  paths_per_retention: number;
  max_intent_bytes: number;
  max_metadata_bytes: number;
}
export interface ReferencePublishRequest extends p.PublishRequest {
  reference: ReferenceSpec;
}
export interface ReferencePublishResult {
  receipt: p.Receipt;
  references: ResolvedReference[];
}
export interface ReferenceResolveRequest {
  reference: string;
  trace: p.Trace;
}
export interface ReferenceStatResult {
  reference: ResolvedReference;
  stat: p.Stat;
}

/** Decode the locator only. The service verifies its metadata verifier. */
export function decodeShortReference(token: string): ShortReference {
  p.text(token, SHORT_REFERENCE_BYTES, SHORT_REFERENCE_BYTES);
  p.check(/^sp-r1:[A-Za-z0-9_-]{60}$/.test(token), "malformed short reference");
  const data = Buffer.from(token.slice(SHORT_REFERENCE_PREFIX.length), "base64url");
  p.check(data.length === 45 && data[32]! < 64, "invalid short reference slots");
  const generation = Number(data.readBigUInt64BE(24));
  p.uint(generation, undefined, 1);
  const result = {
    route: data.subarray(0, 8).toString("hex"),
    creation_id: data.subarray(8, 24).toString("hex"),
    retention: { slot: data[32]! >> 3, generation },
    path_index: data[32]! & 7,
  };
  p.validateTarget({ volume: "Reference", creation_id: result.creation_id });
  return result;
}

export function referenceRoute(account: string, volume: string): string {
  return createHash("sha256")
    .update(`scratchpad-reference-volume-v1\0${account}\0${volume}`)
    .digest()
    .subarray(0, 8)
    .toString("hex");
}

export function validateReferenceSpec(value: unknown): asserts value is ReferenceSpec {
  const v = p.record(value, ["creator", "paths"]);
  p.text(v.creator, 512, 1);
  p.check(
    Array.isArray(v.paths) && v.paths.length > 0 && v.paths.length <= REFERENCE_PATHS,
    "reference paths exceed bound",
  );
  let previous = "";
  for (const path of v.paths) {
    p.validatePath(path, 256);
    p.check(
      Buffer.compare(Buffer.from(previous), Buffer.from(path)) < 0,
      "reference paths must be distinct and sorted",
    );
    previous = path;
  }
  p.check(
    Buffer.byteLength(p.goJSON({ creator: v.creator, paths: v.paths })) <=
      MAX_REFERENCE_INTENT_BYTES,
    "reference intent exceeds byte bound",
  );
}

export function validateResolvedReference(value: unknown): asserts value is ResolvedReference {
  const v = p.record(value, ["short", "expanded"]);
  p.text(v.short, SHORT_REFERENCE_BYTES, SHORT_REFERENCE_BYTES);
  const locator = decodeShortReference(v.short);
  validateReference(v.expanded);
  p.check(
    locator.route === referenceRoute(v.expanded.account, v.expanded.target.volume) &&
      locator.creation_id === v.expanded.target.creation_id &&
      p.sameValue(locator.retention, v.expanded.retention),
    "short reference binding differs",
  );
}

export function validateReferenceCapabilities(
  value: unknown,
): asserts value is ReferenceCapabilities {
  const v = p.record(value, [
    "enabled",
    "version",
    "prefix",
    "token_bytes",
    "paths_per_retention",
    "max_intent_bytes",
    "max_metadata_bytes",
  ]);
  p.check(
    typeof v.enabled === "boolean" &&
      v.version === 1 &&
      v.prefix === SHORT_REFERENCE_PREFIX &&
      v.token_bytes === SHORT_REFERENCE_BYTES &&
      v.paths_per_retention === REFERENCE_PATHS &&
      v.max_intent_bytes === MAX_REFERENCE_INTENT_BYTES &&
      v.max_metadata_bytes === MAX_REFERENCE_METADATA_BYTES,
    "unsupported reference capability",
  );
}

export function validateReferencePublishRequest(
  value: unknown,
): asserts value is ReferencePublishRequest {
  const v = p.record(value, ["target", "command", "reference"]);
  p.validateTarget(v.target);
  p.validateCommand(v.command);
  p.check(
    v.target.creation_id === v.command.creation_id &&
      v.command.retention.enabled &&
      v.command.retention.until > 0,
    "referenced publication requires finite retention and matching target",
  );
  validateReferenceSpec(v.reference);
}

export function validateReferencePublishResult(
  value: unknown,
): asserts value is ReferencePublishResult {
  const v = p.record(value, ["receipt", "references"]);
  p.validateReceipt(v.receipt);
  p.check(
    v.receipt.command.retention.enabled &&
      Array.isArray(v.references) &&
      v.references.length > 0 &&
      v.references.length <= REFERENCE_PATHS,
    "invalid referenced receipt",
  );
  let previous = "",
    creator: string | undefined;
  for (const [index, pair] of v.references.entries()) {
    validateResolvedReference(pair);
    const ref = pair.expanded;
    creator ??= ref.creator;
    p.check(
      decodeShortReference(pair.short).path_index === index &&
        ref.creator === creator &&
        Buffer.compare(Buffer.from(previous), Buffer.from(ref.path)) < 0 &&
        ref.account === v.receipt.principal.account &&
        ref.target.volume === v.receipt.volume &&
        ref.target.creation_id === v.receipt.command.creation_id &&
        ref.root === v.receipt.head.root &&
        ref.generation === v.receipt.head.generation &&
        p.sameValue(ref.retention, v.receipt.retention) &&
        ref.expires_at === v.receipt.command.retention.until,
      "reference differs from receipt",
    );
    previous = ref.path;
  }
}

export function validateReferenceStatResult(value: unknown): asserts value is ReferenceStatResult {
  const v = p.record(value, ["reference", "stat"]);
  validateResolvedReference(v.reference);
  p.validateStat(v.stat);
}

export interface ReferenceRetainRequest {
  retain: p.RetainRequest;
  reference: ReferenceSpec;
}
export interface ReferenceRetainResult {
  volume: p.VolumeView;
  references: ResolvedReference[];
}
export function validateReferenceRetainRequest(
  value: unknown,
): asserts value is ReferenceRetainRequest {
  const v = p.record(value, ["retain", "reference"]);
  const retain = p.record(v.retain, ["target", "slot", "generation", "root", "until", "action"]);
  p.validateTarget(retain.target);
  p.uint(retain.slot, p.RETENTION_SLOTS - 1);
  p.uint(retain.generation);
  p.validateContentID(retain.root);
  p.uint(retain.until, undefined, 1);
  p.validateAction(retain.action);
  validateReferenceSpec(v.reference);
}
export function validateReferenceRetainResult(
  value: unknown,
): asserts value is ReferenceRetainResult {
  const v = p.record(value, ["volume", "references"]);
  p.validateVolumeView(v.volume);
  p.check(
    Array.isArray(v.references) &&
      v.references.length > 0 &&
      v.references.length <= REFERENCE_PATHS,
    "invalid retained references",
  );
  let first: Reference | undefined,
    previous = "";
  for (const [index, pair] of v.references.entries()) {
    validateResolvedReference(pair);
    const ref = pair.expanded;
    first ??= ref;
    const retained = v.volume.retentions[ref.retention.slot]!;
    p.check(
      decodeShortReference(pair.short).path_index === index &&
        Buffer.compare(Buffer.from(previous), Buffer.from(ref.path)) < 0 &&
        ref.creator === first.creator &&
        ref.root === first.root &&
        ref.generation === first.generation &&
        p.sameValue(ref.retention, first.retention) &&
        ref.expires_at === first.expires_at &&
        p.sameValue(ref.target, v.volume.target) &&
        ref.account === v.volume.owner.account &&
        retained.generation === ref.retention.generation &&
        retained.pin?.root === ref.root &&
        retained.pin.until === ref.expires_at,
      "reference differs from retained root",
    );
    previous = ref.path;
  }
}
