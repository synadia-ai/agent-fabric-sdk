import type { Code } from "./protocol";

/** A failed request. `unknown` means a mutation may already have taken effect. */
export class NativeScratchPadError extends Error {
  readonly code: Code;
  readonly unknown: boolean;
  readonly local: boolean;

  constructor(
    code: Code,
    message: string,
    options: { unknown?: boolean; local?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NativeScratchPadError";
    this.code = code;
    this.unknown = options.unknown ?? false;
    this.local = options.local ?? false;
  }
}

export function invalid(message: string, cause?: unknown): NativeScratchPadError {
  return new NativeScratchPadError("invalid", message, { local: true, cause });
}

export function failed(mutation: boolean, message: string, cause?: unknown): NativeScratchPadError {
  return new NativeScratchPadError(mutation ? "unknown" : "corrupt", message, {
    unknown: mutation,
    cause,
  });
}
