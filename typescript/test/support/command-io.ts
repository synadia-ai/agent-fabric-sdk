// A `CommandIO` for the command's tests: stdout and stderr collected, stdin
// a list of lines. Neither output is a terminal unless the test says so.

import type { CommandIO } from "../../src/command.js";

export interface RecordingIO extends CommandIO {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

export function recordingIO(
  env: Record<string, string | undefined> = {},
  stdin: ReadonlyArray<string> = [],
  terminal: { readonly out?: boolean; readonly err?: boolean } = {},
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
    outIsTerminal: terminal.out === true,
    errIsTerminal: terminal.err === true,
    stdout: () => out,
    stderr: () => err,
  };
}
