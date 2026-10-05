// The durable engine for the durable tests: one `durable-engine serve` on the
// test's nats-server, standalone, in the test's one account, on the prefix
// `de`. The engine provisions its seven resources at start; the agent under
// test creates nothing and reaches it on `de.api.v1.*` alone.
//
// Adapted from the thin SDK's harness (`../durable-sdk`
// `test/harness/engine-bin.ts` and `engine-process.ts`, at `81df5ea`):
//
//   the binary   `DE_ENGINE` (a path), or built with `go build -tags
//                devlicence` from the engine checkout (`DE_ENGINE_REPO`,
//                default `../durable-engine` next to this repo) at the commit
//                the SDK's `engine.pin` names, into `reference-agents/.engine-bin/`;
//                a checkout at another commit or with local changes is
//                refused unless `DE_ENGINE_ANY=1`. Nothing is written in the
//                checkout.
//   the licence  a standalone `serve` starts only with one: `DE_LICENCE`, or
//                a test licence minted once per process by the
//                `durable-licence` built beside the engine (`mint -test`), or
//                `DE_LICENCE_TOOL`.
//
// Without the binary and without Go to build it, `engineUnavailable` says
// why and the durable suites skip.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const AGENTS = join(import.meta.dirname, "..", "..", "..");
const SDK = process.env["DE_SDK_REPO"] ?? join(AGENTS, "..", "..", "durable-sdk");

/** The commit the thin SDK's `engine.pin` names. */
export function enginePin(): string {
  return readFileSync(join(SDK, "engine.pin"), "utf8").trim();
}

function onPath(name: string): boolean {
  return (process.env["PATH"] ?? "").split(":").some((dir) => {
    if (dir === "") return false;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The engine and its licence tool, or why they cannot be had (a wrong checkout throws: it must not skip silently). */
function resolve(): { bin: string; tool: string | undefined } | string {
  const given = process.env["DE_ENGINE"];
  if (given !== undefined && given !== "") {
    accessSync(given, constants.X_OK);
    const beside = join(dirname(given), "durable-licence");
    return { bin: given, tool: existsSync(beside) ? beside : undefined };
  }
  const src = process.env["DE_ENGINE_REPO"] ?? join(AGENTS, "..", "..", "durable-engine");
  if (!existsSync(join(src, "go.mod"))) return `no DE_ENGINE and no engine checkout at ${src} (DE_ENGINE_REPO)`;
  if (!existsSync(join(SDK, "engine.pin"))) return `no thin SDK at ${SDK} for its engine.pin (DE_SDK_REPO)`;
  if (!onPath("go")) return `no DE_ENGINE, and Go is not on PATH to build ${src}`;
  const pin = enginePin();
  const git = (...args: string[]): string => execFileSync("git", ["-C", src, ...args], { encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const any = process.env["DE_ENGINE_ANY"] === "1";
  if (!head.startsWith(pin) && !any) {
    throw new Error(
      `the engine checkout ${src} is at ${head.slice(0, 7)}, the SDK's engine.pin names ${pin}: ` +
        `check out ${pin} there, point DE_ENGINE at a binary, or set DE_ENGINE_ANY=1`,
    );
  }
  const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
  if (dirty && !any) throw new Error(`the engine checkout ${src} has local changes (DE_ENGINE_ANY=1 to run it anyway)`);
  const out = join(AGENTS, ".engine-bin");
  mkdirSync(out, { recursive: true });
  const tag = `${head.slice(0, 12)}${dirty ? "-dirty" : ""}`;
  const bin = join(out, `durable-engine-dev-${tag}`);
  const tool = join(out, `durable-licence-${tag}`);
  if (!existsSync(bin) || !existsSync(tool) || dirty) {
    execFileSync("go", ["build", "-tags", "devlicence", "-o", bin, "./cmd/durable-engine"], { cwd: src, stdio: "inherit" });
    execFileSync("go", ["build", "-o", tool, "./cmd/durable-licence"], { cwd: src, stdio: "inherit" });
  }
  return { bin, tool };
}

const resolved = resolve();

/** Why the durable suites skip, or `undefined` when the engine is there. */
export const engineUnavailable: string | undefined = typeof resolved === "string" ? resolved : undefined;
if (engineUnavailable !== undefined) console.warn(`durable suites skipped: ${engineUnavailable}`);

let licence: string | undefined;

/** The licence the engines of this process start with: `DE_LICENCE`, or one test licence minted once. */
function runLicence(): string {
  const given = process.env["DE_LICENCE"];
  if (given !== undefined && given !== "") return given;
  if (licence !== undefined) return licence;
  if (typeof resolved === "string") throw new Error(resolved);
  const tool = process.env["DE_LICENCE_TOOL"] || resolved.tool;
  if (tool === undefined) {
    throw new Error(`no durable-licence beside ${resolved.bin}: set DE_LICENCE to a licence or DE_LICENCE_TOOL to the tool`);
  }
  const file = join(mkdtempSync(join(tmpdir(), "fabric-de-licence-")), "licence.jwt");
  execFileSync(tool, ["mint", "-test", "-name", "agent-fabric-sdk-tests", "-out", file], { stdio: "pipe" });
  licence = file;
  return file;
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
   * the URL) and wait for its `serving` line: it has provisioned the seven.
   * Each is sized 256 MiB, so all of them fit a tenant's 4 GB of file storage.
   */
  static async start(url: string, options: EngineOptions = {}): Promise<TestEngine> {
    if (typeof resolved === "string") throw new Error(resolved);
    const engine = new TestEngine();
    const args = ["serve", "--nats", url, "--prefix", "de", "--stream-max-bytes", String(256 * 1024 * 1024)];
    if (options.ackWaitMs !== undefined) args.push("--ack-wait", `${options.ackWaitMs}ms`);
    const proc = spawn(resolved.bin, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, DE_LICENCE: runLicence() },
    });
    engine.#proc = proc;
    let buf = "";
    await new Promise<void>((resolveUp, reject) => {
      const t = setTimeout(() => reject(new Error(`durable-engine serve did not come up:\n${engine.log.join("\n")}`)), 30_000);
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
        reject(new Error(`durable-engine serve exited (${String(code)}):\n${engine.log.join("\n")}`));
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
