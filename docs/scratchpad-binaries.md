# Standalone ScratchPad binaries

Use a compiled `sp` client when an agent has a shell or an image builder can
install an executable. Native TypeScript and Python agents can use the
[native client](scratchpad-native.md) instead.

The release channel is `synadia-ai/agent-fabric-sdk`, under tags such as
`sp-v0.1.0`. This private preview requires authenticated access to that
repository. Installation needs no private ScratchPad checkout or Go compiler.
The [delivery issue](https://github.com/synadia-ai/agent-fabric-sdk/issues/29)
records qualification and publication.

## Install an explicit release

Use the version your operator selected. The installer in this repository is
[get-sp.sh](../plugins/scratchpad-skill/get-sp.sh). Run it during onboarding
or image creation. Harness tool calls use their packaged binary and do not
download one at runtime.

The installer needs authenticated `gh` access to this repository, `tar`, and
`sha256sum` or `shasum`. It selects the current Linux or macOS processor, or
accepts an explicit `--target` for an image build. The destination must be a
new absolute directory; installation preserves existing directories.

```sh
sh plugins/scratchpad-skill/get-sp.sh --version sp-v0.1.0 --dest "$HOME/.local/share/scratchpad/sp-v0.1.0"
```

For an agent with no checkout, download `get-sp.sh` and `SHA256SUMS` from the
same selected GitHub release. Verify the script's SHA-256 against its single
entry in `SHA256SUMS`, then run the command above with that script's path.
The installer verifies the selected archive, its regular-file allowlist,
version, target, source metadata, and executable hash before installing it.
GitHub authenticates the release source; checksums detect changed bytes.

Put the installed directory on PATH or invoke its `sp` by absolute path.
Keep its `SOURCE`, `BUILD.json`, `SKILL.md`, `README.md`, and
`THIRD_PARTY_NOTICES` beside the executable. `SOURCE` and `BUILD.json`
identify its exact revision and toolchain; `sp` has no version flag.

Use the agent's existing NATS credentials. Give each writer a private
persistent workspace and preserve it across restarts. The standalone skill
uses explicit connection flags. Harness agents retain their `scripts/sp`
wrapper, which supplies Fabric connection and caller context.

For Linux containers on macOS, put the workspace on a Docker-managed
volume. In local qualification, a macOS-shared bind mount failed the CLI's
spool directory identity check; the same Linux arm64 executable passed on
a Docker volume. Preserve that volume across process and container restarts.
The identity check protects recovery state and must remain enabled.

The pinned CLI can retain a pending operation after an upload exceeds its
byte quota. See [the recorded limitation](https://github.com/synadia-ai/scratchpad/issues/1160)
and the skill's explicit recovery procedure. Adapters do not reset uncertain
operations automatically.

## One build supplies both channels

[release.json](../plugins/scratchpad-skill/release.json) is the source of
truth for the release tag, full private source commit, Go version, target
set, build flags, and reviewed dependency versions. Change that file to
advance the pin. A conflicting `SP_COMMIT` override is refused.

Build tooling needs Python 3.12+, Git, and Go. It prefers `python3.12` when
available; `SP_BUILD_PYTHON` selects another interpreter. Go uses the exact
toolchain in the pin. The private checkout can contain unrelated work:
build inputs come only from `git archive` of the selected commit.

```sh
SCRATCHPAD_SRC=/absolute/private/scratchpad sh plugins/scratchpad-skill/build-sp.sh
SCRATCHPAD_SRC=/absolute/private/scratchpad sh plugins/scratchpad-skill/release-sp.sh
python3.12 plugins/scratchpad-skill/release.py verify
```

The shared `bin/` cache contains the four executables, hashes, source/build
metadata, canonical standalone skill, and dependency notices. The builder
checks all cached bytes and settings before reuse. Each harness's existing
`npm run build:sp` copies the same executable bytes and notices.
Run shared builds serially; a concurrent build refuses the occupied cache lock.

Standalone output is `plugins/scratchpad-skill/dist/sp-v0.1.0/`:

```text
sp-v0.1.0-darwin-arm64.tar.gz
sp-v0.1.0-darwin-amd64.tar.gz
sp-v0.1.0-linux-arm64.tar.gz
sp-v0.1.0-linux-amd64.tar.gz
release.json
SHA256SUMS
get-sp.sh
```

Each archive contains exactly six regular files: `sp`, `SOURCE`,
`BUILD.json`, `SKILL.md`, `README.md`, and `THIRD_PARTY_NOTICES`.
The archive packer does not copy source trees, credentials, fixtures, or
repository history. The generic skill comes from the pinned private source
with its repository-only links replaced by local instructions. Its original
hash is recorded in `BUILD.json`.

Dependency notices come from the actual linked module closure and Go's
runtime license. They include the owned nats.go replacement notice.
They do not assign a license to the private ScratchPad code. The SDK
repository's source license does not determine the executable's license.

## Checks and release boundary

These commands index the packaging checks:

```sh
python3.12 -m unittest discover -s plugins/scratchpad-skill/tests -p test_release.py -v
python3.12 plugins/scratchpad-skill/release.py verify
```

The tests corrupt cache bytes, archive checksums, provenance, and archive
membership and require refusal. They exercise installation through a test
double for the external GitHub CLI and compare installed executables with
the built cache. They do not establish that a GitHub release is published.

The real-service artifact check is indexed here:

```sh
uv run --script plugins/scratchpad-skill/tests/qualify-artifact.py run \
  --core-root /absolute/clean/scratchpad \
  --archive plugins/scratchpad-skill/dist/sp-v0.1.0/sp-v0.1.0-darwin-arm64.tar.gz \
  --target darwin-arm64 --evidence /absolute/new/evidence-directory
```

The core checkout must be clean and match the binary's source commit.
The controller builds a separate real-service fixture. Each CLI invocation
runs with no tools on PATH. Linux workflows use Docker-managed workspaces.
The `workflow` subcommand also accepts an already built fixture, executable,
and SDK test adapter for qualification on a native Linux host.

### Recorded artifact qualification

The [public report](evidence/sp-v0.1.0-qualification.json) binds all four
observed executable hashes to the exact release archives. It records 48
CLI commands, one actual dropped publication reply per target, a service
restart, exact receipt and byte recovery, access refusal, and directory
hydration with executable modes and a symlink.

| Target | Execution environment |
| --- | --- |
| darwin/arm64 | Native macOS arm64 |
| darwin/amd64 | Rosetta on macOS arm64 |
| linux/arm64 | Native arm64 Docker VM |
| linux/amd64 | Native amd64 Docker on `omarx1` |

The amd64 service fixture crashed under Docker emulation before the CLI
ran. The native amd64 run supplies that target's evidence. These runs use
a real single-server service fixture; three-server Fabric integration and
sustained capacity are separate checks.

Before publication, use each extracted artifact for publication, a granted
byte-exact read, an unauthorized read refusal, and recovery after a lost
publication reply. Qualify the directory workflow on the advertised targets
as well. Record macOS amd64 runs under Rosetta and Linux amd64 runs under
Docker emulation as such. A Linux amd64 check can instead use a native
Linux amd64 host. Native Windows is outside this target set.

Publish from a reviewed SDK commit and retain the recorded packaging file
hashes. The manifest marks builds from uncommitted packaging sources.
Use a new version for changes to a published release; do not replace its
assets. `--replace` refreshes metadata only when existing candidate assets
still match the current packaging inputs. After changing those inputs,
retain the old candidate and choose a new `--output` directory.
After publication, download through the documented authenticated channel
and verify the retrieved artifact. Repository visibility stays unchanged.
