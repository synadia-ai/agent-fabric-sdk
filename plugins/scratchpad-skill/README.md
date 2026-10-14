# ScratchPad skill for harness add-ons

Each harness add-on packages this shared skill and the same published `sp`
executables. No service source checkout or Go compiler is required.

The skill uses `scripts/sp info` for authenticated discovery and configured
allowances. The wrapper supplies the same connection and trace context as for
other commands; discovery preserves the writer workspace. An explicit older
`SCRATCHPAD_BIN` can report this command as unknown. The skill explains that
fallback instead of requiring a new identity or workspace.

- `SKILL.md` teaches the model to use this skill's `scripts/sp` wrapper.
- `scripts/sp` selects the packaged executable and adds the connection,
  persistent workspace, volume, trace, creator, and verified caller context
  from the add-on. It preserves the Fabric identity and grant rules.
  `SCRATCHPAD_BOOTSTRAP_FILE` supplies an exact public creation descriptor on
  `init`; the wrapper owns `--bootstrap-file` and derives the volume through
  the compatible command line. Preserve the file and the private workspace.
- `release.json` pins the release, distribution repository, opaque source
  and toolchain identifiers, and all four archive and executable hashes.
- `load-sp.mjs` downloads and verifies those archives with Node 20+.
  Cached archives receive the same checks before reuse. Invalid bytes,
  members, build identities, or license text stop packaging.
- `install.sh` runs from each add-on's `npm run build:sp` and `prepack`.
  It installs the skill, wrapper, four binaries, `bin/BUILD.json`,
  `bin/COMMIT`, full `LICENSE`, and `THIRD_PARTY_NOTICES`.
  `--dest` selects a directory inside the add-on; `--allowed-tools` adds
  Claude Code's exact wrapper permission to the generated skill.
- `get-sp.sh` installs one explicit standalone release during onboarding
  or image creation. It uses public HTTPS or explicit `--download gh`
  authentication. Tool calls never invoke it.

For local or offline packaging, set `SP_RELEASE_SOURCE_DIR` to the directory
with the four pinned archives. The loader also accepts `--source-dir`.
That directory must contain the bytes named by `release.json`; this option
does not bypass any checks. `SP_RELEASE_DOWNLOAD=gh` selects authenticated
downloads while repository access requires authentication.

The wrapper tests are in `plugins/pi/test/unit/scripts-sp.test.ts`.
The source-independent distribution suite requires the TypeScript SDK and
**all three harness add-ons to be built first**. Follow the
[build-and-test commands](../../docs/scratchpad-binaries.md#checks-and-release-boundary)
from the repository root. The add-ons' `prepack` hook installs the skill and
`sp` binaries; it does not compile their TypeScript.

It verifies real release archives, both standalone download modes, refusal
controls, and all three actual npm archives. It compares complete generated
skills and checks shared recovery instructions against the standalone skill.

Self-contained harness bundles also run the installer on every build. An
existing executable is not evidence that its release matches the selected
manifest. Verified download caches can be reused; the selected skill and
binary installation are regenerated together.

The [binary guide](../../docs/scratchpad-binaries.md) describes installation,
cache behavior, licensing, and the indexed verification commands.
