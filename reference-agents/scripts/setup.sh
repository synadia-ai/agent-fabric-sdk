#!/usr/bin/env bash
# Installs the two agents' packages for work on this repository: the
# agents run against the packages as they stand in the checkouts, not as
# published. TypeScript installs from npm (package.json names the published
# versions, which is what a copy of the agent gets with `npm install`) and
# then links the four packages over that install: the protocol SDK and the
# thin durable SDK from checkouts next to this repository, the fabric
# package from this repository itself, their TypeScript halves built in
# place first. Python takes all four by uv path sources (pyproject.toml)
# until they are on PyPI.
#
# Called by `make setup`, which names the SDK's checkout and its branch. Safe
# to run twice: a package is built only when its sources are newer than its
# build, and the links are made again each time, since a plain `npm install`
# in the agent puts the published versions back. In the two SDKs' checkouts
# it writes build output and nothing else.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/.." && pwd)"
sdk="$(cd "$repo/.." && pwd)/${SDK_DIR:?}"
de="$(cd "$repo/.." && pwd)/${DE_DIR:?}"

# The SDK's checkout must be there, and on the branch these agents are written
# against: another branch builds, and then the agents fail in ways that point
# nowhere near the cause.
# A checkout or a worktree: a worktree's .git is a file, not a directory.
if [ ! -e "$sdk/.git" ]; then
  echo "setup: no checkout or worktree at $sdk" >&2
  echo "  clone it next to this repository: git clone -b ${SDK_BRANCH:?} git@github.com:synadia-ai/synadia-agents.git $sdk" >&2
  exit 1
fi
on="$(git -C "$sdk" rev-parse --abbrev-ref HEAD)"
if [ "$on" != "${SDK_BRANCH:?}" ] && [ -z "${ANY_BRANCH:-}" ]; then
  echo "setup: $sdk is on branch $on, not $SDK_BRANCH" >&2
  echo "  switch it (git -C $sdk switch $SDK_BRANCH), or run with ANY_BRANCH=1 to build it as it is" >&2
  exit 1
fi

# The thin durable SDK's checkout, for the durable workflows.
if [ ! -f "$de/package.json" ] || [ ! -f "$de/python/pyproject.toml" ]; then
  echo "setup: no durable SDK (a checkout or a worktree) at $de" >&2
  echo "  clone it, or add a worktree of it, next to this repository, as $(basename "$de")" >&2
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
# The thin durable SDK: built in place, like the protocol SDK; in its
# checkout it writes build output and nothing else. The engine behind it is
# built by the durable tests themselves (test/harness/engine.ts, tests/harness/engine.py).
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

# The agents. The TypeScript agent installs what its lockfile names, from
# npm, and then the four packages are linked over it with `--no-save`,
# which leaves package.json and the lockfile as they are: what is built in
# the checkouts is what the agent runs next.
ts="$here/typescript"
if [ ! -f "$ts/node_modules/.package-lock.json" ] ||
  [ "$ts/package.json" -nt "$ts/node_modules/.package-lock.json" ] ||
  [ "$ts/package-lock.json" -nt "$ts/node_modules/.package-lock.json" ]; then
  echo "setup: npm install in reference-agents/typescript"
  (cd "$ts" && npm ci --no-audit --no-fund)
fi
echo "setup: linking the checkouts' packages into reference-agents/typescript"
(cd "$ts" && npm install --no-save --no-audit --no-fund \
  "$repo/typescript" "$sdk/agent-sdk/typescript" "$sdk/client-sdk/typescript" "$de")
# uv installs the Python packages editable, the fabric package from ../python;
# nothing to build. `--locked` refuses to change uv.lock, and prints nothing
# when all is there.
(cd "$here/python" && uv sync --locked --quiet)

echo "setup: done"
