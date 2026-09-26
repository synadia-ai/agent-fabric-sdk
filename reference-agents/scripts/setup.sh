#!/usr/bin/env bash
# Installs the two agents' packages. Until the SDK and the fabric package are
# published, they come from two checkouts next to this one, and their
# TypeScript halves are built there first: the agents link them (`file:` in
# agents/ts/package.json, uv path sources in agents/py/pyproject.toml).
#
# Called by `make setup`, which names the checkouts and their branches. Safe to
# run twice: a package is built only when its sources are newer than its build.
# In the checkouts it writes build output and nothing else.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
sdk="$(cd "$here/.." && pwd)/${SDK_DIR:?}"
fabric="$(cd "$here/.." && pwd)/${FABRIC_DIR:?}"

# Each checkout must be there, and on the branch these agents are written
# against: another branch builds, and then the agents fail in ways that point
# nowhere near the cause.
check() {
  local dir="$1" branch="$2" repo="$3"
  if [ ! -d "$dir/.git" ]; then
    echo "setup: no checkout at $dir" >&2
    echo "  clone it next to this repository: git clone -b $branch git@github.com:$repo.git $dir" >&2
    exit 1
  fi
  local on
  on="$(git -C "$dir" rev-parse --abbrev-ref HEAD)"
  if [ "$on" != "$branch" ] && [ -z "${ANY_BRANCH:-}" ]; then
    echo "setup: $dir is on branch $on, not $branch" >&2
    echo "  switch it (git -C $dir switch $branch), or run with ANY_BRANCH=1 to build it as it is" >&2
    exit 1
  fi
}
check "$sdk" "${SDK_BRANCH:?}" synadia-ai/synadia-agents
check "$fabric" "${FABRIC_BRANCH:?}" synadia-ai/agent-fabric-sdk

need() { command -v "$1" >/dev/null || { echo "setup: $1 not on PATH ($2)" >&2; exit 1; }; }
need bun "the SDK's TypeScript packages build with it"
need npm "the agents install with it; Node 20 or later"
need uv "the Python agent installs with it"

# True when the package at $1 has no build, or a source newer than its build.
stale() {
  local dir="$1" built="$1/dist/index.js"
  [ ! -f "$built" ] && return 0
  [ -n "$(find "$dir/src" "$dir/package.json" "$dir/tsup.config.ts" -newer "$built" -print -quit)" ]
}

built=0
# The protocol SDK: the client first, the host after, as its README orders.
for pkg in client-sdk agent-sdk; do
  dir="$sdk/$pkg/typescript"
  if stale "$dir"; then
    echo "setup: building $dir"
    (cd "$dir" && { [ -d node_modules ] || bun install --frozen-lockfile; } && bun run build)
    built=1
  fi
done
# The fabric package, after the SDK it builds on, with npm.
dir="$fabric/typescript"
if [ "$built" = 1 ] || stale "$dir"; then
  echo "setup: building $dir"
  (cd "$dir" && { [ -d node_modules ] || npm ci; } && npm run build)
fi

# The agents. npm installs the three packages as symlinks into the checkouts,
# so a rebuild there is what the agent runs next; nothing to reinstall.
ts="$here/agents/ts"
if [ ! -f "$ts/node_modules/.package-lock.json" ] ||
  [ "$ts/package.json" -nt "$ts/node_modules/.package-lock.json" ] ||
  [ "$ts/package-lock.json" -nt "$ts/node_modules/.package-lock.json" ]; then
  echo "setup: npm install in agents/ts"
  (cd "$ts" && npm install --no-audit --no-fund)
fi
# uv installs the Python packages editable from the checkouts; nothing to build.
# `--locked` refuses to change uv.lock, and prints nothing when all is there.
(cd "$here/agents/py" && uv sync --locked --quiet)

echo "setup: done"
