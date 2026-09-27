// Explicit real-service gate. Missing prerequisites are errors, not skipped tests.
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.SCRATCHPAD_CORE_ROOT;
if (!root)
  throw new Error(
    "SCRATCHPAD_CORE_ROOT must name the private ScratchPad checkout used for conformance",
  );
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13))
  throw new Error("native writer qualification needs Node 22.13+");
await access(resolve(root, "internal/volumeservice/native_client_fixture_test.go"));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
await access(resolve(packageRoot, "dist/index.js"));
console.info(
  `NATIVE_TEST_ENV node=${process.version} platform=${process.platform} arch=${process.arch} core=${resolve(root)}`,
);
const child = spawn(
  process.execPath,
  [
    resolve(packageRoot, "node_modules/vitest/vitest.mjs"),
    "run",
    "test/integration/scratchpad-native",
  ],
  { cwd: packageRoot, env: process.env, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) console.error(`native suite stopped by ${signal}`);
  process.exitCode = code ?? 1;
});
