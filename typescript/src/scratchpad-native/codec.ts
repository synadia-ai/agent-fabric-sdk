import { createHash } from "node:crypto";
import {
  CHUNK_SIZE,
  MAX_CHUNKS,
  MAX_DEPTH,
  MAX_NODE_BYTES,
  MAX_TREE_ENTRIES,
  ZERO_CONTENT_ID,
  check,
  goJSON,
  parseStrictJSON,
  record,
  text,
  uint,
  validateContentID,
  validateName,
  validatePath,
  validatePublicKey,
  validateRetentionHandle,
  validateTarget,
} from "./protocol";
import type { ContentObject, RetentionHandle, Target } from "./protocol";
export {
  CHUNK_SIZE,
  MAX_CHUNKS,
  MAX_DEPTH,
  MAX_NODE_BYTES,
  MAX_TREE_ENTRIES,
  ZERO_CONTENT_ID,
} from "./protocol";

export interface ChunkRef {
  id: string;
  length: number;
}
export interface FileObject {
  size: number;
  digest: string;
  chunks: ChunkRef[];
}
export interface TreeEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  object?: string;
  executable?: boolean;
  linkTarget?: string;
}
export interface Reference {
  version: 2;
  creator: string;
  account: string;
  target: Target;
  root: string;
  generation: number;
  path: string;
  retention: RetentionHandle;
  expires_at: number;
}
export class CodecError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "CodecError";
  }
}
function reject(reason: string, message: string): never {
  throw new CodecError(reason, message);
}
function hash(tag: string, data: Uint8Array): string {
  return createHash("sha256").update(tag).update("\0").update(data).digest("base64url");
}
export function chunkID(data: Uint8Array): string {
  return hash("scratchpad:v1:chunk", data);
}
export function fileObjectID(data: Uint8Array): string {
  return hash("scratchpad:v1:file", data);
}
export function treeNodeID(data: Uint8Array): string {
  return hash("scratchpad:v1:tree", data);
}

/** Memory is one 512 KiB chunk plus at most MAX_CHUNKS metadata entries.
 * The callback must consume or copy its bytes before it returns.
 */
export async function chunkStream(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  emit: (index: number, object: ContentObject, data: Uint8Array) => Promise<void> | void,
): Promise<FileObject> {
  const file: FileObject = { size: 0, digest: "", chunks: [] };
  const digest = createHash("sha256"),
    buffer = Buffer.alloc(CHUNK_SIZE);
  let used = 0;
  const flush = async (): Promise<void> => {
    if (file.chunks.length >= MAX_CHUNKS) reject("chunk-shape", "file exceeds chunk count bound");
    const bytes = buffer.subarray(0, used),
      id = chunkID(bytes);
    digest.update(bytes);
    file.size += used;
    file.chunks.push({ id, length: used });
    await emit(file.chunks.length - 1, { kind: "chnk", id }, bytes);
    used = 0;
  };
  for await (const part of source) {
    check(part instanceof Uint8Array, "stream must yield bytes");
    let offset = 0;
    while (offset < part.length) {
      const length = Math.min(CHUNK_SIZE - used, part.length - offset);
      buffer.set(part.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === CHUNK_SIZE) await flush();
    }
  }
  if (used !== 0) await flush();
  file.digest = digest.digest("hex");
  return file;
}

// This restricted CBOR subset contains only unsigned integers, bytes, text,
// arrays, and string-keyed maps. No generic serializer can add tagged values.
function head(major: number, value: number): Buffer {
  uint(value);
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value <= 255) return Buffer.from([(major << 5) | 24, value]);
  if (value <= 65535) {
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(value, 1);
    return bytes;
  }
  if (value <= 0xffffffff) {
    const bytes = Buffer.alloc(5);
    bytes[0] = (major << 5) | 26;
    bytes.writeUInt32BE(value, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(9);
  bytes[0] = (major << 5) | 27;
  bytes.writeBigUInt64BE(BigInt(value), 1);
  return bytes;
}
function byteString(bytes: Uint8Array): Buffer {
  return Buffer.concat([head(2, bytes.length), bytes]);
}
function textString(value: string): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([head(3, bytes.length), bytes]);
}
function validateFile(file: FileObject): void {
  uint(file.size);
  check(
    typeof file.digest === "string" && /^[0-9a-f]{64}$/.test(file.digest),
    "invalid logical file digest",
  );
  if (!Array.isArray(file.chunks) || file.chunks.length > MAX_CHUNKS)
    reject("chunk-shape", "chunk count exceeds bound");
  let total = 0;
  for (const [index, chunk] of file.chunks.entries()) {
    validateContentID(chunk.id);
    uint(chunk.length);
    if (
      chunk.length === 0 ||
      chunk.length > CHUNK_SIZE ||
      (index !== file.chunks.length - 1 && chunk.length !== CHUNK_SIZE)
    )
      reject("chunk-shape", "invalid fixed chunk length");
    total += chunk.length;
  }
  if (total !== file.size) reject("chunk-shape", "chunk lengths differ from file size");
}
export function encodeFileObject(file: FileObject): Uint8Array {
  validateFile(file);
  const parts = [head(5, 3), textString("c"), head(4, file.chunks.length)];
  for (const chunk of file.chunks)
    parts.push(head(4, 2), byteString(Buffer.from(chunk.id, "base64url")), head(0, chunk.length));
  parts.push(
    textString("d"),
    byteString(Buffer.from(file.digest, "hex")),
    textString("s"),
    head(0, file.size),
  );
  return Buffer.concat(parts);
}
function entryName(name: string): void {
  if (typeof name !== "string" || Buffer.from(name).toString("utf8") !== name)
    reject("utf8", "invalid entry name UTF-8");
  if (Buffer.byteLength(name) === 0 || Buffer.byteLength(name) > 255)
    reject("name-length", "entry name length exceeds bound");
  if (name === "." || name === ".." || /[\x00-\x1f\x7f/]/.test(name))
    reject("name-forbidden", "forbidden entry name");
  try {
    validateName(name);
  } catch {
    reject("not-nfc", "entry name is not NFC");
  }
}
function validateEntry(entry: TreeEntry): void {
  entryName(entry.name);
  if (entry.type === "symlink") {
    if (entry.executable || (entry.object !== undefined && entry.object !== ZERO_CONTENT_ID))
      reject("type-invalid", "symlink has file fields");
    const target = entry.linkTarget ?? "";
    if (typeof target !== "string" || Buffer.from(target).toString("utf8") !== target)
      reject("utf8", "invalid symlink UTF-8");
    if (
      Buffer.byteLength(target) === 0 ||
      Buffer.byteLength(target) > 4096 ||
      target.includes("\0")
    )
      reject("target-invalid", "invalid symlink target");
  } else {
    if (entry.type !== "file" && entry.type !== "directory")
      reject("type-invalid", "unknown entry type");
    validateContentID(entry.object);
    if (entry.linkTarget || (entry.type === "directory" && entry.executable))
      reject("type-invalid", "entry has fields of another type");
  }
}
export function encodeTreeNode(entries: readonly TreeEntry[]): Uint8Array {
  for (const entry of entries) validateEntry(entry);
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
  );
  for (let index = 1; index < sorted.length; index++)
    if (sorted[index]!.name === sorted[index - 1]!.name)
      reject("duplicate-name", "duplicate tree entry");
  if (entries.length > MAX_TREE_ENTRIES) reject("entry-count", "tree entry count exceeds bound");
  const parts = [head(5, 1), textString("e"), head(4, entries.length)];
  let length = parts.reduce((sum, part) => sum + part.length, 0);
  for (const entry of sorted) {
    const fields = [head(5, entry.executable ? 4 : 3)];
    if (entry.type === "symlink") fields.push(textString("l"), textString(entry.linkTarget!));
    else fields.push(textString("i"), byteString(Buffer.from(entry.object!, "base64url")));
    fields.push(
      textString("n"),
      textString(entry.name),
      textString("t"),
      head(0, entry.type === "file" ? 0 : entry.type === "directory" ? 1 : 2),
    );
    if (entry.executable) fields.push(textString("x"), head(0, 1));
    length += fields.reduce((sum, part) => sum + part.length, 0);
    if (length > MAX_NODE_BYTES) reject("node-size", "tree node byte count exceeds bound");
    parts.push(...fields);
  }
  return Buffer.concat(parts);
}
export const EMPTY_ROOT = treeNodeID(encodeTreeNode([]));
export interface Directory {
  entries: (TreeEntry & { child?: Directory })[];
}
/** Assemble an explicitly bounded logical directory; streaming file bytes stay separate. */
export function encodeDirectory(directory: Directory): {
  root: string;
  nodes: Map<string, Uint8Array>;
} {
  const nodes = new Map<string, Uint8Array>();
  const walk = (dir: Directory, depth: number): string => {
    if (depth > MAX_DEPTH) reject("depth", "directory exceeds depth bound");
    const entries = dir.entries.map((entry): TreeEntry => {
      if (entry.type !== "directory") return entry;
      if (!entry.child) reject("type-invalid", "directory entry has no child");
      return { ...entry, object: walk(entry.child, depth + 1) };
    });
    const data = encodeTreeNode(entries),
      id = treeNodeID(data);
    nodes.set(id, data);
    return id;
  };
  return { root: walk(directory, 1), nodes };
}

type CBOR = number | string | Uint8Array | CBOR[] | Map<string, CBOR>;
function decodeCBOR(data: Uint8Array): CBOR {
  let cursor = 0;
  const take = (length: number): Buffer => {
    if (!Number.isSafeInteger(length) || length > data.length - cursor)
      reject("type-mismatch", "truncated CBOR");
    const bytes = Buffer.from(data.buffer, data.byteOffset + cursor, length);
    cursor += length;
    return bytes;
  };
  const item = (depth: number): CBOR => {
    if (depth > 8) reject("type-mismatch", "CBOR nesting exceeds object shape");
    const first = take(1)[0]!,
      major = first >>> 5,
      additional = first & 31;
    if (additional === 31) reject("indefinite-length", "indefinite CBOR length");
    if (![0, 2, 3, 4, 5].includes(major)) reject("forbidden-item", "forbidden CBOR item");
    let value = additional;
    if (additional >= 24) {
      if (additional > 27) reject("forbidden-item", "reserved CBOR length");
      const bytes = take(2 ** (additional - 24));
      const large =
        additional === 27 ? bytes.readBigUInt64BE() : BigInt(bytes.readUIntBE(0, bytes.length));
      const minimum = [24n, 256n, 65536n, 4294967296n][additional - 24]!;
      if (large < minimum) reject("non-shortest", "CBOR integer is not shortest");
      if (large > BigInt(Number.MAX_SAFE_INTEGER))
        reject("type-mismatch", "CBOR integer exceeds exact range");
      value = Number(large);
    }
    if (major === 0) return value;
    if (major === 2) return take(value);
    if (major === 3) {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(take(value));
      } catch {
        return reject("utf8", "CBOR text is not UTF-8");
      }
    }
    // Each item needs at least one input byte; bound allocation before looping.
    if (value > data.length - cursor) reject("type-mismatch", "CBOR item count exceeds input");
    if (major === 4) {
      const values: CBOR[] = [];
      for (let index = 0; index < value; index++) values.push(item(depth + 1));
      return values;
    }
    const result = new Map<string, CBOR>();
    let last: Buffer | undefined;
    for (let index = 0; index < value; index++) {
      const start = cursor;
      let key: CBOR;
      try {
        key = item(depth + 1);
      } catch (error) {
        if (error instanceof CodecError && error.reason === "utf8")
          reject("key-unknown", "invalid UTF-8 map key cannot be a schema key");
        throw error;
      }
      const encoded = Buffer.from(data.subarray(start, cursor));
      if (typeof key !== "string") reject("type-mismatch", "CBOR map key must be text");
      if (last && Buffer.compare(last, encoded) >= 0)
        reject("key-order", "CBOR keys are not strictly ordered");
      last = encoded;
      result.set(key, item(depth + 1));
    }
    return result;
  };
  const result = item(0);
  if (cursor !== data.length) reject("trailing-bytes", "trailing CBOR bytes");
  return result;
}
function map(value: CBOR, keys: string[]): Map<string, CBOR> {
  if (!(value instanceof Map)) reject("type-mismatch", "expected CBOR map");
  for (const key of value.keys())
    if (!keys.includes(key)) reject("key-unknown", "unknown object key");
  for (const key of keys) if (!value.has(key)) reject("key-missing", "missing object key");
  return value;
}
function bytes32(value: CBOR | undefined): Buffer {
  if (!(value instanceof Uint8Array) || value.length !== 32)
    reject("type-mismatch", "expected 32-byte digest");
  return Buffer.from(value);
}
function integer(value: CBOR | undefined): number {
  if (typeof value !== "number") reject("type-mismatch", "expected unsigned integer");
  return value;
}
export function decodeFileObject(data: Uint8Array): FileObject {
  const fields = map(decodeCBOR(data), ["c", "d", "s"]),
    refs = fields.get("c");
  if (!Array.isArray(refs)) reject("type-mismatch", "chunks must be array");
  const file: FileObject = {
    size: integer(fields.get("s")),
    digest: bytes32(fields.get("d")).toString("hex"),
    chunks: [],
  };
  for (const ref of refs) {
    if (!Array.isArray(ref) || ref.length !== 2)
      reject("type-mismatch", "chunk reference must have two fields");
    file.chunks.push({ id: bytes32(ref[0]).toString("base64url"), length: integer(ref[1]) });
  }
  validateFile(file);
  return file;
}
export function decodeTreeNode(data: Uint8Array): TreeEntry[] {
  if (data.length > MAX_NODE_BYTES) reject("node-size", "tree node exceeds byte bound");
  const fields = map(decodeCBOR(data), ["e"]),
    raw = fields.get("e");
  if (!Array.isArray(raw)) reject("type-mismatch", "entries must be an array");
  if (raw.length > MAX_TREE_ENTRIES) reject("entry-count", "tree entry count exceeds bound");
  const entries: TreeEntry[] = [];
  let previous: string | undefined;
  for (const item of raw) {
    if (!(item instanceof Map)) reject("type-mismatch", "entry must be a map");
    for (const key of item.keys())
      if (!["i", "l", "n", "t", "x"].includes(key)) reject("key-unknown", "unknown entry key");
    if (!item.has("n") || !item.has("t")) reject("key-missing", "missing entry name or type");
    const name = item.get("n"),
      type = integer(item.get("t"));
    if (typeof name !== "string") reject("type-mismatch", "entry name must be text");
    if (type > 2) reject("type-invalid", "unknown entry type");
    if (!item.has(type === 2 ? "l" : "i")) reject("key-missing", "missing entry target");
    if (item.has(type === 2 ? "i" : "l")) reject("type-invalid", "entry has other target type");
    if (item.has("x") && integer(item.get("x")) !== 1)
      reject("type-invalid", "executable flag must be one");
    const entry: TreeEntry = {
      name,
      type: type === 0 ? "file" : type === 1 ? "directory" : "symlink",
    };
    if (item.has("x")) entry.executable = true;
    if (type === 2) {
      const target = item.get("l");
      if (typeof target !== "string") reject("type-mismatch", "symlink target must be text");
      entry.linkTarget = target;
    } else entry.object = bytes32(item.get("i")).toString("base64url");
    validateEntry(entry);
    if (previous !== undefined) {
      const order = Buffer.compare(Buffer.from(previous), Buffer.from(name));
      if (order === 0) reject("duplicate-name", "duplicate tree entry");
      if (order > 0) reject("entry-order", "entries are not sorted");
    }
    previous = name;
    entries.push(entry);
  }
  return entries;
}
export function verifyObject(object: ContentObject, data: Uint8Array): void {
  validateContentID(object.id);
  if (object.kind === "chnk") {
    if (data.length === 0 || data.length > CHUNK_SIZE)
      reject("chunk-shape", "chunk length outside bound");
    if (chunkID(data) !== object.id) reject("id-mismatch", "chunk identity differs");
  } else if (object.kind === "fobj") {
    const file = decodeFileObject(data);
    if (!Buffer.from(encodeFileObject(file)).equals(data))
      reject("type-invalid", "file bytes are not canonical");
    if (fileObjectID(data) !== object.id) reject("id-mismatch", "file identity differs");
  } else if (object.kind === "tree") {
    const entries = decodeTreeNode(data);
    if (!Buffer.from(encodeTreeNode(entries)).equals(data))
      reject("type-invalid", "tree bytes are not canonical");
    if (treeNodeID(data) !== object.id) reject("id-mismatch", "tree identity differs");
  } else reject("type-invalid", "unsupported object kind");
}
export function validateReference(value: unknown): asserts value is Reference {
  const v = record(value, [
    "version",
    "creator",
    "account",
    "target",
    "root",
    "generation",
    "path",
    "retention",
    "expires_at",
  ]);
  check(v.version === 2, "reference version must be two");
  text(v.creator, 512, 1);
  validatePublicKey(v.account, "account");
  validateTarget(v.target);
  validateContentID(v.root);
  uint(v.generation, undefined, 1);
  validatePath(v.path, 256);
  validateRetentionHandle(v.retention);
  uint(v.expires_at, undefined, 1);
}
export function encodeReference(reference: Reference): string {
  validateReference(reference);
  const ordered: Reference = {
    version: 2,
    creator: reference.creator,
    account: reference.account,
    target: { volume: reference.target.volume, creation_id: reference.target.creation_id },
    root: reference.root,
    generation: reference.generation,
    path: reference.path,
    retention: { slot: reference.retention.slot, generation: reference.retention.generation },
    expires_at: reference.expires_at,
  };
  const token = "sp-ref:" + Buffer.from(goJSON(ordered, false)).toString("base64url");
  check(Buffer.byteLength(token) <= 16 * 1024, "reference exceeds byte bound");
  return token;
}
export function decodeReference(token: string): Reference {
  text(token, 16 * 1024);
  check(token.startsWith("sp-ref:"), "reference prefix is absent");
  const encoded = token.slice(7);
  check(/^[A-Za-z0-9_-]+$/.test(encoded), "reference is not unpadded base64url");
  const data = Buffer.from(encoded, "base64url");
  check(data.toString("base64url") === encoded, "reference base64url has stray bits");
  const reference = parseStrictJSON(data, 16 * 1024);
  validateReference(reference);
  check(encodeReference(reference) === token, "reference JSON is not canonical");
  return reference;
}
