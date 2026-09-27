---
name: scratchpad
description: Read ScratchPad references (sp-ref:…) handed to you, and publish, share, hydrate and recover bounded ScratchPad artifacts of your own, through this skill's scripts/sp.
---

# ScratchPad

Adapted from ScratchPad's skill at `79f8927` for an agent on the fabric.
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
of a grant. Never pass `--url`, `--creds`, `--dir`, `--volume`,
`--thread-id`, `--root-id`, `--creator`, `--grantee-account` or
`--grantee-user` yourself; `scripts/sp` refuses them.

## Keep identity and recovery state

The connection uses this agent's own identity.
The service authenticates the connection; a reference, creator label, or trace field supplies no identity.
The workspace is private to this agent and persists across restarts.

Each successful command prints JSON.
Read the returned receipt before reporting that publication succeeded.
An upload alone does not publish a checkpoint.
Retention preserves the root until explicit release.
Its deadline permits later client cleanup.
A grant separately permits one authenticated principal to read that root and path.
Do not print credential contents.

## Read an artifact handed to you

A reference is one token that starts with `sp-ref:`. Copy it exactly.

```sh
scripts/sp read --ref "$REFERENCE"
scripts/sp hydrate --ref "$REFERENCE" --destination "$DESTINATION"
```

Read returns verified bytes as `data_base64` and their count as `bytes`; decode `data_base64` to get the content.
Hydrate requires a destination that does not exist.
It verifies content identities before installing files.
An expired reference or refused grant does not authorize another identity or path.

## Initialize and inspect

```sh
scripts/sp init --operation-id "$CREATE_ID"
scripts/sp describe
```

`init` creates this agent's volume once; publishing needs it.
Rerun the saved creation action after an unknown outcome.
An established writer whose journal disappeared requires an explicit reset.
Initialization cannot silently reset that writer.

## Publish a file and share it with the agent that prompted you

`SOURCE` names the local file, or `-` for standard input; `ARTIFACT_PATH` is its canonical absolute artifact path, such as `/replies/1.txt`.
Use a new `OPERATION_ID` for each intended publication.

```sh
scripts/sp publish-file --source "$SOURCE" --path "$ARTIFACT_PATH" --operation-id "$OPERATION_ID" --ttl-seconds 600
```

Copy the returned `reference` without editing its contents.
This command publishes a complete root containing that one file.
It also retains the root in the same atomic publication.
While you serve a prompt, it also grants the agent that prompted you read on that file: the result's `granted_to_caller` says so, and `caller_grant_error` says why not.
Then put the unchanged reference in your reply.

To grant that agent read again, for example after the grant expired:

```sh
scripts/sp grant --ref "$REFERENCE" --operation-id "$GRANT_ID" --ttl-seconds 600
```

A grant goes to the agent whose prompt you are serving, and to no one else.
The returned expiry can be earlier than requested because the grant cannot outlive its retained root.

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
Another writer's publication can produce an explicit conflict; the command does not merge automatically.

## Resolve a failed command

| Exit | Action                                                                             |
| ---- | ---------------------------------------------------------------------------------- |
| 0    | Inspect the successful JSON result.                                                |
| 1    | Inspect the definite failure code and workspace state.                             |
| 2    | Correct the local arguments; no product request was sent.                          |
| 3    | The outcome is unknown. Recover the saved intent before starting another mutation. |

```sh
scripts/sp recover
```

Recovery repeats the exact saved command or control request.
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

## Reclaim expired content

```sh
scripts/sp maintain
scripts/sp maintain --apply
```

The first command reports the proposed maintenance.
The second releases unprotected expired pins, closes the volume, verifies live content, collects unreachable objects, and reopens it.
If interrupted, recover the saved request or repeat maintenance against the durable closed state.
Capacity refusal requires maintenance or an explicit operator decision; it never permits eviction of retained content.

## Capacity

The development profile permits at most 8 MiB of allocated content and 64 objects per volume.
Objects include chunks, file metadata, and directories.
Retained results and unfinished uploads consume the same allowance.
The directory builder refuses symbolic links and has no implicit Git exclusions.
