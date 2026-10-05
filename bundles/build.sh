#!/bin/sh
# Builds the self-contained harness plugins: each public NATS channel plugin
# (synadia-agents agents/<harness>) with this repo's add-on (plugins/<harness>)
# and ScratchPad's skill, bundled so nothing needs installing:
#
#   fabric-claude-<v>.tar.gz    fabric-claude/, for `claude --plugin-dir`; the
#                               tarball's root is also a marketplace, `fabric`
#   fabric-pi-<v>.tar.gz        fabric-pi/, a PI package (`pi install`, or
#                               `pi -e fabric-pi/dist/nats-channel.js`)
#   fabric-openclaw-<v>.tar.gz  fabric-openclaw/, an OpenClaw plugin
#                               (`openclaw plugins install`, or plugins.load.paths)
#
# The plugins are used, never copied: each is bundled from the synadia-agents
# checkout at whatever commit it is on. The bundle's version is the plugin's
# plus both repos' commits, <plugin version>+fabric.<synadia-agents>.<this
# repo>, in its manifest and BUILD file; <v> in the file name is the same
# with dashes, <plugin version>-<synadia-agents>-<this repo>, since a + does
# not survive URLs and release assets.
#
# Usage: bundles/build.sh [claude-code|pi|openclaw|all] [out dir]
# Defaults: all, and bundles/out.
#
# synadia-agents is where this repo's file: links expect it (CLAUDE.md):
# ../synadia-agents, on main. Needs bun, node/npm, and gh
# logged in when ScratchPad's release cannot be downloaded anonymously.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fabric=$(cd "$here/.." && pwd)
agents=$(cd "$fabric/../synadia-agents" && pwd)
which=${1:-all}
out=${2:-$fabric/bundles/out}

case $which in
  all) harnesses="claude-code pi openclaw" ;;
  claude-code | pi | openclaw) harnesses=$which ;;
  *) echo "usage: $0 [claude-code|pi|openclaw|all] [out dir]" >&2; exit 2 ;;
esac

step() { printf '\n== %s\n' "$*"; }

step "checking the checkouts"
branch=$(git -C "$agents" branch --show-current)
[ "$branch" = main ] || {
  echo "synadia-agents is on '$branch'; this repo builds against main" >&2
  exit 1
}
agents_rev=$(git -C "$agents" rev-parse --short HEAD)
fabric_rev=$(git -C "$fabric" rev-parse --short HEAD)

step "building the protocol SDK"
# As CLAUDE.md builds it: bun for the SDK's own packages.
(cd "$agents/client-sdk/typescript" && bun install && bun run build)
(cd "$agents/agent-sdk/typescript" && bun install && bun run build)

step "building the fabric package"
(cd "$fabric/typescript" && npm ci --no-audit --no-fund && npm run build)

# skill <add-on dir> <skill dir> [allowed-tools]: ScratchPad's skill in the
# add-on, from its release (anonymously, else through gh).
skill() {
  # Verify the selected release and regenerate the skill on every build.
  # Existing executables can belong to a previous release.
  # The installer runs from the add-on's package folder.
  if [ -n "${3:-}" ]; then
    (cd "$1" && { sh "$fabric/plugins/scratchpad-skill/install.sh" --dest "$2" --allowed-tools "$3" ||
      sh "$fabric/plugins/scratchpad-skill/install.sh" --dest "$2" --allowed-tools "$3" --download gh; })
  else
    (cd "$1" && { sh "$fabric/plugins/scratchpad-skill/install.sh" --dest "$2" ||
      sh "$fabric/plugins/scratchpad-skill/install.sh" --dest "$2" --download gh; })
  fi
}

# manifest <kind> …: the bundle's JSON files, written by node.
manifest() {
  PLUGIN=$plugin PKG=$pkg MARKET=${market:-} AGENTS_REV=$agents_rev FABRIC_REV=$fabric_rev KIND=$1 node <<'EOF'
const fs = require("fs");
const { PLUGIN, PKG, MARKET, AGENTS_REV, FABRIC_REV, KIND } = process.env;
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const suffix = `+fabric.${AGENTS_REV}.${FABRIC_REV}`;
const described = (d) => d + ", with the Synadia Agent Fabric add-on and ScratchPad";

if (KIND === "claude-code") {
  // Same name as the public plugin, so the channel flag stays
  // plugin:nats-channel@… and the tool stays mcp__plugin_nats-channel_nats.
  const manifest = read(`${PLUGIN}/.claude-plugin/plugin.json`);
  manifest.version += suffix;
  manifest.description = described(manifest.description);
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
  const hooks = read(`${PLUGIN}/hooks/hooks.json`);
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
} else {
  // A package of the public plugin's name and version, its dependencies
  // bundled, its entries the bundled ones. The add-on is named apart:
  // SYNADIA_PI_EXTENSIONS / SYNADIA_OPENCLAW_EXTENSIONS=<bundle>/dist/fabric.js.
  const src = read(`${PLUGIN}/package.json`);
  const pkg = {
    name: src.name,
    version: src.version + suffix,
    description: described(src.description),
    keywords: src.keywords,
    license: src.license,
    author: src.author,
    repository: src.repository,
    type: "module",
    peerDependencies: src.peerDependencies,
  };
  if (KIND === "pi") {
    pkg.pi = { extensions: ["./dist/nats-channel.js"], skills: ["./skill"] };
  } else {
    pkg.openclaw = {
      ...src.openclaw,
      extensions: ["./dist/index.js"],
      runtimeExtensions: ["./dist/index.js"],
      setupEntry: "./dist/setup-entry.js",
      runtimeSetupEntry: "./dist/setup-entry.js",
    };
  }
  write(`${PKG}/package.json`, pkg);
}

fs.writeFileSync(`${PKG}/BUILD`, `synadia-agents ${AGENTS_REV}\nagent-fabric-sdk ${FABRIC_REV}\nbuilt ${new Date().toISOString()}\n`);
EOF
}

for harness in $harnesses; do
  plugin=$agents/agents/$harness
  addon=$fabric/plugins/$harness
  [ -d "$plugin" ] || { echo "no plugin at $plugin" >&2; exit 1; }

  step "$harness: building the add-on"
  (cd "$addon" && npm ci --no-audit --no-fund && npm run build)

  case $harness in
    claude-code)
      name=fabric-claude
      market=$out/fabric
      pkg=$market/$name
      step "$harness: installing the plugin's dependencies"
      # bun refuses the plugin's file: links to the SDK; bundle.ts resolves
      # the SDK itself, so only the third-party packages are needed here.
      (cd "$plugin" && bun install --frozen-lockfile >/dev/null 2>&1 || true)
      [ -d "$plugin/node_modules/@modelcontextprotocol/sdk" ] || {
        echo "bun install left no @modelcontextprotocol/sdk in $plugin" >&2
        exit 1
      }
      skill "$addon" "$addon/skills/scratchpad" 'Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)'
      ;;
    pi | openclaw)
      name=fabric-$harness
      market=
      pkg=$out/$name
      skill "$addon" "$addon/skill/scratchpad"
      ;;
  esac

  step "$harness: bundling"
  rm -rf "$pkg" ${market:+"$market"}
  mkdir -p "$pkg"
  bun "$here/bundle.ts" "$harness" "$agents" "$fabric" "$pkg"
  rm -rf "$pkg/.entry"

  step "$harness: assembling"
  cp "$plugin/LICENSE" "$pkg/"
  case $harness in
    claude-code)
      mkdir -p "$pkg/.claude-plugin" "$pkg/skills"
      cp -R "$plugin/skills/configure" "$pkg/skills/"
      cp -R "$addon/skills/scratchpad" "$pkg/skills/"
      cp "$addon/hooks/session-start.sh" "$pkg/hooks/"
      ;;
    pi)
      mkdir -p "$pkg/skill"
      cp -R "$addon/skill/scratchpad" "$pkg/skill/"
      ;;
    openclaw)
      mkdir -p "$pkg/skill"
      cp -R "$addon/skill/scratchpad" "$pkg/skill/"
      cp "$plugin/openclaw.plugin.json" "$pkg/"
      ;;
  esac
  manifest "$harness"

  step "$harness: packing"
  case $harness in
    claude-code) version=$(node -p "require('$plugin/.claude-plugin/plugin.json').version") ;;
    *) version=$(node -p "require('$plugin/package.json').version") ;;
  esac
  file=$out/$name-$version-$agents_rev-$fabric_rev.tar.gz
  if [ -n "$market" ]; then
    COPYFILE_DISABLE=1 tar -C "$market" -czf "$file" .claude-plugin "$name"
  else
    COPYFILE_DISABLE=1 tar -C "$out" -czf "$file" "$name"
  fi
  ls -lh "$file"
done

printf '\nsynadia-agents %s, agent-fabric-sdk %s\n' "$agents_rev" "$fabric_rev"
