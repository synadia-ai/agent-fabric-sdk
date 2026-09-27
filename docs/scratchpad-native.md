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
After a workspace write failure, close and reopen the client before recovery.

NATS JavaScript can buffer requests during reconnect. The client uses a bounded flush before each request and does not add retries.
After transmission, loss, cancellation, or malformed replies leave mutations unknown.
A later definite refusal cannot establish that an earlier unknown grant or maintenance request had no effect.
The saved control request remains until acceptance or an applicable fence establishes the outcome.
Python uses nats-py's public connection and message APIs. Those APIs collapse repeated header names
and replace malformed header text before this client receives it. The client validates the parsed
headers and strict body JSON; it cannot prove the original raw header bytes or multiplicity.
That upstream limitation is recorded for friendly-user qualification, without a private parser hook.

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
Synchronous SQLite flush latency, other operating systems, synchronized clocks, the full disconnect matrix, and sustained workload sizing remain friendly-test risks.
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
  uv run --no-sync pytest -s tests/test_scratchpad_native.py
```

The core checkout is a test-only dependency. Shipped clients and their callers do not need it.
The launcher creates temporary test credentials, uses the real broker identity imports, and records actual dropped receipts.
The process-restart test runs the built package with no executables on PATH, kills its writer after an unknown result, and compares the recovered receipt and bytes.
The Python suite also exchanges exact bytes and digests with the built TypeScript package:
more than one MiB from Python to TypeScript, and 4097 bytes in the reverse direction
within the fixture's smaller spare volume.
Agent reference-policy tests use an explicit CLI adapter and fake `sp` to check policy in isolation.
Those tests do not qualify ScratchPad storage, identity imports, or native recovery.
