#!/bin/sh
# Build once, then package the same executable bytes for standalone consumers.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${SP_BUILD_PYTHON:-python3}
if [ -z "${SP_BUILD_PYTHON:-}" ] && command -v python3.12 >/dev/null; then python=python3.12; fi
exec "$python" "$here/release.py" release "$@"
