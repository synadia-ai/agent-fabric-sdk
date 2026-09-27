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
  treeshake: true,
  splitting: false,
  // `import.meta.url` in the CJS build too: `spBinary` finds the packaged sp by it.
  shims: true,
  tsconfig: "./tsconfig.build.json",
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
