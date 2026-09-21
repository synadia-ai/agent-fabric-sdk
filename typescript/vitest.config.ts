import { defineConfig } from "vitest/config";

// The protocol SDK packages resolve through node_modules to their built
// `dist/` — the fabric tests the SDK as it is installed, never its source.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each integration file starts its own nats-server; the trace record
    // counts are process-wide, so files run one at a time.
    fileParallelism: false,
  },
});
