# Prepared harness bundle releases

These manifests identify built release candidates by exact source commits and asset checksums.
Candidate preparation does not publish a release or change an installed agent.
The release owner reviews the candidate PR before publication.

## ScratchPad's sp-v0.1.8, the add-ons 0.3.3

[bundles-v0.1.6.json](bundles-v0.1.6.json) describes the prepared `bundles-v0.1.6` assets.
The protocol source is unchanged from `bundles-v0.1.5`: `synadia-agents` main at `ed9aefb`.
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7.
The Fabric source is `b17e56a`: the three add-ons at 0.3.3; each ships ScratchPad's `sp-v0.1.8` and its skill, which teaches `read --text` windows, `list`, the 24-hour retention of a publication without `--ttl-seconds`, the 8 retention slots of a volume and `maintain --apply`, `release`, and the `outcome` class of every error; `scripts/sp` refuses `--workflow` (#90).
ScratchPad is `sp-v0.1.8`, before `sp-v0.1.6`; going back is limited, as `docs/scratchpad-binaries.md` says.
The archives hold the members of `bundles-v0.1.5`'s, with the same names, types and modes, and their compiled code is unchanged.
What differs is the skill (`SKILL.md`, `scripts/sp`, the four `sp` executables, `BUILD.json`, `COMMIT`), `BUILD`, each package's `package.json`, and Claude Code's plugin and marketplace manifests, whose versions name the new commit.
Each archive's `bin/BUILD.json` names `sp-v0.1.8`, and its four executables match the release's hashes.
At `b17e56a`, the fabric package's and the three add-ons' typecheck, lint, format check and tests pass, and so do `load-sp.mjs verify` and the distribution suite.
Each npm package holds its archive's plugin folder file for file, and none has dependencies.
The archives are `build.sh`'s, repacked with the headers above and without the build's pax headers; their members and bytes are the build's.
Not yet checked against a test deployment: an agent's ScratchPad round trip with `sp-v0.1.8` (`init` with the volume, `publish-file`, `read`) is owed before publication.

## OpenClaw's stop and the add-ons' own sp, the add-ons 0.3.2

[bundles-v0.1.5.json](bundles-v0.1.5.json) describes the prepared `bundles-v0.1.5` assets.
The protocol source is `synadia-agents` main at `ed9aefb` (#241): OpenClaw's channel stops within about 3 s, inside the 5 s OpenClaw gives it; its cleanup runs once with every step bounded, a stop during a service start takes that service down too, OpenClaw's abort ends a start that never settles, and a stale start touches nothing of a newer one's.
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7.
The Fabric source is `983c4c3`: the three add-ons at 0.3.2; each finds its own `sp` as the first executable of `SCRATCHPAD_BIN`, then the binary it ships; without one it warns once, removes every reference with a note, refuses a prompt of references alone and answers no grant request; a `SCRATCHPAD_BIN` it cannot use is warned about (#88).
ScratchPad is unchanged from `bundles-v0.1.4`: `sp-v0.1.6`.
Checked before publication with fabric v0.12.4 against a test deployment, in a copy of a test home: its migration set the five settings that keep an OpenClaw agent to NATS prompts in the copy's OpenClaw agent, its other settings kept; each archive installed with `fabric plugins install --from`; a pi, an OpenClaw and a Claude Code agent connected with `fabric connect`, run the CLI's way, signed, each answering a console prompt, OpenClaw a second one too.
The new OpenClaw agent's config held the same five settings, and three minutes idle after its turns left no task of it without a caller.
Stopped with Ctrl-C four times, the OpenClaw gateway exited 0.6 s to 1.5 s after the signal, its connection drained, with none of OpenClaw's lines for a stop past its 5 s bound.
The test deployment gave the agents no ScratchPad volume; started with a volume named and `SCRATCHPAD_BIN` naming no file, each add-on warned that it passes the variable over and runs the `sp` its bundle ships, and none said it had no `sp` (Claude Code's, read from its bundle's server started as its `.mcp.json` starts it, since Claude Code keeps only the server's first line of output).
A turn typed at pi and at Claude Code each made one task rooted at the typed agent, with OpenClaw's thread beneath; Claude Code's stored model calls name its requests `<8 hex>-<n>`.
Each npm package holds its archive's plugin folder file for file.
The archives are `build.sh`'s, repacked with the headers above and without the build's pax headers; their members and bytes are the build's.

## OpenClaw's error replies, the add-ons 0.3.1

[bundles-v0.1.4.json](bundles-v0.1.4.json) describes the prepared `bundles-v0.1.4` assets.
The protocol source is `synadia-agents` main at `a204518` (#240): OpenClaw's channel ends a prompt whose run ended on a reply OpenClaw marked as an error with `500 OpenClaw replied with an error: <text>`, no longer as a reply; Claude Code's request ids are `<8 hex>-<n>`, unique per server start, with no wall-clock guards, and a new Claude Code process clears its pid's earlier hook files at startup; `docs/agent-tools.md` §7 says a result counts the calls open when it is built.
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7.
The Fabric source is `95f67d6`: the three add-ons at 0.3.1; OpenClaw's served `end` carries the reason `no_reply` in that case (#84).
ScratchPad is unchanged from `bundles-v0.1.3`: `sp-v0.1.6`.
Checked before publication with fabric v0.12.3 against a test deployment, in a copy of a test home: each archive installed with `fabric plugins install --from`; a pi, an OpenClaw and a Claude Code agent connected with `fabric connect`, run the CLI's way, signed, each answering a console prompt.
An OpenClaw turn the model proxy refused with `400` ended the console's prompt with the `500` error frame and no reply, its thread `error` and its served `end` with the reason `no_reply`; pi's and Claude Code's `prompt_agent` to it returned `failed` with the same error.
A turn typed at pi and at Claude Code each made one task rooted at the typed agent, with OpenClaw's thread beneath; Claude Code's stored model calls name its requests `<8 hex>-<n>`; a console prompt folded into a running Claude Code turn got its own reply, and the typed task kept its call from before the fold.
Each npm package holds its archive's plugin folder file for file.
The archives are `build.sh`'s, repacked with the headers above and without the build's pax headers; their members and bytes are the build's.

## Typed turns as tasks, the add-ons 0.3.0

[bundles-v0.1.3.json](bundles-v0.1.3.json) describes the prepared `bundles-v0.1.3` assets.
The protocol source is `synadia-agents` main at `1ed73c1`: an explicit server in the environment beats a remembered context (#238); pi and Claude Code report a turn no NATS prompt started as a local turn, and Claude Code's channel follows its turns by prompt id and ends a prompt at once on a model API error (#239).
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7 (#234, first bundled here).
The Fabric source is `e770d25`: the three add-ons at 0.3.0; a turn typed at pi or Claude Code is a task of its own, with the agents it prompts beneath it (#82); `sp` takes the connection the channel takes (#81); ScratchPad's reusable lifetimes, bootstrap import and admission slots (#67, #68, #69); the Claude Code marketplace range is `^0.3.0`.
ScratchPad is unchanged from `bundles-v0.1.2`: `sp-v0.1.6`.
Checked before publication with fabric v0.12.2 against a test deployment, in a copy of a test home: each archive installed with `fabric plugins install --from`; a pi, an OpenClaw and a Claude Code agent connected with `fabric connect`, run the CLI's way, signed, each answering a console prompt; a turn typed at pi and at Claude Code each made one task rooted at the typed agent, its model calls in it and OpenClaw's thread beneath; a console prompt folded into a running Claude Code turn got its own reply, and the typed task kept its call from before the fold.
Each npm package holds its archive's plugin folder file for file.
The archives are `build.sh`'s, repacked with the headers above; their members and bytes are the build's.
The repack also leaves out the build's pax headers (macOS provenance attributes and fractional times), as `bundles-v0.1.2`'s archives hold none.

## The channels from the environment, the whole-plugin packages

[bundles-v0.1.2.json](bundles-v0.1.2.json) describes the prepared `bundles-v0.1.2` assets.
The protocol source is `synadia-agents` main at `554414d`: the pi and Claude Code channels connect with `NATS_URL` and `NATS_CREDS` when no context is set (#233), and Claude Code's channel is 0.6.0.
The Fabric source is `bbd3128`: each bundle is also the npm package of its harness (#63, #64), and pi's and OpenClaw's manifests name an entry that loads the bundled add-on unless an extension variable is set.
The fabric CLI is unaffected: it sets the variable and a NATS context, which wins, and it starts the files it always started.
ScratchPad is unchanged from `bundles-v0.1.1`: `sp-v0.1.6`.
Checked before publication: each archive installed with `fabric install-plugins` (v0.8.0), a pi and an OpenClaw agent connected with `fabric connect`, run the CLI's way against a test deployment, signed, the add-on loaded, each answering a console prompt through another agent; Claude Code's bundle installed in the CLI's layout.
The archives are `build.sh`'s, repacked with the headers above; their members and bytes are the build's.

## ScratchPad 0.1.6 refresh

[bundles-v0.1.1.json](bundles-v0.1.1.json) describes the prepared `bundles-v0.1.1` assets.
The protocol source matches the existing `bundles-v0.1.0` release.
The Fabric source includes the shared skill and verified binary selection for `sp-v0.1.6`.
All three bundles carry the same four selected executables and matching skill.
The manifest's Fabric commit is the build source; the later candidate-documentation commit changes no compiled code.

The `sp info` command reports the authenticated principal, owned scope allowances, and request limits before workspace initialization.
Version 0.1.6 includes `info` in the command list and adds local JSON usage for `sp info --help`.
The command list remains a usage refusal on stderr with exit status 2; the local `info` help succeeds on stdout.
Existing publication, grant, read, hydration, and recovery commands keep their contracts.
No volume format or identity changes are part of this refresh.

## Reproduce preparation

Use isolated checkouts of the two commits recorded in the manifest.
Build from clean trees; `build.sh` records `HEAD` without checking for local changes.
Name the isolated protocol checkout's branch `main`, as the existing build script requires.
This branch name does not select a newer commit; verify the full recorded commit before building.
Use the matching protocol checkout next to the SDK checkout, as the development instructions describe.
Build with `sh bundles/build.sh all /absolute/candidate-directory`.
The shared release manifest at the recorded Fabric commit selects and verifies the ScratchPad release the candidate manifest names.
`SP_RELEASE_DOWNLOAD=gh` downloads through the GitHub CLI instead; offline builds can use `SP_RELEASE_SOURCE_DIR`.

Archive names record both source revisions.
Build times, archive member times and ownership, and compression headers can vary across builds.
The candidate manifest identifies these prepared bytes; it makes no reproducible-build promise.
Prepared archives normalize numeric owner IDs to zero, owner names to empty strings, and archive member times to zero.
The compression header time is also zero.
Normalization preserves member names, types, modes, sizes, link targets and every regular-file payload digest.
The existing build script emits native archive headers; candidate preparation removes those headers before review.
Publish the reviewed candidate bytes; do not silently replace them with a later build.

## Review and publication

1. Compare all three archives and `SHA256SUMS` with the candidate manifest.
2. Verify twelve executable hashes, complete matching skills, wrappers, notices, license text, and plugin metadata.
3. Run the SDK and three add-on suites against the selected protocol checkout.
4. Run the distribution checks against actual release archives and all three npm packages.
5. Obtain release-owner approval for these exact assets.
6. Publish the exact reviewed archives without rebuilding, with the new tag at the recorded Fabric commit.
7. Verify a fresh download against the manifest.

Existing release assets remain immutable.
Publication does not rebuild shared images or replace existing installed agents.
Installer and deployment adoption remain explicit actions.
