# ScratchPad skill for harness add-ons

Each harness add-on packages this shared skill and the same published `sp`
executables. No service source checkout or Go compiler is required.

- `SKILL.md` teaches the model to use this skill's `scripts/sp` wrapper.
- `scripts/sp` selects the packaged executable and adds the connection,
  persistent workspace, volume, trace, creator, and verified caller context
  from the add-on. It preserves the Fabric identity and grant rules.
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
The source-independent distribution suite is
`node --test plugins/scratchpad-skill/tests/distribution.test.mjs`.
It verifies real release archives, both standalone download modes, refusal
controls, and all three actual npm archives. It compares complete generated
skills and checks shared recovery instructions against the standalone skill.

The [binary guide](../../docs/scratchpad-binaries.md) describes installation,
cache behavior, licensing, and the indexed verification commands.
