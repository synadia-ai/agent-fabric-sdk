import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface NativeFixtureUser {
  account: string;
  user: string;
  credentials: string;
}

export interface NativeFixtureConfig {
  event: "ready";
  url: string;
  fault_url: string;
  volume: string;
  users: Record<"owner" | "reader" | "intruder", NativeFixtureUser>;
  storage: "file";
  replicas: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export async function deadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The child owns the real service, file-backed NATS store, and generated keys. */
export class NativeServiceFixture {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #directory: string;
  readonly #pending = new Map<number, Pending>();
  readonly #exited: Promise<number | null>;
  readonly #ready: Promise<NativeFixtureConfig>;
  #sequence = 0;
  #diagnostics = "";
  #closed = false;
  config!: NativeFixtureConfig;

  private constructor(binary: string, directory: string, coreRoot: string) {
    this.#directory = directory;
    this.#process = spawn(
      binary,
      ["-test.run=^TestNativeClientFixtureProcess$", "-test.timeout=180s"],
      {
        cwd: coreRoot,
        env: { ...process.env, SP_NATIVE_CLIENT_FIXTURE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let readyReject: (error: Error) => void = () => {};
    this.#ready = new Promise((resolveReady, reject) => {
      readyReject = reject;
      const lines = createInterface({ input: this.#process.stdout });
      lines.on("line", (line: string) => {
        if (!line.startsWith("SP_NATIVE ")) {
          this.#diagnostics = (this.#diagnostics + line + "\n").slice(-128 * 1024);
          return;
        }
        try {
          const message = JSON.parse(line.slice("SP_NATIVE ".length)) as Record<string, unknown>;
          if (message["event"] === "ready") {
            resolveReady(message as unknown as NativeFixtureConfig);
            return;
          }
          const id = message["id"];
          if (typeof id !== "number" || !this.#pending.has(id)) {
            throw new Error("fixture emitted an unrequested result");
          }
          const pending = this.#pending.get(id)!;
          this.#pending.delete(id);
          if (typeof message["error"] === "string") {
            pending.reject(new Error(`fixture ${String(message["code"])}: ${message["error"]}`));
          } else {
            pending.resolve(message["value"]);
          }
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          reject(failure);
          for (const pending of this.#pending.values()) pending.reject(failure);
          this.#pending.clear();
        }
      });
    });
    this.#process.stderr.on("data", (data: Buffer) => {
      this.#diagnostics = (this.#diagnostics + data.toString()).slice(-128 * 1024);
    });
    this.#process.stdin.on("error", (error) => {
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
    this.#exited = new Promise((resolveExit) => {
      this.#process.once("error", (error) => {
        readyReject(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        resolveExit(null);
      });
      this.#process.once("close", (code) => {
        const error = new Error(`real ScratchPad fixture exited ${code}: ${this.#diagnostics}`);
        readyReject(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        resolveExit(code);
      });
    });
  }

  static async start(coreRoot: string): Promise<NativeServiceFixture> {
    const directory = await mkdtemp(join(tmpdir(), "scratchpad-native-service-"));
    const binary = join(directory, "fixture");
    try {
      await execute("go", ["test", "-c", "-o", binary, "./internal/volumeservice"], {
        cwd: resolve(coreRoot),
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      });
      const fixture = new NativeServiceFixture(binary, directory, resolve(coreRoot));
      try {
        fixture.config = await deadline(fixture.#ready, 20_000, "native fixture startup");
        return fixture;
      } catch (error) {
        fixture.#process.kill("SIGKILL");
        await deadline(fixture.#exited, 5000, "failed fixture cleanup");
        throw error;
      }
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async command<T>(command: string, fields: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) throw new Error("fixture is closed");
    const id = ++this.#sequence;
    const result = new Promise<T>((resolveResult, reject) => {
      this.#pending.set(id, { resolve: (value) => resolveResult(value as T), reject });
    });
    this.#process.stdin.write(JSON.stringify({ ...fields, id, command }) + "\n");
    return deadline(result, 15_000, `fixture ${command}`);
  }

  async close(): Promise<Record<string, number>> {
    if (this.#closed) throw new Error("fixture was already closed");
    try {
      const counts = await this.command<Record<string, number>>("stop");
      this.#process.stdin.end();
      const code = await deadline(this.#exited, 15_000, "native fixture shutdown");
      if (code !== 0) throw new Error(`fixture shutdown failed: ${this.#diagnostics}`);
      return counts;
    } finally {
      this.#closed = true;
      if (this.#process.exitCode === null) {
        this.#process.kill("SIGKILL");
        await deadline(this.#exited, 5000, "native fixture reap");
      }
      await rm(this.#directory, { recursive: true, force: true });
    }
  }
}
