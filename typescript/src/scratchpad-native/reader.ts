import { createHash } from "node:crypto";
import type { NatsConnection } from "@nats-io/nats-core";
import type { TraceIds } from "../scratchpad";
import { chunkID, decodeReference, encodeFileObject, fileObjectID } from "./codec";
import type { ChunkRef, Reference } from "./codec";
import { NativeScratchPadError } from "./errors";
import { check, CHUNK_SIZE, MAX_VOLUME_BYTES, sameValue, uint, validateTrace } from "./protocol";
import type { PathRequest, Principal, Stat, Trace } from "./protocol";
import { ScratchPadTransport } from "./transport";
import { SHORT_REFERENCE_PREFIX, decodeShortReference, type ResolvedReference } from "./references";

export const DEFAULT_READ_LIMIT_BYTES = 16 * 1024 * 1024;
export interface ScratchPadReaderOptions {
  nc: NatsConnection;
  timeoutMs?: number;
}
export interface ReadBytesOptions {
  limitBytes?: number;
  trace?: TraceIds;
}

export function wireTrace(trace?: TraceIds, toolCallId?: string): Trace {
  const result: Trace = trace ? { thread_id: trace.threadId, root_id: trace.rootId } : {};
  if (toolCallId) result.tool_call_id = toolCallId;
  validateTrace(result);
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== ""));
}

/** Authenticated reads through a borrowed NATS connection; no workspace needed. */
export class ScratchPadReader {
  private readonly expansions = new Map<string, Reference>();
  constructor(
    protected readonly transport: ScratchPadTransport,
    readonly principal: Principal,
  ) {}

  protected reference(token: string): Reference {
    return this.checkedReference(decodeReference(token));
  }

  protected checkedReference(reference: Reference): Reference {
    if (reference.account !== this.principal.account)
      throw new NativeScratchPadError("denied", "reference belongs to another account", {
        local: true,
      });
    this.checkDeadline(reference.expires_at);
    return reference;
  }

  private checkDeadline(expiresAt: number): void {
    if (Date.now() >= expiresAt * 1000)
      throw new NativeScratchPadError("expired", "reference has expired", { local: true });
  }

  protected cacheReference(pair: ResolvedReference): void {
    this.expansions.delete(pair.short);
    this.expansions.set(pair.short, structuredClone(pair.expanded));
    if (this.expansions.size > 64) this.expansions.delete(this.expansions.keys().next().value!);
  }

  /** Expand either form for programmatic use. Metadata supplies no read authority. */
  async resolveReference(token: string, trace?: TraceIds): Promise<Reference> {
    if (!token.startsWith(SHORT_REFERENCE_PREFIX)) return this.reference(token);
    decodeShortReference(token);
    const cached = this.expansions.get(token);
    if (cached) return this.checkedReference(structuredClone(cached));
    const pair = await this.transport.referenceResolve({
      reference: token,
      trace: wireTrace(trace),
    });
    this.checkedReference(pair.expanded);
    this.cacheReference(pair);
    return structuredClone(pair.expanded);
  }

  private async openFile(
    token: string,
    options: ReadBytesOptions,
  ): Promise<{ request: PathRequest; stat: Stat; expiresAt: number }> {
    const limit = options.limitBytes ?? DEFAULT_READ_LIMIT_BYTES;
    uint(limit, MAX_VOLUME_BYTES);
    // A cached descriptor never skips current authorization or token validity.
    const resolved = token.startsWith(SHORT_REFERENCE_PREFIX)
      ? await this.transport.referenceStat({ reference: token, trace: wireTrace(options.trace) })
      : undefined;
    const reference = resolved
      ? this.checkedReference(resolved.reference.expanded)
      : this.reference(token);
    if (resolved) this.cacheReference(resolved.reference);
    const request = {
      target: reference.target,
      root: reference.root,
      path: reference.path,
      trace: wireTrace(options.trace),
    };
    const stat = resolved?.stat ?? (await this.transport.stat(request));
    this.checkDeadline(reference.expires_at);
    check(stat.type === "file", "reference does not name a file");
    if (stat.size > limit)
      throw new NativeScratchPadError(
        "capacity",
        `file has ${stat.size} bytes; read limit is ${limit}`,
        { local: true },
      );
    return { request, stat, expiresAt: reference.expires_at };
  }

  private async *chunks(
    request: PathRequest,
    stat: Stat,
    expiresAt: number,
  ): AsyncGenerator<Uint8Array> {
    this.checkDeadline(expiresAt);
    const chunks: ChunkRef[] = [],
      digest = createHash("sha256");
    for (let offset = 0; offset < stat.size; offset += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, stat.size - offset);
      this.checkDeadline(expiresAt);
      const result = await this.transport.read({ ...request, offset, length });
      this.checkDeadline(expiresAt);
      if (
        !sameValue(stat, result.stat) ||
        result.offset !== offset ||
        result.data.length !== length
      ) {
        throw new NativeScratchPadError("corrupt", "read range differs from the immutable file");
      }
      digest.update(result.data);
      chunks.push({ id: chunkID(result.data), length });
      yield result.data;
      this.checkDeadline(expiresAt);
    }
    const sha256 = digest.digest("hex");
    const object = fileObjectID(encodeFileObject({ size: stat.size, digest: sha256, chunks }));
    this.checkDeadline(expiresAt);
    if (sha256 !== stat.sha256 || object !== stat.object)
      throw new NativeScratchPadError("corrupt", "file bytes differ from their digest or identity");
  }

  /** Returns bytes only after size, logical digest and canonical file identity agree. */
  async readBytes(token: string, options: ReadBytesOptions = {}): Promise<Uint8Array> {
    const { request, stat, expiresAt } = await this.openFile(token, options);
    const output = new Uint8Array(stat.size);
    let offset = 0;
    for await (const bytes of this.chunks(request, stat, expiresAt)) {
      output.set(bytes, offset);
      offset += bytes.length;
    }
    this.checkDeadline(expiresAt);
    return output;
  }

  /** Bytes are provisional until iteration completes without error. Consume to EOF
   * and publish a downloaded file only after success; early cancellation is unverified.
   * The caller must set an explicit whole-file size allowance.
   */
  async *readStream(
    token: string,
    options: ReadBytesOptions & { limitBytes: number },
  ): AsyncGenerator<Uint8Array> {
    uint(options?.limitBytes, MAX_VOLUME_BYTES);
    const { request, stat, expiresAt } = await this.openFile(token, options);
    yield* this.chunks(request, stat, expiresAt);
    this.checkDeadline(expiresAt);
  }

  async read(reference: string, trace?: TraceIds): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      await this.readBytes(reference, trace ? { trace } : {}),
    );
  }
}

export async function scratchPadReader(
  options: ScratchPadReaderOptions,
): Promise<ScratchPadReader> {
  const transport = new ScratchPadTransport(options.nc, options);
  const info = await transport.info();
  return new ScratchPadReader(transport, info.principal);
}
