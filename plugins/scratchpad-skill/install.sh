#!/bin/sh
# Installs ScratchPad's skill into the add-on in the current directory, as
# skill/scratchpad: SKILL.md, scripts/sp and the sp binaries, which it
# builds first (build-sp.sh, cached in bin/ here). The one skill every
# add-on under plugins/ ships (`docs/plugins.md` §9.1); the copies are
# build output, gitignored in each add-on. Run by each add-on's
# `npm run build:sp` and at pack time (`prepack`).
#
#   install.sh [--dest <dir>] [--allowed-tools <rule>]
#
# --dest puts the skill elsewhere in the add-on (Claude Code's plugin layout
# wants skills/scratchpad); --allowed-tools adds that line to the copy's
# front matter (Claude Code's, so its Bash runs scripts/sp without a
# permission question; §9.13).
set -eu

dest_rel=skill/scratchpad
allowed=
while [ $# -gt 0 ]; do
  case $1 in
    --dest) dest_rel=$2; shift 2 ;;
    --allowed-tools) allowed=$2; shift 2 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
addon=$(pwd)
[ -f "$addon/package.json" ] || { echo "install.sh: run it from an add-on's directory" >&2; exit 1; }

sh "$here/build-sp.sh"
dest=$addon/$dest_rel
rm -rf "$dest"
mkdir -p "$dest/scripts" "$dest/bin"
if [ -n "$allowed" ]; then
  # After the front matter's description line.
  awk -v line="allowed-tools: $allowed" '{ print } /^description:/ && !done { print line; done = 1 }' \
    "$here/SKILL.md" >"$dest/SKILL.md"
else
  cp "$here/SKILL.md" "$dest/SKILL.md"
fi
cp "$here/scripts/sp" "$dest/scripts/sp"
chmod +x "$dest/scripts/sp"
cp "$here"/bin/sp-* "$here/bin/COMMIT" "$here/bin/BUILD.json" "$dest/bin/"
cp "$here/bin/THIRD_PARTY_NOTICES" "$dest/THIRD_PARTY_NOTICES"
echo "installed ScratchPad's skill in $dest"
