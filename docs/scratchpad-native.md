# Native ScratchPad clients

## Contract for the first implementation

The native clients use ScratchPad's current `api/v2` over the tenant's existing NATS import.
The service, identities, agent protocol, and Fabric reference policy remain the existing contracts.
Implement TypeScript first and Python second against the same conformance cases.

The TypeScript implementation lives below `typescript/src/scratchpad-native/`.
The Python implementation lives below `python/src/synadia_ai/agent_fabric/_scratchpad_native/`.
Both packages export their native factories, readers, and errors through the ordinary package index.
They implement the existing `ScratchPadClient` interface and add binary artifact methods and explicit recovery.
The connection belongs to the caller; the client neither replaces credentials nor closes that connection.

### Protocol and codec boundary

`protocol.ts` provides exported wire types matching the current Go `api/v2` types.
`codec.ts` implements canonical content identities, chunk/file/tree encoding, and exact v2 references.
`transport.ts` provides bounded requests, strict replies, raw content bodies, and error classification.
Keep these modules independent of Fabric tracing and discovery.
Methods take a trace value as data; NATS authenticates the caller independently.

Each transport method sends one request and performs no application retry.
A mutation without a trustworthy reply has an unknown outcome.
Wrong targets, mismatched receipts, malformed replies, and service unavailable/internal errors cannot establish a failed mutation.
Reads validate offsets, lengths, content identities, and explicit byte limits.
Use safe integer validation for wire counters; refuse values that JavaScript cannot represent exactly.

The codec must reproduce the Go fixtures exactly, including canonical CBOR and content digests.
References use the current `sp-ref:` v2 shape and never supply authentication.

### Workflow boundary

The client supports initialization, artifact publication, granted reads, recovery, and required retention cleanup.
Publication saves stable content and its complete intent before transmission.
An unknown mutation blocks a different intent until recovery establishes the outcome.
Recovery reuses the saved operation, writer generation, command, base, root, and retention request.
No automatic writer reset may discard another operation's recovery promise.
Client state is private and persistent, with bounded current records and artifact storage.
Concurrent use and process restart require explicit tests.

The initial higher-level interface includes `commit`, `read`, `owns`, `grantRead`, and `granted` for the Fabric adapter.
It also exposes byte/stream publication, verified byte/stream reads, `recover`, and `close`.
The writer requires Node 22.13 or later and an explicit private directory on a persistent local filesystem.
It uses Node's built-in SQLite API. Other package features keep their existing runtime requirement.
Python native operations require Python 3.12 or later and use the standard-library `sqlite3` module.
Python 3.11 can still import and use the other Fabric features.
Both codecs use Unicode 15 normalization: Python excludes characters unassigned in Unicode 15 before it normalizes each assigned span.
This keeps paths stable when a newer Python runtime supplies newer Unicode tables.
Reproduce the checked-in range table with
`node scripts/generate-scratchpad-unicode15.mjs typescript/node_modules/@unicode/unicode-15.0.0 --check`
from the repository root. The package includes the data's license notice.

### Use from an SDK agent

```ts
import { nativeScratchPad, scratchPadReader } from "@synadia-ai/agent-fabric";

// nc is the agent's existing authenticated NATS connection.
const pad = await nativeScratchPad({
  nc, volume: "Writer", creator: "agents.prompt.writer.demo.main",
  dir: "/var/lib/my-agent/scratchpad", // private; preserve across restarts
});
await pad.recover();
const published = await pad.publishBytes(new TextEncoder().encode("result"), "/result.txt", {
  operationId: "task-123-result", ttlSeconds: 600,
});
await pad.grantRead(published.reference, { account: readerAccount, user: readerUser });
// The receiving agent uses its own connection and does not need a writer directory.
const reader = await scratchPadReader({ nc: readerConnection });
const bytes = await reader.readBytes(published.reference);
await pad.close(); // closes the workspace; the NATS connection still belongs to the agent
```

Pass `pad` to `scratchPadExtension` and `grantRequestEndpoint` through their existing ports.
`commit(text, path, trace)` returns a reference; `read(reference, trace)` returns verified UTF-8 text.
`nativeScratchPadFromEnv(env, { nc, creator })` uses `SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR`, and `SCRATCHPAD_GRANT_TTL_S`.
An unset volume disables ScratchPad. A configured volume requires a persistent directory; there is no temporary-directory default.
Both reference agents use the native factory. `SCRATCHPAD_BIN` belongs to the separate CLI adapter.

The Python interface uses snake_case names and returns dictionaries for publications and recovery results:

```python
from synadia_ai.agent_fabric import Grantee, native_scratchpad, scratchpad_reader

pad = await native_scratchpad(
    nc=nc, volume="Writer", creator="agents.prompt.writer.demo.main",
    dir="/var/lib/my-agent/scratchpad",
)
try:
    await pad.recover()
    published = await pad.publish_bytes(b"result", "/result.txt", operation_id="task-123-result")
    await pad.grant_read(published["reference"], Grantee(account=reader_account, user=reader_user))
    reader = await scratchpad_reader(nc=reader_connection)
    data = await reader.read_bytes(published["reference"])
finally:
    await pad.close()
```

`await native_scratchpad_from_env(env, nc=nc, creator=address)` reads the same three variables.
Use a writer on one event loop. Its mutations are serialized; the workspace lock excludes other processes.
Pass immutable `bytes` to `publish_bytes`, or an iterable/async iterable of bytes to `publish_stream`.
Python's `read_stream(reference, limit_bytes=...)` is an async iterator.

### Persistence and recovery

One SQLite database holds an exclusive lock for the client's lifetime.
The directory and database use modes 0700 and 0600 on Unix.
The database uses a deletion journal, `synchronous=EXTRA`, and `fullfsync=ON`.
Its current records contain one pending operation, the last publication receipt, and at most 16 grant ledger entries.
The spool holds only the pending artifact. SQLite reuses freed pages; its file can retain the largest previous spool size.
The client does not replay a growing write history.

Only the owning SQLite connection may access the database file while the client is open.
Do not open it through a second SQLite library, copy it through a file descriptor, or place it on NFS.
Close the client before inspection or backup. Keep one workspace per writer; do not share slot 0 with `sp`.
An established remote writer without its matching local journal requires an explicit reset.
Use `describe()` to inspect its generation, then `resetWriter({ expectedGeneration })` only when abandoning the prior recovery promise is intended.
If the entire workspace was lost, provide the exact volume incarnation from the former client's inspection as `resetWriter({ target, expectedGeneration })`.
The service must confirm that the authenticated principal owns that target. A new creation request can return `exists`; it does not discover or adopt an existing writer.
Reset does not undo an accepted publication or release its retention.

After `NativeScratchPadError.unknown`, call `recover()` before starting another mutation.
Recovery compares the full stored receipt before reading local payloads.
It otherwise uploads the saved bytes and repeats the exact command once.
Repeated `operationId` values reuse the saved payload and do not consume a replacement input stream.
Changed content needs a new operation ID. The local retry window stores the last publication only.
An expired intent leaves that window after recovery settles it; use a fresh operation ID for new work.
After a workspace write failure, close and reopen the client before recovery.
If an unaccepted publication passes its retention deadline, recovery sends the saved command to
establish the service's definite `expired` refusal. It saves the observed revision and closes
that exact revision, which fences any older in-flight publication write. It then saves the
collection continuation, clears the expired intent and spool, and reopens through collection.
Recovery reports `{ kind: "expired" }`; the next commit can proceed with the same writer.
An accepted publication still recovers its exact receipt after expiry. The local clock alone never clears an intent.

NATS JavaScript can buffer requests during reconnect. The client uses a bounded flush before each request and does not add retries.
After transmission, loss, cancellation, or malformed replies leave mutations unknown.
Python task cancellation propagates as `asyncio.CancelledError` and preserves the saved mutation
for explicit recovery. It is not converted into an ordinary exception that a handler might ignore.
A later definite refusal cannot establish that an earlier unknown grant or maintenance request had no effect.
The saved control request remains until acceptance or an applicable fence establishes the outcome.
Python uses nats-py's public connection and message APIs. Those APIs collapse repeated header names
and replace malformed header text before this client receives it. The client validates the parsed
headers and strict body JSON; it cannot prove the original raw header bytes or multiplicity.
That upstream limitation is recorded for friendly-user qualification, without a private parser hook.

### A closed volume without a saved continuation

Native maintenance resumes only its saved interval.
If another operation closed the volume, `maintain()` refuses with `closed`, including after reopening the workspace.
A `recover()` result of `ready` means the journal has no pending work. It does not mean the remote volume is open.
The refusal preserves the head, writers, retained roots, and closed revision.

An operator must finish that interval through the authenticated public service API:

1. Quiesce the volume's mutation actors. Identify its owner, volume, and incarnation from `describe()`.
2. Read the current volume with `volume.get`. Confirm that it is closed and record its exact revision.
3. Inspect `maintenance.plan` for that target and revision. Check the live roots and proposed deletions.
4. Apply `maintenance.apply` with that same target and revision, then read the volume again.
   A changed revision requires a fresh inspection; do not silently adopt a different interval.
5. Confirm the volume is open and retained references are readable before resuming the writer.

The Go client's `GetVolume`, `PlanCollection`, and `ApplyCollection` expose these operations.
Do not reset a writer or discard its journal merely to reopen a closed volume.
Do not attach a new CLI workspace to the native writer slot.
The service fences maintenance by revision; it does not record a separate maintenance-owner identity.
This procedure requires coordinated operators. Independent concurrent maintenance actors remain outside the qualified scope.

### Bounds and friendly-user test scope

Each publication replaces the head with one file at the selected path. It does not merge previous files into the new head.
Prior references remain readable while their retention and grants remain valid.
Transfers use 512 KiB chunks. `publishStream` spools one artifact with bounded chunk memory.
`publishBytes` makes an owned input copy; use the streaming method for large content.
`readBytes` defaults to a 16 MiB whole-file allowance and verifies bytes before returning them.
`readStream` requires an explicit allowance and verifies the complete file when iteration reaches EOF.
Streamed bytes are provisional until successful completion; write to a temporary destination before exposing a download.

`release(reference)` releases a finished handoff only when no live grant still names it.
`maintain()` releases expired unprotected pins, collects unreachable content, and reopens its own maintenance interval.
The client checks capacity and retention before saving a new publish command.
Admission conservatively allows space for existing content plus the new artifact, even when some objects could be shared.
All eight occupied retention slots produce an explicit capacity refusal; live handoffs are never evicted to make space.

The first milestone qualifies the local Node runtime and actual service workflow.
Synchronous work can delay the caller's event loop during larger publications.
Use the bounded spool probe below to measure that delay on the selected runtime and local filesystem.
It covers encoding, database writes, and network work together; it does not isolate SQLite flush time.
Other operating systems, synchronized clocks, the full disconnect matrix, and sustained workload sizing remain friendly-test risks.
No Windows or network-filesystem qualification is implied.
Full directory sync/hydrate remains the `sp` client path.
Track TypeScript delivery in [SDK issue #19](https://github.com/synadia-ai/agent-fabric-sdk/issues/19),
Python delivery in [SDK issue #23](https://github.com/synadia-ai/agent-fabric-sdk/issues/23),
and qualification risks in [SDK issue #22](https://github.com/synadia-ai/agent-fabric-sdk/issues/22).

### Conformance

Use the real ScratchPad public service and native NATS identity imports for integration qualification.
Compare exact artifact bytes and receipts, and directly assert denied readers and scopes.
Exercise publication with multiple chunks, lost replies, process restart, and sustained retention-slot reuse.
Cross-check native output with the Go client and `sp`.
SDK agents must complete their workflows with no `sp` executable available.
Shared vectors supplement each language's transport and persistence tests.

Run the real-service suite explicitly; the ordinary unit suite does not qualify a deployment:

```sh
cd typescript
npm run build
SCRATCHPAD_CORE_ROOT=/path/to/private/scratchpad npm run test:native

cd ../python
uv sync --python 3.12 --frozen
SCRATCHPAD_CORE_ROOT=/path/to/private/scratchpad \
SCRATCHPAD_TYPESCRIPT_PACKAGE=/path/to/agent-fabric-sdk/typescript \
  uv run --no-sync pytest -s tests/test_scratchpad_native.py tests/test_scratchpad_native_expiry.py \
    tests/test_scratchpad_native_controls.py
```

The core checkout is a test-only dependency. Shipped clients and their callers do not need it.
The control suite requires the core's `native_client_control_test.go` fixture extension.
The launcher creates temporary test credentials, uses the real broker identity imports, and records actual dropped receipts.
The process-restart test runs the built package with no executables on PATH, kills its writer after an unknown result, and compares the recovered receipt and bytes.
The Python suite also exchanges exact bytes and digests with the built TypeScript package:
more than one MiB from Python to TypeScript, and 4097 bytes in the reverse direction
within the fixture's smaller spare volume.
Agent reference-policy tests use an explicit CLI adapter and fake `sp` to check policy in isolation.
Those tests do not qualify ScratchPad storage, identity imports, or native recovery.

The control cases withhold actual accepted grant, close, and collection replies plus their next volume observations.
They reopen the workspace and compare the complete replayed request, stored state, and live bytes.
Other cases observe a real disconnect/reconnect, operator recovery, fixed-slot pressure, and byte/object quota headroom.
Overlapping handoffs use one writer's queue; they do not establish support for competing writer workspaces.
The reconnect case follows an accepted publication whose reply was lost.
A delayed-grant case holds the original request while another connection receives a definite service refusal.
The client preserves its pending grant across reopening, then recovers after the original request arrives.
The check compares the exact scope, service error cause, allowed reader, and denied reader.
This establishes reordered-delivery behavior; the full NATS reconnect-buffer matrix remains separate work.
Constructor and close cases preserve exact receipts, exclude another writer until close completes,
and recover from failed input and cancelled Python close.

The following optional checks require both packages' development environments.
Run them from `python/`; select new output directories for each run:

```sh
uv run --no-sync ../scripts/check-native-control-recovery.py \
  --core-root /path/to/private/scratchpad --output /path/to/evidence/control-mutations
uv run --no-sync ../scripts/check-native-control-recovery.py \
  --case delayed-refusal --core-root /path/to/private/scratchpad \
  --output /path/to/evidence/delayed-mutations
uv run --no-sync ../scripts/measure-native-spool.py \
  --core-root /path/to/private/scratchpad --output /path/to/evidence/spool-probe --cycles 3
```

The mutation check omits durable grant-intent storage in isolated source copies.
Both language tests must fail at the reopened-workspace assertion; setup failures do not count.
The original checkout remains unchanged.

The spool probe publishes a distinct 7 MiB stream, verifies its complete digest, and releases and collects the previous content.
Use `--artifact-mib 32` for the explicit larger fixture profile and `--cycles 10` for a longer finite window.
It closes and reopens the same workspace on every cycle.
Records include publication time, worst observed event-loop gap, sample count/window, verified bytes, and closed database size.
TypeScript records sampled RSS; Python records process-lifetime maximum RSS. Those measurements have different scopes.
The default three cycles are a bounded diagnostic, not a soak or a latency guarantee.
No timing threshold is used as a correctness assertion.
The [September 28 qualification report](runs/2026-09-28-native-friendly-qualification.md) records exact case counts, measured pauses, and remaining boundaries.
The [Linux command](../scripts/native-linux/README.md) records source hashes, runtimes, mount details, counts, and measurement scope.
The [Linux preparation report](runs/2026-09-28-linux-native-preparation.md) records the delayed-grant, workspace lifecycle, and larger-spool results.

The [sustained workload contract](native-sustained-plan.md) defines a separate 30-minute native-client run.
It keeps both workspaces open between explicit writer deaths and uses independent cross-language readers.
The run measures the SQLite database and rollback journal separately, plus their combined file size.
Its canary checks require progress throughout each active interval, not only a final successful read.
Use the contract's controls and rehearsal before its fixed qualification workload.
The [September 29 sustained report](runs/2026-09-29-native-sustained.md) records the full window,
exact recovery events, storage reuse, measured latency, and qualification limits.
