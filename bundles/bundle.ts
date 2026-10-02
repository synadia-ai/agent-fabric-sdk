#!/usr/bin/env bun
// Bundles a harness's public NATS channel plugin and this repo's add-on into
// one runtime: the plugin's entries, fabric.js (the add-on, under the name
// the plugin is told to load) and the chunks they share. Code splitting puts
// the protocol SDK and nats.js in shared chunks, so the plugin and the
// add-on load one copy of each class (the service checks
// `instanceof RequestRejectedError` on what the add-on throws).
//
// Usage: bun bundle.ts <claude-code|pi|openclaw> <synadia-agents> <agent-fabric-sdk> <out dir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const [harness, ...rest] = process.argv.slice(2);
const [agentsRepo, fabricRepo, outDir] = rest.map((p) => resolve(p));
if (!harness || !agentsRepo || !fabricRepo || !outDir) {
  console.error("usage: bun bundle.ts <claude-code|pi|openclaw> <synadia-agents> <agent-fabric-sdk> <out dir>");
  process.exit(2);
}

type Target = {
  // The plugin's entries, relative to its folder.
  entries: string[];
  // Where the runtime goes in the bundle, and what it runs on.
  outSub: string;
  target: "bun" | "node";
  // The host's own packages, which the host provides at run time.
  external: string[];
  // Where third-party packages (nats.js and the rest) resolve from.
  thirdParty: (pluginDir: string) => string;
};

const targets: Record<string, Target> = {
  // Claude Code runs the plugin's server as a Bun process of its own.
  "claude-code": {
    entries: ["server.ts"],
    outSub: "runtime",
    target: "bun",
    external: [],
    thirdParty: (pluginDir) => pluginDir,
  },
  // PI loads the extension into its own process; its imports of PI are types.
  pi: {
    entries: ["extensions/nats-channel.ts"],
    outSub: "dist",
    target: "node",
    external: ["@earendil-works/pi-coding-agent"],
    thirdParty: () => join(agentsRepo, "client-sdk/typescript"),
  },
  // OpenClaw loads the plugin into its gateway, which provides openclaw/*.
  openclaw: {
    entries: ["index.ts", "setup-entry.ts"],
    outSub: "dist",
    target: "node",
    external: ["openclaw", "openclaw/*"],
    thirdParty: () => join(agentsRepo, "client-sdk/typescript"),
  },
};

const t = targets[harness];
if (!t) {
  console.error(`unknown harness ${harness}`);
  process.exit(2);
}

const pluginDir = join(agentsRepo, "agents", harness);
const addonDir = join(fabricRepo, "plugins", harness);
const fabricPkgDir = join(fabricRepo, "typescript");
const thirdPartyDir = t.thirdParty(pluginDir);

// One place each shared package resolves from, whoever imports it: the
// protocol SDK from the synadia-agents checkout (through agent-fabric's
// links to it), nats.js from one folder for every importer.
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
      path: Bun.resolveSync(args.path, thirdPartyDir),
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
  entrypoints: [...t.entries.map((e) => join(pluginDir, e)), fabricEntry],
  outdir: join(outDir, t.outSub),
  target: t.target,
  format: "esm",
  splitting: true,
  minify: true,
  external: t.external,
  naming: { entry: "[name].[ext]", chunk: "chunk-[hash].[ext]" },
  plugins: [single],
});
check(runtime, "runtime");
const outputs = [...runtime.outputs];

// Claude Code's hook imports from the plugin's src/; bundled, it needs
// nothing beside it.
if (harness === "claude-code") {
  const hook = await Bun.build({
    entrypoints: [join(pluginDir, "hooks/session-event.ts")],
    outdir: join(outDir, "hooks"),
    target: "bun",
    format: "esm",
    minify: true,
    naming: "[name].js",
  });
  check(hook, "hook");
  outputs.push(...hook.outputs);
}

for (const o of outputs) console.log(`built ${o.path.replace(outDir + "/", "")}`);

function check(result: Awaited<ReturnType<typeof Bun.build>>, what: string) {
  if (result.success) return;
  for (const log of result.logs) console.error(log);
  throw new Error(`${what} bundle failed`);
}
