# ScratchPad binaries

Use the compiled `sp` client when an agent has a shell or an image builder
can install an executable. TypeScript and Python agents can use the
[native client](scratchpad-native.md).

The binary release channel is
[agent-fabric-sdk releases](https://github.com/synadia-ai/agent-fabric-sdk/releases),
with explicit tags such as `sp-v0.1.5`. The binaries and included skills
use Apache-2.0. Each archive includes the full `LICENSE` and
`THIRD_PARTY_NOTICES`. Installation and harness packaging need no Go compiler
or service source checkout.

## Install an explicit release

Run [get-sp.sh](../plugins/scratchpad-skill/get-sp.sh) during onboarding or
image creation. It needs a POSIX shell, `curl`, `tar`, and `sha256sum` or
`shasum`. Downloads use HTTPS. `--download gh` downloads through the
GitHub CLI instead.

```sh
: "${VERSION:?Set the operator-selected sp release}"
sh plugins/scratchpad-skill/get-sp.sh --version "$VERSION" --dest "$HOME/.local/share/scratchpad/$VERSION"
```

The installer selects the host's Linux or macOS target. Use
`--target linux/amd64`, `linux/arm64`, `darwin/amd64`, or `darwin/arm64`
to select another target for an image. The destination must be a new
absolute directory. Existing destinations remain intact.

Publishing a release does not replace an agent's installed executable or skill.
Harness builds select one release through the shared manifest and install its
verified binaries and matching skill together. `sp info` discovers the current
principal, owned scope allowances, and request limits without opening a writer
workspace. Existing publication, grant, read, and recovery commands remain
compatible. If an explicit `SCRATCHPAD_BIN` selects an older executable that
reports `info` as unknown, continue with its existing commands and obtain the
allowances from the operator.

Without a checkout, download `get-sp.sh` and `SHA256SUMS` from the selected
release. Verify the script against its single checksum entry before running
it. The installer downloads the selected archive and checks its SHA-256,
seven regular-file members, release tag, target, source identifier,
toolchain identifier, and executable hash before installation.
Checksums detect changed bytes; the HTTPS release channel supplies the
expected checksums.

Each archive contains exactly these seven regular files:

```text
sp
SOURCE
BUILD.json
SKILL.md
README.md
THIRD_PARTY_NOTICES
LICENSE
```

Keep these files together. `SOURCE` and `BUILD.json` identify the release,
opaque source revision, toolchain, target, and executable bytes.
`BUILD.json` also records public Go module metadata and licensing.
The command has no version flag. Put the installed directory on PATH or
invoke its `sp` by absolute path.

Use the agent's existing NATS credentials and a private persistent writer
workspace. The standalone skill uses explicit connection flags. Harness
agents use `scripts/sp`, which supplies their Fabric connection and caller
context. Tool calls use packaged binaries and never download them.

For Linux containers on macOS, use a Docker-managed workspace volume.
A shared macOS bind mount can fail the spool directory identity check.
Preserve the workspace across process and container restarts.

## Package the harness add-ons

[release.json](../plugins/scratchpad-skill/release.json) pins the release,
distribution repository, source and toolchain identifiers, and the archive
and executable hashes for all four supported targets. Advance these pins
together when selecting a new release.

Each add-on's `npm run build:sp` and `npm pack` run the shared
[install.sh](../plugins/scratchpad-skill/install.sh). The loader needs Node
20 or newer. It downloads the four selected archives over HTTPS, verifies
them against the checked-in manifest, and installs identical executable
bytes, license text, and dependency notices into PI, OpenClaw, and Claude
Code. `SP_RELEASE_DOWNLOAD=gh` downloads through the GitHub CLI instead.

The loader checks every cached archive again before reuse, including its
member types, identities, full license, and executable hash. It rejects a
damaged cache. Remove that release's directory under
`plugins/scratchpad-skill/downloads/` to fetch a fresh copy.
`SP_RELEASE_CACHE_DIR` selects another cache parent. Concurrent use of the
same cache fails with an error that names the lock directory; run packaging
steps in sequence. After an interrupted run, confirm that no packaging
process is running before removing that lock. Verified downloads enter the
cache by a rename, so an interrupted write cannot leave a partial archive
at its published filename.

For offline packaging, set `SP_RELEASE_SOURCE_DIR` to a directory containing
the four release archives. An explicit `--source-dir` option is also
available on `install.sh` and `load-sp.mjs`. This path uses the same
checked-in hashes and archive checks as downloads. It cannot select another
release or bypass verification. Missing or altered files stop packaging.

```sh
SP_RELEASE_SOURCE_DIR=/absolute/release-assets npm run build:sp
```

Run that command from the add-on directory. The wrapper and its settings
remain part of the SDK. The binary archives carry no runtime downloader.
Temporary skill copies and backups stay in each add-on's ignored
`.scratchpad-work/` directory, outside the paths its npm package includes.

## Maintained skills and generated copies

| Distribution | Skill source | Installed path |
| --- | --- | --- |
| Standalone | Selected release archive | `SKILL.md` beside `sp` |
| PI | `plugins/scratchpad-skill/SKILL.md` | `plugins/pi/skill/scratchpad/SKILL.md` |
| OpenClaw | Same SDK skill | `plugins/openclaw/skill/scratchpad/SKILL.md` |
| Claude Code | Same SDK skill, with its wrapper permission | `plugins/claude-code/skills/scratchpad/SKILL.md` |

Edit the maintained SDK skill and run `npm run build:sp` to regenerate
the ignored copies. Packaging compares its upload-abandonment guidance
with the selected standalone skill. A pending checkpoint remains protected;
an upload quota refusal does not authorize a writer reset.

## Checks and release boundary

The checks need Node 20+, npm, a POSIX shell, and the standalone installer's
archive and hash tools. They do not need a service checkout or Go.
Set `SP_RELEASE_SOURCE_DIR` for local release candidates or offline checks.

Build the TypeScript SDK and **all three harness add-ons** before running
the distribution suite. It creates real npm archives and checks their
JavaScript entrypoints. The add-ons' `prepack` hook installs the skill and
`sp` binaries; it does not compile the add-ons' TypeScript.

First prepare the linked protocol SDK packages as described in
[the development setup](../CLAUDE.md#the-protocol-sdk-during-development).
Then run this build-and-test sequence from the repository root:

```sh
npm --prefix typescript ci
npm --prefix typescript run build
npm --prefix plugins/pi ci
npm --prefix plugins/pi run build
npm --prefix plugins/openclaw ci
npm --prefix plugins/openclaw run build
npm --prefix plugins/claude-code ci
npm --prefix plugins/claude-code run build

node plugins/scratchpad-skill/load-sp.mjs verify
node --test plugins/scratchpad-skill/tests/distribution.test.mjs
```

After changing an add-on's source, rebuild it before running the suite again.

The suite consumes real release archives and creates all three npm packages.
It compares all twelve packaged executables, skills, metadata, licenses,
notices, and wrappers. It checks the exact skill member set and excludes
deliberately abandoned copies outside each package's included paths.
An orphan inside a packaged skill root must fail that check.
It exercises both installer download modes through
external command doubles with no compiler on PATH. Changed downloads,
unsafe archive members, inconsistent identities, and damaged caches must
fail. A control disables the archive checksum guard and must admit the same
changed archive that the ordinary installer rejects.

These checks establish distribution and packaging behavior. Service
qualification and Fabric integration are separate checks. After publishing
a new tag, run the installer against the actual release and compare the
downloaded binaries with the selected manifest. Published assets keep their
versioned bytes; changes require a new release tag.
