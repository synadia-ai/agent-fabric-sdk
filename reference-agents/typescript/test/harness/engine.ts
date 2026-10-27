// The durable engine for the durable tests: one `durable-engine serve` on the
// test's nats-server, standalone, in the test's one account, on the prefix
// `de`. The engine provisions its eight resources at start; the agent under
// test creates nothing and reaches it on `de.api.v1.*` alone.
//
// Adapted from the thin SDK's harness (`durable-sdk`
// `test/harness/engine-process.ts`, at `81df5ea`).
//
// The engine comes from Synadia, with a licence file:
//
//   the binary   `DE_ENGINE`, the path of the engine's executable
//   the licence  a standalone `serve` starts only with one; the engine reads
//                its file from `DE_LICENCE`
//
// Without `DE_ENGINE`, `engineUnavailable` says why and the durable suites
// skip. A `DE_ENGINE` that is not an executable fails the run.

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";

/** The engine's binary, or why there is none. */
function resolve(): { bin: string } | string {
  const given = process.env["DE_ENGINE"];
  if (given === undefined || given === "") {
    return "DE_ENGINE is not set: the path of the engine from Synadia (and DE_LICENCE, its licence file)";
  }
  let executable: boolean;
  try {
    accessSync(given, constants.X_OK);
    executable = statSync(given).isFile();
  } catch {
    executable = false;
  }
  if (!executable) throw new Error(`DE_ENGINE=${given}: not an executable file`);
  return { bin: given };
}

const resolved = resolve();

/** Why the durable suites skip, or `undefined` when the engine is there. */
export const engineUnavailable: string | undefined = typeof resolved === "string" ? resolved : undefined;
if (engineUnavailable !== undefined) console.warn(`durable suites skipped: ${engineUnavailable}`);

/** What a failed start adds to the engine's log: the licence it was not given. */
function hint(): string {
  const licence = process.env["DE_LICENCE"];
  return licence === undefined || licence === "" ? " (DE_LICENCE is not set)" : "";
}

export interface EngineOptions {
  /** `serve --ack-wait`: how long an item held by a worker that died waits before it redelivers. */
  readonly ackWaitMs?: number;
}

/** One `durable-engine serve` process, standalone, on the prefix `de`. */
export class TestEngine {
  readonly log: string[] = [];
  #proc: ChildProcess | undefined;

  private constructor() {}

  /**
   * Start an engine on `url` (a user of the test's account, its password in
   * the URL) and wait for its `serving` line: it has provisioned the eight.
   * Each is sized 256 MiB, so all of them fit a tenant's 4 GB of file storage.
   */
  static async start(url: string, options: EngineOptions = {}): Promise<TestEngine> {
    if (typeof resolved === "string") throw new Error(resolved);
    const engine = new TestEngine();
    const args = ["serve", "--nats", url, "--prefix", "de", "--stream-max-bytes", String(256 * 1024 * 1024)];
    if (options.ackWaitMs !== undefined) args.push("--ack-wait", `${options.ackWaitMs}ms`);
    const proc = spawn(resolved.bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    engine.#proc = proc;
    let buf = "";
    await new Promise<void>((resolveUp, reject) => {
      const t = setTimeout(() => reject(new Error(`durable-engine serve did not come up${hint()}:\n${engine.log.join("\n")}`)), 30_000);
      proc.stderr!.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          engine.log.push(line);
          if (process.env["DE_ENGINE_LOG"] === "1") console.error(`[engine] ${line}`);
          if (line.includes("msg=serving")) {
            clearTimeout(t);
            resolveUp();
          }
        }
      });
      proc.once("exit", (code) => {
        clearTimeout(t);
        reject(new Error(`durable-engine serve exited (${String(code)})${hint()}:\n${engine.log.join("\n")}`));
      });
    });
    return engine;
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    this.#proc = undefined;
    if (proc === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }
}
