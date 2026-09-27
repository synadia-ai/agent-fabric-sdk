import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // sqlite is a prefix-only built-in; rewriting node:sqlite to sqlite breaks runtime import.
  removeNodeProtocol: false,
  treeshake: true,
  splitting: false,
  // Keep loading the existing Node 20 CJS entry independent of ESM-only data packages.
  noExternal: [/^@unicode\/unicode-15\.0\.0(?:\/|$)/],
  tsconfig: "./tsconfig.build.json",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
