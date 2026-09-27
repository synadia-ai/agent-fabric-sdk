#!/bin/sh
# Installs ScratchPad's skill into the add-on in the current directory, as
# skill/scratchpad: SKILL.md, scripts/sp and the sp binaries, which it
# builds first (build-sp.sh, cached in bin/ here). The one skill every
# add-on under plugins/ ships (`docs/plugins.md` §9.1); the copies are
# build output, gitignored in each add-on. Run by each add-on's
# `npm run build:sp` and at pack time (`prepack`).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
addon=$(pwd)
[ -f "$addon/package.json" ] || { echo "install.sh: run it from an add-on's directory" >&2; exit 1; }

sh "$here/build-sp.sh"
dest=$addon/skill/scratchpad
rm -rf "$dest"
mkdir -p "$dest/scripts" "$dest/bin"
cp "$here/SKILL.md" "$dest/SKILL.md"
cp "$here/scripts/sp" "$dest/scripts/sp"
chmod +x "$dest/scripts/sp"
cp "$here"/bin/sp-* "$here/bin/COMMIT" "$dest/bin/"
echo "installed ScratchPad's skill in $dest"
