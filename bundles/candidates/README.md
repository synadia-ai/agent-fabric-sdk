# Prepared harness bundle releases

These manifests identify built release candidates by exact source commits and asset checksums.
Candidate preparation does not publish a release or change an installed agent.
The release owner reviews the candidate PR before publication.

## A prompt Claude Code does not take, the add-ons 0.3.6

[bundles-v0.1.9.json](bundles-v0.1.9.json) describes the prepared `bundles-v0.1.9` assets.
The protocol source is `synadia-agents` main at `e16c078` (#259), whose only change since `491b1b8` is Claude Code's channel and its documentation.
Claude Code's channel ends a prompt Claude Code has not taken into a turn within 30 s of idle time with the protocol's error frame, `Nats-Service-Error-Code: 500` and `Claude Code did not take this prompt within 30 s while idle: its channel is likely off. Check: the channels flag, own ANTHROPIC_API_KEY, Yes to the API key question, a workspace-scoped key`, and logs one warning at the first; before, such a prompt stayed open for 5 to 30 minutes.
The bound is `idleTurnStartMs`, which `SYNADIA_CLAUDE_CODE_IDLE_TURN_START_MS` overrides and `0` turns off; the check applies only to Claude Code 2.1.310 or later, by the version its `initialize` gives, with the plugin's hooks running, and stands down once Claude Code has taken one channel message.
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7.
The Fabric source is `879aa22`: the three add-ons at 0.3.6, their own code unchanged from 0.3.5; pi's and OpenClaw's move with the release, since each archive's plugin folder is its npm package at the add-on's version.
ScratchPad is unchanged from `bundles-v0.1.8`: `sp-v0.1.8`.
The archives hold the members of `bundles-v0.1.8`'s, with the same names, types and modes; the chunks of compiled code keep their names.
In Claude Code's archive what differs is the channel's `runtime/server.js` and `hooks/session-event.js`, `BUILD`, `package.json`, and the plugin and marketplace manifests, whose versions name the new commits; in pi's and OpenClaw's, `BUILD` and `package.json` alone, whose version is 0.3.6.
The add-ons' `fabric.js`, the shared chunks, each `README.md` and the whole ScratchPad skill are byte for byte `bundles-v0.1.8`'s.
In Claude Code's archive and npm package, the channel's compiled code holds that description, beside a constant `500` that the untaken prompt is rejected with, the default bound of 30000 ms, the version gate 2.1.310, the warning and `SYNADIA_CLAUDE_CODE_IDLE_TURN_START_MS`; `bundles-v0.1.8`'s holds none of them, and pi's and OpenClaw's hold none.
`bundles-v0.1.8`'s new code, PI's tool lines and `discover_agents`' `filter_note`, is in each archive and each npm package still.
Each archive's `bin/BUILD.json` names `sp-v0.1.8`, and its four executables match the release's hashes.
At `879aa22`, against `synadia-agents` at `e16c078`, the fabric package's and the three add-ons' typecheck, lint, format check and tests pass, and so do `load-sp.mjs verify` and the distribution suite.
Each archive installed with `fabric plugins install --from` into an empty home, with fabric v0.22.0, and each installed folder equals its archive.
Against a NATS server on the build machine alone, with no deployment and no credentials, so unsigned: the Claude Code bundle's server was started as its `.mcp.json` starts it, its hooks run as its `hooks.json` runs them, and spoken to over MCP by a stand-in for Claude Code that took no channel message unless told to.
Given Claude Code 2.1.331 in `initialize`, with the default bound, its prompt was ended 30.7 s after it was sent with the `500` frame and that description, then a clean end; one warning line named Claude Code 2.1.331, `ANTHROPIC_API_KEY`, the channel flags and the `0` setting, and the prompt was logged with the reason `not taken while idle`.
Once the stand-in took a prompt into a turn, it was answered, and a later prompt left untaken for 32.5 s was not ended.
With `SYNADIA_CLAUDE_CODE_IDLE_TURN_START_MS=0`, with Claude Code 2.1.309 given in `initialize`, and without the hooks, a prompt left untaken for 33.7 s was not ended, and the model's reply answered it.
A session of PI 0.85.1 loaded the pi bundle's manifest entry; its system prompt and each agent's `discover_agents`, PI's and the Claude Code bundle server's, behaved as in `bundles-v0.1.8`'s check.
OpenClaw's bundle was not started.
Each npm package holds its archive's plugin folder file for file, and none has dependencies.
The archives are `build.sh`'s, repacked with the headers above and without the build's pax headers; their members and bytes are the build's.
Not yet checked: a Claude Code agent connected to a test deployment with `fabric connect`, its channel off and then on, is owed before publication if the release owner asks for it.

## The agent tools in PI's system prompt, discover_agents' empty result, the add-ons 0.3.5

[bundles-v0.1.8.json](bundles-v0.1.8.json) describes the prepared `bundles-v0.1.8` assets.
The protocol source is `synadia-agents` main at `491b1b8` (#249, #256, #257).
PI's system prompt lists the agent tools, one line each, and names the address other agents reach the session at, with guidelines to reach other agents through `discover_agents` and `prompt_agent`, never shell commands, and to pass `prompt_agent` the address as discovered (#256).
In all three channels, `discover_agents` adds `filter_note` to an empty filtered result, matches a filter whole and ignoring case, takes `""` and `null` as no filter, and refuses a filter that cannot match; its descriptions say a filter is the exact `agent`, `owner` or `name` value an entry lists, which can differ from the address's tokens (#257).
Claude Code's `/nats-channel:configure` reads and writes `config.json` in the channel's state directory, `NATS_STATE_DIR` when it is set, as the fabric CLI sets it (#249).
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7.
The Fabric source is `9c94d78`: the three add-ons at 0.3.5, their own code unchanged from 0.3.4.
ScratchPad is unchanged from `bundles-v0.1.7`: `sp-v0.1.8`.
The archives hold the members of `bundles-v0.1.7`'s, with the same types and modes, but for the chunks of compiled code, which are named by their content: one in pi's and Claude Code's archives, two in OpenClaw's.
What differs in substance is the shared chunk that holds the protocol SDK, in all three, pi's `nats-channel.js`, and Claude Code's `configure` skill (`SKILL.md`, `list-contexts.sh`); the other compiled files, the add-ons' `fabric.js` among them, are `bundles-v0.1.7`'s but for the chunk names they import.
`BUILD`, each package's `package.json`, and Claude Code's plugin and marketplace manifests name the new versions and commits; each `README.md` and the whole ScratchPad skill are byte for byte `bundles-v0.1.7`'s.
In each archive and each npm package, the compiled code holds `filter_note`, the new descriptions and the new refusal, and none of the old `discover_agents` words; pi's also holds the three snippets and the guidelines.
Each archive's `bin/BUILD.json` names `sp-v0.1.8`, and its four executables match the release's hashes.
At `9c94d78`, against `synadia-agents` at `491b1b8`, the fabric package's and the three add-ons' typecheck, lint, format check and tests pass, and so do `load-sp.mjs verify` and the distribution suite.
Each archive installed with `fabric plugins install --from` into an empty home, with fabric v0.21.0, and each installed folder equals its archive.
Against a NATS server on the build machine alone, with no deployment and no credentials, so unsigned: a session of PI 0.85.1 loaded the pi bundle's manifest entry, and the Claude Code bundle's server started as its `.mcp.json` starts it, spoken to over MCP.
PI's system prompt listed the three blocking tools with their snippets and named the session's address once, with the three guidelines.
Through each agent's own `discover_agents`, the other was listed; a filter that matched nothing returned `filter_note`; an owner in capitals, an empty name, a null owner and an agent in capitals matched; the address's token `cc` matched no agent, whose listed `agent` is `claude-code`; an owner with a dot, a name with a space and an agent that is an address were refused with the new words.
OpenClaw's bundle was not started.
Each npm package holds its archive's plugin folder file for file, and none has dependencies.
The archives are `build.sh`'s, repacked with the headers above and without the build's pax headers; their members and bytes are the build's.
Not yet checked against a test deployment: agents of the three harnesses connected with `fabric connect`, a model's turn in each reading the new lines, are owed before publication if the release owner asks for them.

## The agents' descriptions, the add-ons 0.3.4

[bundles-v0.1.7.json](bundles-v0.1.7.json) describes the prepared `bundles-v0.1.7` assets.
The protocol source is `synadia-agents` main at `a1bfb47` (#242): the pi, Claude Code and OpenClaw channels register what an agent says it does as its service's `description`, cleaned to one line of at most 500 characters, which other agents read when they discover it and choose whom to ask; it is set in the harness's own variable (`SYNADIA_PI_DESCRIPTION`, `SYNADIA_CLAUDE_CODE_DESCRIPTION`, `SYNADIA_OPENCLAW_DESCRIPTION`), in `SYNADIA_DESCRIPTION`, which all three read, or in the channel's config, the first that is set winning; OpenClaw's `NATS_DESCRIPTION` keeps working, after the two; a description never stops a channel from starting.
The channels keep their versions: pi 0.5.6, Claude Code 0.6.0, OpenClaw 0.5.7.
The Fabric source is `06a85fc`: the three add-ons at 0.3.4, their own code unchanged from 0.3.3; each package's README names its description variable.
ScratchPad is unchanged from `bundles-v0.1.6`: `sp-v0.1.8`.
The archives hold the members of `bundles-v0.1.6`'s, with the same names, types and modes, but for one chunk of OpenClaw's compiled code, which is named by its content.
What differs is the channels' compiled code (pi's `nats-channel.js`, Claude Code's `server.js`, OpenClaw's `index.js`, `setup-entry.js` and that chunk), Claude Code's `configure` skill, OpenClaw's `openclaw.plugin.json`, each `README.md`, `BUILD`, each package's `package.json`, and Claude Code's plugin and marketplace manifests, whose versions name the new commits; the add-ons' compiled code and the whole ScratchPad skill are byte for byte `bundles-v0.1.6`'s.
In each archive and each npm package, the channel's compiled code holds its harness's description variable, `SYNADIA_DESCRIPTION` and the four warnings a description can get; `bundles-v0.1.6`'s holds none of them.
Each archive's `bin/BUILD.json` names `sp-v0.1.8`, and its four executables match the release's hashes.
At `06a85fc`, against `synadia-agents` at `a1bfb47`, the fabric package's and the three add-ons' typecheck, lint, format check and tests pass.
Each archive installed with `fabric plugins install --from` into an empty home, with fabric v0.18.0 and with a build of fabric v0.19.0 before its release, and each installed folder equals its archive.
From the second home, against a NATS server on the build machine alone, with no deployment and no credentials, so unsigned: pi 0.85.1 started with the pi bundle's channel, add-on and skill, and the Claude Code bundle's server started as its `.mcp.json` starts it; each loaded the add-on and registered a description given with a tab or a line break and runs of spaces as one cleaned line, read back from its service's info, with one warning.
OpenClaw's bundle was not started.
Each npm package holds its archive's plugin folder file for file, and none has dependencies.
The archives are `build.sh`'s, repacked with the headers above and without the build's pax headers; their members and bytes are the build's.
Checked before publication with a build of fabric v0.19.0 before its release against a test deployment, in a throwaway home: each archive installed with `fabric plugins install --from`; a pi 0.85.1, an OpenClaw 2026.10.8 and a Claude Code 2.1.322 agent connected with `fabric connect --description`, each with its own text, one of them with an umlaut, an apostrophe and an exclamation mark, run the CLI's way, signed, each answering a console prompt.
Each agent's service info, asked on `$SRV.INFO.agents` with one of the three agents' credentials, held the text given as its `description`, byte for byte; OpenClaw's holds it in its metadata too.
A turn typed at pi called `discover_agents` and listed the other two agents' descriptions word for word.
A turn typed at Claude Code asked for the agent that keeps a server's logs, without its name: the model chose the pi agent by its description and sent it one `prompt_agent`, which made one task rooted at the typed agent, with pi's thread beneath.
A second `fabric connect --description` changed pi's text, and its service info held the new one once `fabric env` was evaluated again and pi restarted; a text with `$` and one of 501 characters were each refused with exit 2 and the rule in the message, and neither the agent's settings nor its service info changed; `--description ""` cleared it, `fabric env` wrote an `unset` for pi's variable, and the restarted pi registered its own default text.
Claude Code's turn was typed in a session started from a shell that held no `CLAUDE_PID`; started from a shell that held another Claude Code session's, the channel's server and its hooks kept their files under different pids, and the typed turn's call made a task of its own.

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
Checked before publication with fabric v0.13.0 against a deployment of grouped ScratchPad (`66c98ee0`) in reusable mode, for a new test tenant, in a throwaway home: the pi archive installed with `fabric plugins install --from`; a pi agent connected with `fabric connect` got a reusable slot, a bootstrap file and no volume; through its skill pi ran `sp init`, `publish-file`, which returned an `sp-r1:` reference, and `read --text`, which returned the text published; its model calls were recorded.
The same round trip ran by hand with the archive's `scripts/sp` and the agent's credentials; outside an agent's turn `publish-file` needs `SP_CREATOR`, which the add-on sets in a turn.
The Claude Code and OpenClaw archives were not run against it: their `scripts/sp` and four `sp` executables are pi's files, and so is OpenClaw's whole skill; Claude Code's `SKILL.md` is its own.

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
