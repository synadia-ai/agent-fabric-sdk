// A `CommandIO` for the command's tests: stdout and stderr collected, stdin
// a list of lines.

import type { CommandIO } from "../../src/command.js";

export interface RecordingIO extends CommandIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function recordingIO(
  env: Record<string, string | undefined> = {},
  stdin: ReadonlyArray<string> = [],
): RecordingIO {
  let out = "";
  let err = "";
  const lines = [...stdin];
  return {
    out: (t) => {
      out += t;
    },
    err: (t) => {
      err += t;
    },
    readLine: () => Promise.resolve(lines.shift() ?? null),
    env,
    stdout: () => out,
    stderr: () => err,
  };
}
