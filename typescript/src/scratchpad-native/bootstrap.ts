import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { invalid, NativeScratchPadError } from "./errors";
import {
  check,
  parseStrictJSON,
  record,
  validateAction,
  validateAdmissionBinding,
  validatePrincipal,
  validateVolume,
  type Action,
  type AdmissionBinding,
  type Principal,
} from "./protocol";

/** The descriptor selects an exact creation request; it supplies no authority. */
export interface ScratchPadBootstrap {
  version: 1;
  principal: Principal;
  volume: string;
  admission: AdmissionBinding;
  creation: Action;
}

export const MAX_BOOTSTRAP_BYTES = 4096;

export function decodeScratchPadBootstrap(data: Uint8Array | string): ScratchPadBootstrap {
  const value = record(parseStrictJSON(data, MAX_BOOTSTRAP_BYTES), [
    "version",
    "principal",
    "volume",
    "admission",
    "creation",
  ]);
  check(value.version === 1, "unsupported ScratchPad bootstrap version");
  validatePrincipal(value.principal);
  validateVolume(value.volume);
  validateAdmissionBinding(value.admission);
  validateAction(value.creation);
  return value as unknown as ScratchPadBootstrap;
}

/** Read a bounded regular file without blocking on a FIFO or following a symlink. */
export function readScratchPadBootstrapFile(path: string): ScratchPadBootstrap {
  check(typeof path === "string" && path.length > 0, "bootstrap file path is required");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    check(stat.isFile(), "bootstrap must be a regular file");
    check(stat.size <= MAX_BOOTSTRAP_BYTES, "bootstrap exceeds its byte bound");
    const bytes = Buffer.alloc(MAX_BOOTSTRAP_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (read === 0) break;
      count += read;
    }
    return decodeScratchPadBootstrap(bytes.subarray(0, count));
  } catch (cause) {
    if (cause instanceof NativeScratchPadError) throw cause;
    throw invalid("cannot read ScratchPad bootstrap file", cause);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
