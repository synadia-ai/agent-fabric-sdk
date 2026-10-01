#!/usr/bin/env bun
// Bundles the NATS channel plugin's server and the fabric add-on into one
// runtime: runtime/server.js, runtime/fabric.js and the chunks they share.
// Code splitting puts the protocol SDK and nats.js in shared chunks, so the
// server and the add-on load one copy of each class (the service checks
// `instanceof RequestRejectedError` on what the add-on throws).
//
// Usage: bun bundle.ts <synadia-agents> <agent-fabric-sdk> <out dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const [agentsRepo, fabricRepo, outDir] = process.argv.slice(2).map((p) => resolve(p));
if (!agentsRepo || !fabricRepo || !outDir) {
  console.error("usage: bun bundle.ts <synadia-agents> <agent-fabric-sdk> <out dir>");
  process.exit(2);
}

const pluginDir = join(agentsRepo, "agents/claude-code");
const addonDir = join(fabricRepo, "plugins/claude-code");
const fabricPkgDir = join(fabricRepo, "typescript");

// One place each shared package resolves from, whoever imports it. The
// protocol SDK from the synadia-agents checkout (through agent-fabric's
// links to it), nats.js and everything else third-party from the plugin's
// own node_modules.
const single: BunPlugin = {
  name: "single-copy",
  setup(build) {
    build.onResolve({ filter: /^@synadia-ai\/(agents|agent-service)(\/.*)?$/ }, (args) => ({
      path: Bun.resolveSync(args.path, fabricPkgDir),
    }));
    build.onResolve({ filter: /^@synadia-ai\/agent-fabric(\/.*)?$/ }, (args) => ({
      path: Bun.resolveSync(args.path, addonDir),
    }));
    build.onResolve({ filter: /^@nats-io\/[^/]+(\/.*)?$/ }, (args) => ({
      path: Bun.resolveSync(args.path, pluginDir),
    }));
  },
};

// The add-on's entry under the name the plugin is told to load.
const entryDir = join(outDir, ".entry");
mkdirSync(entryDir, { recursive: true });
const fabricEntry = join(entryDir, "fabric.ts");
writeFileSync(
  fabricEntry,
  `export { default } from ${JSON.stringify(join(addonDir, "src/index.ts"))};\n`,
);

const runtime = await Bun.build({
  entrypoints: [join(pluginDir, "server.ts"), fabricEntry],
  outdir: join(outDir, "runtime"),
  target: "bun",
  format: "esm",
  splitting: true,
  minify: true,
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
  plugins: [single],
});
check(runtime, "runtime");

// The plugin's hook imports from its src/; bundled, it needs nothing beside it.
const hook = await Bun.build({
  entrypoints: [join(pluginDir, "hooks/session-event.ts")],
  outdir: join(outDir, "hooks"),
  target: "bun",
  format: "esm",
  minify: true,
  naming: "[name].js",
});
check(hook, "hook");

for (const o of [...runtime.outputs, ...hook.outputs]) console.log(`built ${o.path.replace(outDir + "/", "")}`);

function check(result: Awaited<ReturnType<typeof Bun.build>>, what: string) {
  if (result.success) return;
  for (const log of result.logs) console.error(log);
  throw new Error(`${what} bundle failed`);
}
