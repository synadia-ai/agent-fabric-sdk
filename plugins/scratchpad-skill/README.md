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
  refuses those flags from the model.
- `build-sp.sh`: builds sp from ScratchPad's repository at the pinned commit
  for darwin and linux on arm64 and amd64, into `bin/` (gitignored).
- `install.sh`: run from an add-on's directory (its `npm run build:sp`, and
  `prepack`), builds sp and copies the skill and the binaries into the
  add-on's `skill/scratchpad`, which the add-on packages. `--dest` puts
  them elsewhere (Claude Code's `skills/scratchpad`), and
  `--allowed-tools <rule>` adds that line to the copy's front matter
  (Claude Code's, so `scripts/sp` runs without a permission question;
  `docs/plugins.md` §9.13).

The tests of `scripts/sp` are in `plugins/pi/test/unit/scripts-sp.test.ts`.
