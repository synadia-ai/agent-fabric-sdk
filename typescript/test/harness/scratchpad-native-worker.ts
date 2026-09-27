import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deadline } from "./scratchpad-native.js";

export interface NativeWorkerOptions {
  url: string;
  credentials: string;
  volume: string;
  dir: string;
  creator: string;
  timeoutMs: number;
  bytes: number;
  path: string;
  operationId: string;
  emptyPath: string;
}

/** Start the public built SDK with no executable available through PATH. */
export function startNativeWorker(
  options: NativeWorkerOptions,
  mode: "publish" | "recover" | "lock-probe",
) {
  const require = createRequire(import.meta.url);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./scratchpad-native-worker.mjs", import.meta.url)),
      new URL("../../dist/index.js", import.meta.url).href,
      pathToFileURL(require.resolve("@nats-io/transport-node")).href,
      JSON.stringify(options),
      mode,
    ],
    {
      env: { ...process.env, PATH: options.emptyPath, SCRATCHPAD_BIN: "sp-is-unavailable" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  let rejectEvent: (error: Error) => void = () => {};
  const event = new Promise<Record<string, unknown>>((resolve, reject) => {
    rejectEvent = reject;
    createInterface({ input: child.stdout }).on("line", (line: string) => {
      try {
        resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        reject(new Error(`native child emitted invalid JSON: ${line}`));
      }
    });
  });
  child.stderr.on("data", (data: Buffer) => {
    diagnostics = (diagnostics + data.toString()).slice(-128 * 1024);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error) => {
      rejectEvent(error);
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      rejectEvent(
        new Error(`native child exited before its result: ${code}/${signal}: ${diagnostics}`),
      );
      resolve({ code, signal });
    });
  });
  return {
    event: () => deadline(event, 20_000, `native child ${mode}`),
    exited: () => deadline(exited, 10_000, `native child ${mode} exit`),
    kill: async () => {
      child.kill("SIGKILL");
      return deadline(exited, 5000, "native child kill");
    },
    diagnostics: () => diagnostics,
  };
}
