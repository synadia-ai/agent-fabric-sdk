# Sustained native client qualification

Work issue: [SDK #22](https://github.com/synadia-ai/agent-fabric-sdk/issues/22).
This qualification extends the short Linux window in SDK #39.
The runtime sources remain unchanged. Live deployment and integration pins remain separate.

## Fixed workload

- Run both native clients against one real authenticated ScratchPad service and file-backed R1 NATS server.
- Give each writer a separate volume with 128 MiB and 512 objects.
- Run 180 paired cycles at a fixed ten-second cadence, followed by a final sample at 1,800 seconds.
- Rotate 1, 8, and 32 MiB artifacts. Make every chunk distinct across languages and cycles.
- Publish both artifacts concurrently. Grant the reader principal access, then read through the opposite language.
- Keep handoffs for three cycles. Grants last 20 seconds; publication references last 3,600 seconds.
- Release an older handoff only after observing its grant deadline. Collect after each cycle.
- Keep a separate retained 4 KiB canary per volume. Read it through the opposite language every second.
- Keep workspaces open between fault checkpoints. Sample database and WAL sizes without checkpointing them.
- At cycle 60, withhold the TypeScript publication receipt after acceptance. At cycle 120, withhold Python's.
- At each fault, prove the stored receipt matches the dropped reply, kill that writer process, and restart the service.
- Reopen the same workspace and require recovery of that exact receipt before proceeding.
- Pause canary reads only for these explicit restart intervals. Record their duration.

Cycle numbers start at zero. Rehearsals use 12 cycles and fault cycles 4 and 8.
They retain the ten-second cadence, sizes, grant lifetime, and retention overlap.
Rehearsals do not count toward the 30-minute result.

## Checks and limits

Every full artifact read must match an independently computed size and SHA-256 digest.
Every canary read must match its bytes. Zero-byte or partial success fails the run.
Canary `closed` refusals are allowed only while collection owns that volume's maintenance interval.
All other refusals fail the positive workload. A later successful canary read must follow each interval.
Within each active watch segment, coverage gaps and individual reads must stay within three seconds.
Check first-read delay, successive start times, and the final coverage boundary.
Counted catch-up bursts cannot excuse an earlier stall. Explicit restart pauses are recorded separately.
Both writers must advance once per cycle. Every scheduled cycle must start within two seconds of its deadline.
Each paired cycle must finish within ten seconds, including the two explicit recovery cycles.
The final 1,800-second sample must include successful canary reads in both directions.
These are qualification gates for this fixture, not product latency guarantees.

Report latency by artifact size and time quarter, including every window's worst sample.
Report logical volume usage, retained slots, native stream messages and bytes, physical store size,
workspace database/WAL sizes, process memory, and event-loop gaps across the run.
Do not infer a plateau from first and last samples alone.
After each collection, each live volume must use at most 42 MiB and 128 objects.
It must hold exactly the canary plus at most three artifact retentions.
Each sampled SQLite database must remain at or below 48 MiB.
The database, rollback journal, and WAL together must remain at or below 96 MiB per workspace.
The native stream must remain at or below 112 MiB after each paired cycle.
Sampled native file allocation must remain at or below 1 GiB.
These bounds allow implementation overhead while excluding storage proportional to the full write history.
The databases use DELETE journals; inspect their journal files as well as any WAL files.
File samples occur after cycles. They do not measure temporary publication peaks.
Reject a file walk if any entry disappears during the observation.

Before the run, prove the checker rejects a real read from the wrong reference.
Also omit retention release in a separate finite control.
Three distinct 32 MiB artifacts must fit; the fourth must reach the configured quota.
Automatic collection must preserve those retained artifacts.
Release their retentions, collect, and require a new exact cross-language publication.
The normal workload must collect old content and continue beyond this control's stopping point.
The fault gates must report actual withheld, accepted receipts; injected client exceptions do not qualify.
The final run requires passed control evidence with the exact same source manifest.

## Scope

This is one Linux arm64 container with four CPUs and 4 GiB memory on local Docker storage.
It qualifies sustained native client work and service restart, not broker restart or R3 failover.
It does not qualify an independent operator maintenance controller or public npm/PyPI installation.
The previous real Live run and its six agents remain separate evidence.

## Worker protocol

The controller sends JSON lines with `id` and `command`; workers return one line with the same `id`.
Success contains `value`; failure contains `error` with `code` and `message`. Diagnostics go to stderr.
No response includes credentials. The controller stores credentials only in private fixture scratch space.

Commands:

- `open`: `config`, `volume`, `directory`, `grantTtlSeconds`. Connect owner through `fault_url` and reader through `url`.
  Use a 2,000 ms request timeout. Open the durable workspace; return its description and process ID.
- `canary`: close the writer, reopen with a 3,600 second TTL, publish and grant the canary, then reopen with the configured grant TTL.
  Return the publication, digest, and size. The canary operation ID is `canary-<language>`.
- `publish`: `cycle`, `bytes`, `operationId`. Stream `/artifact.bin` with a 3,600 second TTL.
  Return `publication` or `error`, plus `inputBytes`, `sha256`, `publishMs`, `samples`, and `maxGapMs`.
  Sample event-loop gaps every five milliseconds throughout publication, including receipt timeout.
- `grant`: `reference`. Grant to `config.users.reader`; return the matching observed grant deadline as `until`.
- `read`: `reference`, `bytes`. Stream with that explicit byte limit; return independently observed size, SHA-256, and duration.
- `release`: `reference`. Use the native public release method.
- `maintain`: use the native public collection method; return before/after volume descriptions and duration.
- `recover`: use the native public recovery method; return the exact result.
- `inspect`: return the description, database/WAL file sizes, and process lifetime maximum RSS.
- `watch`: `reference`, `bytes`, `sha256`. Start one canary task; sample at a one-second cadence.
- `watch-phase`: `maintenance` boolean. Allow only `closed` refusals during the specified interval.
- `watch-stop`: join the task and return all samples since `watch`, including read duration, monotonic time, and outcome.
- `stop`: close clients and connections, return success, and exit.

The canary contains 4,096 bytes, all equal to the language ID (TypeScript 1, Python 2).
Artifact chunks contain 524,288 bytes. Their first twelve bytes are three unsigned big-endian 32-bit integers:
language ID, cycle, and chunk index. The remaining bytes equal `(languageId * 67 + cycle * 17 + index) % 256`.
Every worker uses `agents.native.sustained.<language>` as its creator.
Publication operation IDs are `sustained-<language>-<cycle>`.
