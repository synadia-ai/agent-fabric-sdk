// A throwaway nats-server for the tests: one process on a free port, with
// the users the test asks for, torn down after. The binary must be on
// PATH (`brew install nats-server`); when it is not, the caller skips.
//
// Identity on the fabric is `(account, user)` NATS keys, so every party in
// a test gets its own freshly generated user key. Nothing is committed;
// nothing outlives the process.

import { type ChildProcess, spawn } from "node:child_process";
import { access, constants, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect as tcpConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "@nats-io/nkeys";

export interface TestUser {
  readonly publicKey: string;
  /** The seed as text, what the SDK's `signerFromSeed` and the transport's `nkeyAuthenticator` take. */
  readonly seed: string;
}

export function newUser(): TestUser {
  const kp = createUser();
  return { publicKey: kp.getPublicKey(), seed: new TextDecoder().decode(kp.getSeed()) };
}

export async function natsServerOnPath(): Promise<string | undefined> {
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "nats-server");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("no port"));
        return;
      }
      srv.close(() => resolve(addr.port));
    });
  });
}

function tcpOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tcpConnect({ host: "127.0.0.1", port });
    s.once("connect", () => {
      s.end();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

export class TestNatsServer {
  readonly url: string;
  readonly #proc: ChildProcess;
  readonly #dir: string;

  private constructor(url: string, proc: ChildProcess, dir: string) {
    this.url = url;
    this.#proc = proc;
    this.#dir = dir;
  }

  /** Start a server that accepts exactly `users`, all in the server's default account. */
  static async start(binary: string, users: readonly TestUser[]): Promise<TestNatsServer> {
    const dir = await mkdtemp(join(tmpdir(), "fabric-examples-nats-"));
    const config = join(dir, "server.conf");
    const entries = users.map((u) => `{ nkey: "${u.publicKey}" }`).join(", ");
    await writeFile(config, `authorization { users: [ ${entries} ] }\n`);
    const port = await freePort();
    const proc = spawn(binary, ["-a", "127.0.0.1", "-p", String(port), "-c", config], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    const deadline = Date.now() + 5_000;
    while (!(await tcpOpen(port))) {
      if (proc.exitCode !== null) {
        await rm(dir, { recursive: true, force: true });
        throw new Error(`nats-server exited with ${proc.exitCode}: ${stderr}`);
      }
      if (Date.now() > deadline) {
        proc.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
        throw new Error(`nats-server did not listen on ${port} in time: ${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return new TestNatsServer(`nats://127.0.0.1:${port}`, proc, dir);
  }

  async stop(): Promise<void> {
    if (this.#proc.exitCode === null) {
      const exited = new Promise<void>((resolve) => this.#proc.once("exit", () => resolve()));
      this.#proc.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      if (this.#proc.exitCode === null) this.#proc.kill("SIGKILL");
    }
    await rm(this.#dir, { recursive: true, force: true });
  }
}
