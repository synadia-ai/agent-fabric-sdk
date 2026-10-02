#!/usr/bin/env bash
# Installs the two agents' packages. Until the protocol SDK, the fabric
# package and the durable-execution library are published, the agents link
# them by relative path (`file:` in typescript/package.json, uv path sources
# in python/pyproject.toml): the SDK and the library from checkouts next to
# this repository, the fabric package from this repository itself. Their
# TypeScript halves are built in place first.
#
# Called by `make setup`, which names the SDK's checkout and its branch. Safe
# to run twice: a package is built only when its sources are newer than its
# build. In the SDK's and the library's checkouts it writes build output and
# nothing else.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
sdk="$(cd "$repo/.." && pwd)/${SDK_DIR:?}"
de="$(cd "$repo/.." && pwd)/${DE_DIR:?}"

# The SDK's checkout must be there, and on the branch these agents are written
# against: another branch builds, and then the agents fail in ways that point
# nowhere near the cause.
if [ ! -d "$sdk/.git" ]; then
  echo "setup: no checkout at $sdk" >&2
  echo "  clone it next to this repository: git clone -b ${SDK_BRANCH:?} git@github.com:synadia-ai/synadia-agents.git $sdk" >&2
  exit 1
fi
on="$(git -C "$sdk" rev-parse --abbrev-ref HEAD)"
if [ "$on" != "${SDK_BRANCH:?}" ] && [ -z "${ANY_BRANCH:-}" ]; then
  echo "setup: $sdk is on branch $on, not $SDK_BRANCH" >&2
  echo "  switch it (git -C $sdk switch $SDK_BRANCH), or run with ANY_BRANCH=1 to build it as it is" >&2
  exit 1
fi

# The durable-execution library's checkout, for the durable workflow.
if [ ! -f "$de/package.json" ] || [ ! -f "$de/python/pyproject.toml" ]; then
  echo "setup: no durable-execution library at $de" >&2
  echo "  clone it next to this repository, as $(basename "$de")" >&2
  exit 1
fi

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
# The durable-execution library: built in place, like the SDK; in its
# checkout it writes build output and nothing else.
if stale "$de"; then
  echo "setup: building $de"
  (cd "$de" && { [ -d node_modules ] || bun install --frozen-lockfile; } && bun run build)
fi
# This repository's package, after the SDK it builds on, with npm. Its lockfile
# is not committed while its links point outside the repository, so a fresh
# clone installs; a checkout that has one installs exactly that.
dir="$repo/typescript"
if [ "$built" = 1 ] || stale "$dir"; then
  echo "setup: building $dir"
  (
    cd "$dir"
    if [ ! -d node_modules ]; then
      if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
    fi
    npm run build
  )
fi

# The agents. npm installs the three packages as symlinks, so a rebuild there
# is what the agent runs next; nothing to reinstall.
ts="$here/typescript"
if [ ! -f "$ts/node_modules/.package-lock.json" ] ||
  [ "$ts/package.json" -nt "$ts/node_modules/.package-lock.json" ] ||
  [ "$ts/package-lock.json" -nt "$ts/node_modules/.package-lock.json" ]; then
  echo "setup: npm install in reference-agents/typescript"
  (cd "$ts" && npm install --no-audit --no-fund)
fi
# uv installs the Python packages editable, the fabric package from ../python;
# nothing to build. `--locked` refuses to change uv.lock, and prints nothing
# when all is there.
(cd "$here/python" && uv sync --locked --quiet)

echo "setup: done"
