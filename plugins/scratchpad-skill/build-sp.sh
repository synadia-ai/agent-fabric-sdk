#!/bin/sh
# Build the shared, verified cache from release.json. Build-time requirements:
# Python 3.12+, Git, Go, and the private checkout named by SCRATCHPAD_SRC.
# Runtime consumers need none of those source/build dependencies.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python=${SP_BUILD_PYTHON:-python3}
if [ -z "${SP_BUILD_PYTHON:-}" ] && command -v python3.12 >/dev/null; then python=python3.12; fi
exec "$python" "$here/release.py" build "$@"
