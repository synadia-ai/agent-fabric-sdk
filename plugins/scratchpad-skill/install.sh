#!/bin/sh
# Fetch the pinned release and install the shared skill during npm prepack.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null || { echo "install.sh: Node 20 or newer is required" >&2; exit 1; }
exec node "$here/load-sp.mjs" install "$@"
