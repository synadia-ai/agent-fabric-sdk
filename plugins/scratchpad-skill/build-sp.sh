#!/bin/sh
# Builds the sp command line into bin/ here, one binary per platform
# scripts/sp picks from: darwin and linux, arm64 and amd64, with cgo off and
# stripped (`docs/plugins.md` §9.8). `install.sh` runs it and copies the
# binaries into an add-on's skill directory. The binaries are never
# committed.
#
# The source is ScratchPad's repository at the pinned commit, exported with
# `git archive` so the checkout is left as it is. SCRATCHPAD_SRC names the
# checkout (default: next to this repository); SP_COMMIT overrides the pin.
set -eu

SP_COMMIT=${SP_COMMIT:-a28bb495cce1dc0e3df2b73c22f7b10594b9262b}
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src=${SCRATCHPAD_SRC:-$here/../../../scratchpad}
out=$here/bin
targets="darwin/arm64 darwin/amd64 linux/arm64 linux/amd64"

if [ -f "$out/COMMIT" ] && [ "$(cat "$out/COMMIT")" = "$SP_COMMIT" ]; then
  missing=false
  for t in $targets; do
    [ -x "$out/sp-${t%/*}-${t#*/}" ] || missing=true
  done
  if ! $missing; then
    echo "sp at $SP_COMMIT already built in $out"
    exit 0
  fi
fi

command -v go >/dev/null || { echo "build-sp: go is not on PATH" >&2; exit 1; }
git -C "$src" rev-parse --verify --quiet "$SP_COMMIT^{commit}" >/dev/null ||
  { echo "build-sp: no commit $SP_COMMIT in $src (SCRATCHPAD_SRC)" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git -C "$src" archive "$SP_COMMIT" | tar -x -C "$tmp"
mkdir -p "$out"
rm -f "$out"/sp-* "$out/COMMIT"
for t in $targets; do
  os=${t%/*}
  arch=${t#*/}
  (cd "$tmp" && CGO_ENABLED=0 GOOS=$os GOARCH=$arch \
    go build -trimpath -ldflags='-s -w' -o "$out/sp-$os-$arch" ./cmd/sp)
  echo "built $out/sp-$os-$arch ($(wc -c <"$out/sp-$os-$arch" | tr -d ' ') bytes)"
done
echo "$SP_COMMIT" >"$out/COMMIT"
