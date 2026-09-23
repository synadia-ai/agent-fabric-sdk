import { defineConfig } from "vitest/config";

// The fabric package and, through it, the protocol SDK packages resolve
// through node_modules to their built `dist/` — the add-on tests them as
// they are installed, never their source.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The integration file starts its own nats-server, and the trace record
    // counts are process-wide, so files run one at a time.
    fileParallelism: false,
  },
});
