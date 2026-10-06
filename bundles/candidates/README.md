# Prepared harness bundle releases

These manifests identify built release candidates by exact source commits and asset checksums.
Candidate preparation does not publish a release or change an installed agent.
The release owner reviews the candidate PR before publication.

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
The shared release manifest selects and verifies `sp-v0.1.6`.
For authenticated downloads, use `SP_RELEASE_DOWNLOAD=gh`; offline builds can use `SP_RELEASE_SOURCE_DIR`.

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
