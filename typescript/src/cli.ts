#!/usr/bin/env node
// The `agent-fabric` command's entry: the process's own stdin, stdout,
// stderr and environment around `runCommand`. No top-level await, so the
// CommonJS build runs too.

import { createInterface } from "node:readline";
import { runCommand, type CommandIO } from "./command.js";

function processIO(): CommandIO {
  let lines: AsyncIterator<string> | undefined;
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    async readLine() {
      lines ??= createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
      const next = await lines.next();
      return next.done === true ? null : next.value;
    },
    env: process.env,
  };
}

function main(): Promise<number> {
  return runCommand(process.argv.slice(2), processIO());
}

main().then(
  (code) => {
    process.exitCode = code;
    // stdin may still hold a reader open; nothing else is pending.
    process.stdin.destroy();
  },
  (err: unknown) => {
    process.stderr.write(`agent-fabric: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  },
);
