---
name: scratchpad
description: Read ScratchPad references (sp-r1:… or sp-ref:…) handed to you, and publish, share, hydrate and recover bounded ScratchPad artifacts of your own, through this skill's scripts/sp.
---

# ScratchPad

Adapted from the canonical ScratchPad skill for an agent on the fabric.
The packaged `bin/BUILD.json` records the release, opaque source identifier,
toolchain, targets, and executable hashes. `LICENSE` and
`THIRD_PARTY_NOTICES` contain the distribution terms.
Run the sp command line only as this skill's `scripts/sp`, by its absolute
path: the directory of this file, then `scripts/sp`. In the examples below,
`scripts/sp` stands for that path.

Run each `scripts/sp` command on its own: its absolute path written out in
full, no shell variable for it, no `cd`, `;` or `&&` around it, and its
output not piped into another command. Content may come in on standard
input (`printf '%s\n' "$TEXT" | scripts/sp publish-file --source - …`).
Decode `data_base64` in a command of its own:
`echo "$DATA_BASE64" | base64 -d`. A harness that asks before running a
shell command can then allow `scripts/sp` by its path, and does not ask.

`scripts/sp` adds what the examples in ScratchPad's own skill pass by hand:
the NATS server, this agent's credentials, its workspace, its volume on
`init`, the trace of the prompt you are serving, your address as the
creator of what you publish, and the agent that prompted you as the grantee
of a grant. Never pass `--url`, `--creds`, `--dir`, `--volume`, `--bootstrap-file`,
`--thread-id`, `--root-id`, `--creator`, `--grantee-account` or
`--grantee-user` yourself; `scripts/sp` refuses them.

## Keep identity and recovery state

The connection uses this agent's own identity.
The service authenticates the connection; a reference, creator label, or trace field supplies no identity.
The workspace is private to this agent and persists across restarts.

Each successful command prints JSON.
Read the returned receipt before reporting that publication succeeded.
An upload alone does not publish a checkpoint.
Retention preserves the root for its recorded promise.
A finite deadline permits later cleanup by the client or the private lifecycle worker.
A grant separately permits one authenticated principal to read that root and path.
Do not print credential contents.

## Read an artifact handed to you

A reference is one token that starts with `sp-r1:`. Copy the complete token exactly.
Services that do not enable short references return a longer `sp-ref:` token; copy that token unchanged too.
Keep the returned token in prompts and replies. Do not expand, shorten, repair, or reconstruct it.
A short reference can be read after an agent restart; it does not depend on a session alias table.

```sh
scripts/sp read --ref "$REFERENCE"
scripts/sp hydrate --ref "$REFERENCE" --destination "$DESTINATION"
```

Read returns verified bytes as `data_base64` and the file size as `bytes`; decode `data_base64` to get the content.
Read accepts files up to 16 MiB; use hydration for larger files and directory trees.
`limits.read_bytes` from `info` bounds one service range request; the CLI combines ranges for this buffered read.
Hydrate requires a destination that does not exist.
It verifies content identities before completing files, and reports the files, directories, symbolic links and bytes it installed.
Failure can leave a partial destination; preserve that path for inspection.
An expired reference or refused grant does not authorize another identity or path.

### Read text in windows

```sh
scripts/sp read --ref "$REFERENCE" --text --max-bytes 65536
scripts/sp read --ref "$REFERENCE" --text --offset "$NEXT_OFFSET" --max-bytes 65536
```

A text window returns `text` and never splits a character.
It reports `next_offset` until the end of the file; there, `next_offset` is `null`.
`returned` counts the bytes in the window; `bytes` stays the file size.
Each window reads and verifies the whole file, so hydrate a large file for extensive work.
A file that is not UTF-8 fails with `invalid`.

### List a directory

```sh
scripts/sp list --ref "$REFERENCE"
```

`list` returns one page of the referenced directory.
Continue with `--offset "$NEXT_OFFSET"` until `next_offset` is `null`.
`--path` selects a directory below the reference path.

## Initialize and inspect

```sh
scripts/sp info
scripts/sp init
scripts/sp describe
```

`info` returns this agent's authenticated principal, owned scope allowances, and request limits.
It needs no initialized workspace and changes no recovery state.
The scope byte and object figures are configured allowances; `describe` shows current usage.

### Import the configured bootstrap

When `SCRATCHPAD_BOOTSTRAP_FILE` is configured, the wrapper supplies it on `init`.
The public file selects one volume, admission binding, and complete saved creation Action.
It contains no credentials and supplies no authentication authority.
Run `scripts/sp init` without inventing a creation operation identifier.
Keep both the file and the private workspace across restarts.
An exact matching import preserves existing commands, writer state, and unknown outcomes.
A different creation request refuses; an `exists` result never permits adoption.
Saved creation recovery uses the owner's connection and does not need admin ensure.
An expiry or closed refusal alone does not settle an earlier possibly sent creation.
An explicit later admission needs a separate workspace; never erase the earlier one to continue.
A configured custom volume must match the file. Unsupported command lines refuse the import.
An empty scope list needs an operator admission check before this agent can publish.
Volumes readable through another owner's grant are not listed; their granted references can still be read.
If `info` reports an unknown command, an older binary was selected; continue with the existing commands and ask the operator for the allowances.

`init` creates this agent's volume once; publishing needs it.
Rerun the saved creation action after an unknown outcome.
An established writer whose journal disappeared requires an explicit reset.
Initialization cannot silently reset that writer.
For a reusable lifetime, `info` also returns its admission binding.
`init` saves that binding before its first creation request and reuses it after a restart.
A saved creation cannot adopt a later admission with the same volume name.
Preserve the workspace after a refusal; do not erase it to bypass lifetime fencing.

## Publish a file and share it with the agent that prompted you

`SOURCE` names the local file, or `-` for standard input; `ARTIFACT_PATH` is its canonical absolute artifact path, such as `/replies/1.txt`.
Use a new `OPERATION_ID` for each intended publication.
A rerun with the same operation identifier returns that publication's saved result; it never reads the source again, so changed content needs a new identifier.

```sh
scripts/sp publish-file --source "$SOURCE" --path "$ARTIFACT_PATH" --operation-id "$OPERATION_ID" --ttl-seconds 600
```

Copy the returned `reference` without editing its contents.
This command publishes a complete root containing that one file.
It also retains the root in the same atomic publication.
Keep `--ttl-seconds`; without it, the root stays retained for 24 hours.
A managed volume's lease expiry can end that retention earlier.
Each volume has only 8 retention slots, and each publication holds one.
While you serve a prompt, it also grants the agent that prompted you read on that file: the result's `granted_to_caller` says so, and `caller_grant_error` says why not.
Then put the unchanged reference in your reply.

To grant that agent read again, for example after the grant expired:

```sh
scripts/sp grant --ref "$REFERENCE" --operation-id "$GRANT_ID" --ttl-seconds 600
```

A grant goes to the agent whose prompt you are serving, and to no one else.
The returned expiry can be earlier than requested because the grant cannot outlive its retained root.

### Free a retention slot

A full retention table refuses the next publication with `capacity`.
An expired pin still holds its slot until maintenance releases it.
After the retention deadline, `scripts/sp maintain --apply` frees that slot.

In this harness, `scripts/sp release` frees a slot early only after the publication's caller grant has expired.
The caller grant from `publish-file` lasts for the publication's `--ttl-seconds`, or 600 seconds without that flag.
While that grant lives, `release --apply` fails with `conflict`.
So a publication with the 24-hour default can be released once its grant has expired, after 600 seconds, when no reader still needs it.
After the retention deadline, a short reference no longer resolves, so `release --apply` fails with `not_found`, or reports `absent` when housekeeping already cleared the pin.
Do not repeat a release that failed with `conflict` or `not_found`; run `scripts/sp maintain --apply` after the deadline.

Use `release` only for a publication without a live grant, when no reader still needs it:

```sh
scripts/sp release --ref "$REFERENCE"
scripts/sp release --ref "$REFERENCE" --apply
```

The first command reports the plan, including every live grant that names this retention handle.
An empty `protected_by` list means that `--apply` can free the slot.
The released short reference then no longer resolves.
A retry after a lost reply settles the same saved request; `scripts/sp recover` settles it too.
A rerun after the release settled reports `absent`.

## Hand a reference to another agent

Put the unchanged reference in the prompt of `prompt_agent`, and nothing
more: do not grant for it yourself. The agent tools grant the receiver read
when it reads references (`discover_agents` shows
`reads_scratchpad_references: true`), and take the reference out of the
prompt otherwise, saying so in the call's result. A reference another agent
handed you goes on the same way; its creator decides whether the receiver
may read it.

## Publish an edited directory

An external editor or executor prepares `SOURCE_DIRECTORY`.
ScratchPad does not run that editor or executor.

```sh
scripts/sp sync --source "$SOURCE_DIRECTORY" --operation-id "$OPERATION_ID"
```

Sync publishes the whole directory as the next root.
Paths absent from that directory are absent from the new root.
Preparation copies canonical content into a private disk spool in the workspace before upload.
It preserves executable file modes and literal symbolic links without following links.
There are no implicit Git exclusions; choose the source tree explicitly.
Another writer's publication can produce an explicit conflict; the command does not merge automatically.

## Resolve a failed command

| Exit | Action                                                                             |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | Inspect the successful JSON result.                                                |
| 1    | Inspect the definite failure code and workspace state.                             |
| 2    | Correct the local arguments; no product request was sent.                          |
| 3    | The outcome is unknown. Recover the saved intent before starting another mutation. |

The error object's `outcome` field classifies a failure that sp reports.
A refusal by `scripts/sp` itself exits 2 and has no `outcome`.

| `outcome`    | Next step                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `unresolved` | Run `scripts/sp recover`, or inspect the reset plan that the message names. Start no other mutation.                       |
| `conflict`   | After `release`, do not repeat it; see [Free a retention slot](#free-a-retention-slot). Otherwise read the message.        |
| `capacity`   | Free the named resource: run `maintain --apply` after a retention deadline, remove a path, or renew an expired lease.      |
| `retry`      | Repeat the same command later. Hydrate into a new destination; keep a partial one for inspection. For `closed`, see below. |
| `refused`    | Correct the input or the policy before trying again.                                                                       |

An expired or released reference needs a new reference.
`closed` is temporary during maintenance and during a removal.
Run `scripts/sp describe`, and renew when `volume.lifetime.phase` is `expiring`.
If `describe` also fails with `closed`, renew with a deadline about 60 seconds ahead; renewal needs no read.
Then `describe` reports `max_lease_seconds` for a longer renewal.
If `renew` fails with `invalid` on a volume that never expires, retry the original command later.
If `renew` also fails with `closed`, retry for a bounded time; a lasting `closed` can mean that the lifetime ended.

```sh
scripts/sp recover
```

A saved terminal disposal or lease renewal settles first.
Otherwise recovery settles a saved retention release, then reconciles an exact accepted receipt.
If publication remains necessary, recovery uploads the saved spool and submits the same command.
It never rereads a changed source file or standard input.
An `epoch_changed` response requires preparation against the current collection epoch; rerun recovery after maintenance ends.
Do not change its operation identifier, base, root, or requested retention while the outcome remains unresolved.
A definite conflict can leave the publication pending.
Inspect an explicit reset plan before abandoning that intent.

```sh
scripts/sp reset
scripts/sp reset --apply
```

Reset fences the previous writer generation.
It does not release retention from an earlier unknown publication.
An unresolved grant can block further control operations until acceptance, a positive observation, or expiry settles it.

A publication refused before its checkpoint was prepared leaves its spool, and so does a publication abandoned by reset.
A later publication requires recovery or explicit removal of that saved upload.
Inspect the spool before attempting removal:

```sh
scripts/sp spool-inspect
scripts/sp spool-remove
scripts/sp spool-remove --apply
```

### Remove an unprepared upload

Removal is a dry run without `--apply` and refuses a pending checkpoint.
A refused upload can be removed without reset when its writer remains ready at the saved command position.
Inspect the removal report before applying it.
Removal abandons the saved upload, including bytes read from standard input.
Remote reservations remain charged until maintenance collects them.
An older workspace can already have a pending checkpoint after an upload refusal.
Do not automatically reset it because a response says `capacity`; recover or inspect an explicit reset first.
A new publication reclaims a completed previous spool only after its exact receipt is saved.

## Reclaim expired content

```sh
scripts/sp maintain
scripts/sp maintain --apply
```

The first command reports the proposed maintenance.
The second releases unprotected expired pins and closes a collection interval.
On a reusable deployment, private maintenance traces retained dependencies,
collects unreachable objects and reopens that interval. The client observes its completion.
On an existing deployment, the client performs that collection.
Maintenance does not scrub retained file payloads.
If interrupted, recover the saved request. A newer collection interval fences that request.
A full retention table refuses new handoffs with `capacity`.
Run `scripts/sp maintain --apply` after a handoff's deadline to free its slot.
`scripts/sp release` frees a slot early only when no live grant names its retention.
A capacity refusal never permits eviction of retained content.

## Capacity

Deployment scopes select explicit encoded-byte and object quotas.
Read this agent's configured allowances with `scripts/sp info`; example sizes are not deployment defaults.
Objects include chunks, file metadata, and directories.
Retained results and unfinished uploads consume the same allowance.
Replacing unique content needs room for both versions until old retention is released and collection completes.
Local spools also need enough private disk space for the prepared artifact.

### Choose what to remove at capacity

On a reusable volume, `describe` includes `lifetime` with the lease, grace period,
recovery-read state and reserved metadata allowance.
Choose a path from the current head to remove. The service never chooses a live
file to evict because the volume is full.

```sh
scripts/sp remove --path "$ARTIFACT_PATH" --operation-id "$REMOVE_ID"
scripts/sp remove --path "$ARTIFACT_PATH" --operation-id "$REMOVE_ID" --apply
```

The first command reports a plan without changing the head.
Applying saves the exact command and uses reserved metadata space within the reported bounds.
The receipt confirms the new head. Retention or grants can still protect the removed content.
Private maintenance returns space after that content is no longer protected.
After an unknown result, use `recover`; do not change the saved path or operation identifier.
Older binaries or deployments can refuse this command; that refusal does not permit eviction.

### Keep or end a reusable lifetime

A volume with `lifetime.expires_at` equal to zero is durable.
For a managed lease, request one absolute Unix deadline in seconds:

```sh
scripts/sp renew --until "$UNTIL"
```

Save and retry the same deadline. Renewal must win before retirement begins.
An already achieved renewal can still recover after that deadline passes.
If recovery reports definite `expired` for an unachieved saved deadline, only the
renewal intent is cleared. Request a new absolute deadline if the same lifetime is
still renewable, then recover the unchanged ordinary pending operation.
An unknown result keeps the saved renewal pending; do not replace its deadline.
During recorded grace, recovery reads can remain available while ordinary writes are closed.
Do not infer disposal authority from an agent disconnect, an idle volume, or full quota.

Whole-volume retirement ends all head, retention, grant and access promises in its plan.
It can permanently delete every artifact. Use it only when the user has authorized
ending those promises and any required export has been restored and checked.

```sh
scripts/sp retire --operation-id "$RETIRE_ID"
scripts/sp retire --operation-id "$RETIRE_ID" --end-promises --apply
```

Review the first result before applying. The exact terminal operation persists for recovery.
If recovery proves a strictly newer nonterminal plan for the same incarnation,
slot, generation, target, and saved request, it clears only the old release intent
and reports `fenced`. The lifetime remains nonterminal. Inspect the reported
lifetime and renew before ordinary work if needed. Review a new plan before
applying again; this refusal does not mean that artifacts were disposed or capacity returned.
Unknown or mismatched evidence and an already accepted terminal fence stay pending.
`disposed` reports physical disposal; only `capacity_returned` confirms admission capacity is free.
If a successor generation proves the old lifetime ended but this workspace never
observed its own release fence, recovery also reports `acceptance_unknown: true`.
That result confirms capacity return while leaving the original operation's acceptance unknown.
Preserve the old workspace through completion. A later admission is a different lifetime,
and old references and receipts do not select it.
