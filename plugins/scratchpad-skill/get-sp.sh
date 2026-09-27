#!/bin/sh
# Explicit onboarding/image-build install from the private SDK release channel.
# Requires authenticated gh access, tar, and sha256sum or shasum. No runtime fetch.
set -eu
umask 077

fail() { echo "get-sp: $*" >&2; exit 1; }
version=
destination=
target=
while [ $# -gt 0 ]; do
  case $1 in
    --version | --dest | --target)
      [ $# -ge 2 ] && [ -n "$2" ] || fail "missing value for $1"
      case $1 in
        --version) [ -z "$version" ] || fail "duplicate --version"; version=$2 ;;
        --dest) [ -z "$destination" ] || fail "duplicate --dest"; destination=$2 ;;
        --target) [ -z "$target" ] || fail "duplicate --target"; target=$2 ;;
      esac
      shift 2
      ;;
    *) fail "usage: get-sp.sh --version sp-vX.Y.Z --dest /new/absolute/directory [--target linux/amd64]" ;;
  esac
done
printf '%s\n' "$version" | grep -Eq '^sp-v[0-9]+\.[0-9]+\.[0-9]+$' || fail "an explicit sp-vX.Y.Z version is required"
case $destination in /*) ;; *) fail "--dest must be a new absolute directory" ;; esac
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "destination already exists; select a new directory"
if [ -z "$target" ]; then
  case $(uname -s) in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "unsupported operating system" ;; esac
  case $(uname -m) in arm64 | aarch64) arch=arm64 ;; x86_64 | amd64) arch=amd64 ;; *) fail "unsupported processor architecture" ;; esac
  target=$os/$arch
fi
case $target in darwin/arm64 | darwin/amd64 | linux/arm64 | linux/amd64) ;; *) fail "unsupported target $target" ;; esac
command -v gh >/dev/null || fail "GitHub CLI (gh) is required; authenticate for synadia-ai/agent-fabric-sdk"
command -v tar >/dev/null || fail "tar is required"
if command -v sha256sum >/dev/null; then
  hash() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null; then
  hash() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  fail "sha256sum or shasum is required"
fi

parent=$(dirname -- "$destination")
# Newly created image paths must be traversable by a non-root runtime user.
# Existing parent permissions remain the operator's choice; staging stays private.
(umask 022; mkdir -p "$parent")
stage=$(mktemp -d "$parent/.sp-install.XXXXXX")
trap 'rm -rf "$stage"' 0
trap 'exit 1' 1 2 15
mkdir "$stage/download" "$stage/package"
asset=$version-${target%/*}-${target#*/}.tar.gz
GH_HOST=github.com gh release download "$version" --repo synadia-ai/agent-fabric-sdk \
  --pattern "$asset" --pattern SHA256SUMS --dir "$stage/download"
archive=$stage/download/$asset
[ -f "$archive" ] && [ -f "$stage/download/SHA256SUMS" ] || fail "release assets are missing"
expected=$(awk -v file="$asset" '$2 == file { print $1; count++ } END { if (count != 1) exit 1 }' "$stage/download/SHA256SUMS") || fail "checksum entry is missing or duplicated"
case $expected in '' | *[!0-9a-f]*) fail "invalid archive checksum" ;; esac
[ "${#expected}" -eq 64 ] || fail "invalid archive checksum length"
[ "$(hash "$archive")" = "$expected" ] || fail "archive checksum differs"

# Fixed regular-file membership is checked before extraction. There are no
# links, source trees, credentials, or destination paths in this format.
cat >"$stage/expected" <<'FILES'
BUILD.json
README.md
SKILL.md
SOURCE
THIRD_PARTY_NOTICES
sp
FILES
tar -tzf "$archive" >"$stage/members" || fail "archive cannot be listed"
LC_ALL=C sort "$stage/members" >"$stage/sorted"
cmp -s "$stage/expected" "$stage/sorted" || fail "archive file allowlist differs"
tar -tvzf "$archive" >"$stage/types" || fail "archive types cannot be listed"
awk 'substr($0, 1, 1) != "-" { exit 1 } { count++ } END { if (count != 6) exit 1 }' "$stage/types" || fail "archive contains a non-regular member"
tar -xzf "$archive" -C "$stage/package" --no-same-owner --no-same-permissions

record_release=
record_source=
record_go=
record_target=
record_hash=
while IFS='=' read -r name value; do
  case $name in
    release) [ -z "$record_release" ] || fail "duplicate source field"; record_release=$value ;;
    source_commit) [ -z "$record_source" ] || fail "duplicate source field"; record_source=$value ;;
    go_version) [ -z "$record_go" ] || fail "duplicate source field"; record_go=$value ;;
    target) [ -z "$record_target" ] || fail "duplicate source field"; record_target=$value ;;
    binary_sha256) [ -z "$record_hash" ] || fail "duplicate source field"; record_hash=$value ;;
    *) fail "unexpected source field" ;;
  esac
done <"$stage/package/SOURCE"
[ "$record_release" = "$version" ] && [ "$record_target" = "$target" ] || fail "archive release or target differs"
printf '%s\n' "$record_source" | grep -Eq '^[0-9a-f]{40}$' || fail "invalid source commit"
printf '%s\n' "$record_go" | grep -Eq '^go[0-9]+\.[0-9]+\.[0-9]+$' || fail "invalid Go version"
printf '%s\n' "$record_hash" | grep -Eq '^[0-9a-f]{64}$' || fail "invalid binary checksum"
[ "$(hash "$stage/package/sp")" = "$record_hash" ] || fail "binary checksum differs"
chmod 755 "$stage/package/sp" "$stage/package"
chmod 644 "$stage/package/BUILD.json" "$stage/package/SOURCE" "$stage/package/SKILL.md" \
  "$stage/package/README.md" "$stage/package/THIRD_PARTY_NOTICES"
# Recheck immediately before moving the complete install into place.
[ ! -e "$destination" ] && [ ! -L "$destination" ] || fail "destination appeared during download"
mv "$stage/package" "$destination"
printf 'Installed %s for %s at %s\nSource: %s\nSHA-256: %s\n' "$version" "$target" "$destination/sp" "$record_source" "$record_hash"
