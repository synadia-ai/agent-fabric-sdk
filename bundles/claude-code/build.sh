#!/bin/sh
# Builds fabric-claude.tar.gz: the public NATS channel plugin for Claude Code
# (synadia-agents agents/claude-code) with this repo's add-on
# (plugins/claude-code) and ScratchPad's skill, in one plugin folder that
# needs nothing installed: `claude --plugin-dir fabric-claude`. The tarball's
# root is also a Claude Code marketplace, `fabric`, of that one plugin.
#
# The plugin is used, never copied: it is bundled from the synadia-agents
# checkout at whatever commit it is on, and the commits of both repos are
# recorded in the bundle's BUILD file and its version.
#
# Usage: bundles/claude-code/build.sh [out dir]   (default bundles/out)
#
# synadia-agents is where this repo's file: links expect it (CLAUDE.md):
# ../synadia-agents, on sdk-release-rollout. Needs bun, node/npm, and gh
# logged in when ScratchPad's release cannot be downloaded anonymously.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fabric=$(cd "$here/../.." && pwd)
agents=$(cd "$fabric/../synadia-agents" && pwd)
out=${1:-$fabric/bundles/out}

plugin=$agents/agents/claude-code
addon=$fabric/plugins/claude-code
market=$out/fabric
pkg=$market/fabric-claude

step() { printf '\n== %s\n' "$*"; }

step "checking the checkouts"
branch=$(git -C "$agents" branch --show-current)
[ "$branch" = sdk-release-rollout ] || {
  echo "synadia-agents is on '$branch'; this repo builds against sdk-release-rollout" >&2
  exit 1
}
[ -f "$plugin/server.ts" ] || { echo "no plugin at $plugin" >&2; exit 1; }

step "building the protocol SDK"
# As CLAUDE.md builds it: bun for the SDK's own packages.
(cd "$agents/client-sdk/typescript" && bun install && bun run build)
(cd "$agents/agent-sdk/typescript" && bun install && bun run build)

step "building the fabric package and the add-on"
for d in "$fabric/typescript" "$addon"; do
  (cd "$d" && npm ci --no-audit --no-fund && npm run build)
done

step "installing the plugin's dependencies"
# bun refuses the plugin's file: links to the SDK; bundle.ts resolves the SDK
# itself, so only the third-party packages are needed here.
(cd "$plugin" && bun install --frozen-lockfile >/dev/null 2>&1 || true)
[ -d "$plugin/node_modules/@modelcontextprotocol/sdk" ] || {
  echo "bun install left no @modelcontextprotocol/sdk in $plugin" >&2
  exit 1
}

step "installing ScratchPad's skill"
if [ ! -x "$addon/skills/scratchpad/bin/sp-linux-amd64" ]; then
  (cd "$addon" && npm run build:sp) ||
    sh "$fabric/plugins/scratchpad-skill/install.sh" --dest "$addon/skills/scratchpad" \
      --allowed-tools 'Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)' --download gh
fi

step "bundling"
rm -rf "$market"
mkdir -p "$pkg"
bun "$here/bundle.ts" "$agents" "$fabric" "$pkg"
rm -rf "$pkg/.entry"

step "assembling the plugin folder"
mkdir -p "$pkg/.claude-plugin" "$pkg/skills"
cp "$plugin/LICENSE" "$pkg/"
cp -R "$plugin/skills/configure" "$pkg/skills/"
cp -R "$addon/skills/scratchpad" "$pkg/skills/"
cp "$addon/hooks/session-start.sh" "$pkg/hooks/"

agents_rev=$(git -C "$agents" rev-parse --short HEAD)
fabric_rev=$(git -C "$fabric" rev-parse --short HEAD)

PLUGIN=$plugin PKG=$pkg MARKET=$market AGENTS_REV=$agents_rev FABRIC_REV=$fabric_rev node <<'EOF'
const fs = require("fs");
const { PLUGIN, PKG, MARKET, AGENTS_REV, FABRIC_REV } = process.env;
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");

// Same name as the public plugin, so the channel flag stays
// plugin:nats-channel@… and the tool stays mcp__plugin_nats-channel_nats.
const manifest = JSON.parse(fs.readFileSync(`${PLUGIN}/.claude-plugin/plugin.json`, "utf8"));
manifest.version += `+fabric.${AGENTS_REV}.${FABRIC_REV}`;
manifest.description += ", with the Synadia Agent Fabric add-on and ScratchPad";
write(`${PKG}/.claude-plugin/plugin.json`, manifest);

// The bundled server, told to load the bundled add-on.
write(`${PKG}/.mcp.json`, {
  mcpServers: {
    nats: {
      command: "bun",
      args: ["${CLAUDE_PLUGIN_ROOT}/runtime/server.js"],
      env: {
        CLAUDE_CWD: "${PWD}",
        SYNADIA_CLAUDE_CODE_EXTENSIONS: "${CLAUDE_PLUGIN_ROOT}/runtime/fabric.js",
      },
    },
  },
});

// The plugin's three hooks on the bundled script, plus the add-on's
// SessionStart hook that hands ScratchPad's sp its environment.
const hooks = JSON.parse(fs.readFileSync(`${PLUGIN}/hooks/hooks.json`, "utf8"));
for (const groups of Object.values(hooks.hooks))
  for (const g of groups)
    for (const h of g.hooks)
      h.command = h.command.replace("hooks/session-event.ts", "hooks/session-event.js");
hooks.hooks.SessionStart.push({
  hooks: [{ type: "command", command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh"', timeout: 10 }],
});
write(`${PKG}/hooks/hooks.json`, hooks);

// The tarball's root is a marketplace of this one plugin.
fs.mkdirSync(`${MARKET}/.claude-plugin`, { recursive: true });
write(`${MARKET}/.claude-plugin/marketplace.json`, {
  name: "fabric",
  owner: { name: "Synadia" },
  metadata: { description: "Synadia Agent Fabric plugins for Claude Code" },
  plugins: [{ name: "nats-channel", source: "./fabric-claude", description: manifest.description, version: manifest.version }],
});

fs.writeFileSync(`${PKG}/BUILD`, `synadia-agents ${AGENTS_REV}\nagent-fabric-sdk ${FABRIC_REV}\nbuilt ${new Date().toISOString()}\n`);
EOF

step "packing"
tar -C "$market" -czf "$out/fabric-claude.tar.gz" .claude-plugin fabric-claude
ls -lh "$out/fabric-claude.tar.gz"
cat "$pkg/BUILD"
