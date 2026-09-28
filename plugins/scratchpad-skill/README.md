# ScratchPad's skill, for the harness add-ons

The one skill every add-on under `plugins/` ships (`docs/plugins.md` §9.1),
so a harness's model uses ScratchPad through its shell tool:

- `SKILL.md`: ScratchPad's skill, adapted for an agent on the fabric: every
  command is this skill's `scripts/sp`, and no connection flag is passed.
- `scripts/sp`: the wrapper the model runs. It picks the sp binary for the
  machine and adds the connection, the workspace, the volume on `init`, the
  served prompt's trace, the creator and, on a grant or after a
  publication, the served prompt's verified caller, all from the
  environment the add-on sets, or from the file `SP_ENV_FILE` names where
  the add-on cannot set the shell tool's environment (Claude Code's). It
  refuses those flags from the model, and records each grant sp confirms in
  `SP_GRANTS_FILE`, from which the add-on answers grant requests
  (`docs/plugins.md` §9.14).
- `release.json`: the shared release, source, toolchain, target, and dependency pin.
- `build-sp.sh`: builds sp from a clean archive of that commit for darwin
  and linux on arm64 and amd64, into `bin/` (gitignored). Cached file
  hashes, settings, and Go build information are verified before reuse.
- `release-sp.sh`: packages those same executable bytes in versioned,
  allowlisted standalone archives with provenance, checksums, the generic
  skill, and dependency notices.
- `get-sp.sh`: explicitly downloads and verifies one selected release
  during onboarding or image creation. It requires authenticated access
  to this repository; the harness wrapper never invokes it.
- `install.sh`: run from an add-on's directory (its `npm run build:sp`, and
  `prepack`), builds sp and copies the skill and the binaries into the
  add-on's `skill/scratchpad`, which the add-on packages. `--dest` puts
  them elsewhere (Claude Code's `skills/scratchpad`), and
  `--allowed-tools <rule>` adds that line to the copy's front matter
  (Claude Code's, so `scripts/sp` runs without a permission question;
  `docs/plugins.md` §9.13).

The tests of `scripts/sp` are in `plugins/pi/test/unit/scripts-sp.test.ts`.
Packaging and installer checks are in `tests/test_release.py`.
They compare the shared recovery guidance with the generic skill from the pinned source.
They also inspect actual PI, OpenClaw, and Claude Code package archives.
Each generated skill must match this source, apart from Claude Code's added permission field.
Every packaged executable must match the release cache.
The [binary distribution guide](../../docs/scratchpad-binaries.md) indexes
their commands, release contents, and qualification requirements.
