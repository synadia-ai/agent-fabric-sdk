import { defineConfig } from "vitest/config";

// The test starts its own nats-server (see test/harness/nats-server.ts) and
// skips itself when the binary is not on PATH. Prompts, discovery and the
// edge records all go over that one server.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
