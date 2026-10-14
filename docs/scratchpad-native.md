# Native ScratchPad clients

## Client contract

The native clients use ScratchPad's current `api/v2` over the tenant's existing NATS import.
The service, identities, agent protocol, and Fabric reference policy remain the existing contracts.
Both languages use the same protocol and canonical content identities.

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
References use a service-issued `sp-r1:` token when `reference.info` enables the feature.
The token has 66 ASCII characters and identifies one retained immutable path.
Clients also accept the existing `sp-ref:` v2 form. Neither form supplies authentication.
An older service's explicit `invalid` reply to `reference.info`, or `enabled: false`, selects the full form.
Transport, authentication and malformed-reply failures propagate; they do not select a fallback.
An unsupported capability version or different advertised limits also fails without fallback.
Existing deployments omit the optional lifetime and admission fields.

### Activate short references

Keep service publication disabled until all participating native clients and CLI readers support `sp-r1:`.
The `scratchpad_refs_ok` discovery metadata does not negotiate reference formats.
For harness readers, select a compatible `sp` through `SCRATCHPAD_BIN` before activation.
Coordinate activation with the service upgrade; publication changes require compatible service workers too.

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
  nc,
  volume: "Writer",
  creator: "agents.prompt.writer.demo.main",
  dir: "/var/lib/my-agent/scratchpad", // private; preserve across restarts
});
await pad.recover();
const published = await pad.publishBytes(
  new TextEncoder().encode("result"),
  "/result.txt",
  {
    operationId: "task-123-result",
    ttlSeconds: 600,
  },
);
await pad.grantRead(published.reference, {
  account: readerAccount,
  user: readerUser,
});
// The receiving agent uses its own connection and does not need a writer directory.
const reader = await scratchPadReader({ nc: readerConnection });
const bytes = await reader.readBytes(published.reference);
await pad.close(); // closes the workspace; the NATS connection still belongs to the agent
```

Pass `pad` to `scratchPadExtension` and `grantRequestEndpoint` through their existing ports.
`resolveReference(token)` returns the expanded descriptor for programmatic use (`resolve_reference` in Python).
Ordinary `commit` and publication results return one token; pass that token unchanged to the model.
The extension uses the port's optional resolution operation to find the creator of a short token.
It verifies that creator through Fabric discovery and keeps the exact received token in grant requests.
Existing ports that handle only full references remain valid.

Each short-token content read calls `reference.stat`, even when its metadata is cached.
The service checks current token validity and content authorization before returning the initial stat.
Subsequent ranges use the expanded descriptor with normal authorization.
Both forms enforce the descriptor deadline before and after each content range and before successful completion, including empty files. Each reader caches at most 64 metadata expansions for creator and grant routing.
A fresh reader, or eviction from this disposable cache, requires another service lookup.
`commit(text, path, trace)` returns a reference; `read(reference, trace)` returns verified UTF-8 text.
`nativeScratchPadFromEnv(env, { nc, creator })` uses `SCRATCHPAD_VOLUME`, `SCRATCHPAD_BOOTSTRAP_FILE`, `SCRATCHPAD_DIR`, and `SCRATCHPAD_GRANT_TTL_S`.
ScratchPad is disabled when both the volume and bootstrap file are unset.
A configured volume or bootstrap requires a persistent directory; there is no temporary-directory default.
Both reference agents use the native factory. `SCRATCHPAD_BIN` belongs to the separate CLI adapter.

### Import a public bootstrap descriptor

`SCRATCHPAD_BOOTSTRAP_FILE` names a public JSON file that selects one exact creation request.
TypeScript also accepts `bootstrapFile`; Python accepts `bootstrap_file`.
The client derives the volume when it is omitted. An explicit different volume refuses.
Keep the file and the private workspace across restarts.

```ts
const pad = await nativeScratchPad({
  nc,
  creator: "agents.prompt.writer.demo.main",
  dir: "/var/lib/my-agent/scratchpad",
  bootstrapFile: "/etc/agent/scratchpad-bootstrap.json",
});
await pad.recover();
```

The descriptor has exactly `version: 1`, `principal`, `volume`, `admission`, and `creation`.
`creation` contains the complete `operation_id` and `trace`; `admission` contains slot, generation and operation identifier.
It contains no credentials or target and supplies no authentication authority.
The [public schema](../test-fixtures/schemas/scratchpad-bootstrap-v1.json) describes the fields.
Consumers refuse duplicate or unknown keys, invalid NKEYs, invalid request fields, and files above 4096 UTF-8 bytes.
The native SDKs also retain their existing safe integer counter ceiling of 9007199254740991.

The client checks the authenticated principal and exact discovered admission before saving a new SQLite state.
It saves the complete creation request before transmission.
An existing matching state is preserved; differing creation, volume, principal or admission refuses.
Restore and disposal state cannot be adopted. Accepted writer commands never cause an implicit reset.
An unknown creation keeps its saved request. Exact owner recovery does not require admin ensure.
An `exists` refusal never permits target adoption; `expired` or `closed` alone does not settle an earlier possibly sent request.
A later admission requires a separate workspace and leaves the earlier recovery state intact.

The CLI adapters accept the same file option and environment variable, require an explicit persistent directory for import,
and pass `sp init --bootstrap-file` to a compatible command line.
The shared harness wrapper supplies that flag from configuration; the model does not supply it.
Reusable setup exports the bootstrap file variable without a default `SCRATCHPAD_VOLUME`, so unaware consumers remain disabled.
Existing APIs without a bootstrap file retain their creation behavior.

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
Its current records contain one pending operation, one optional lease renewal, the last publication receipt, and at most 16 grant ledger entries.
After whole-volume release, it keeps one terminal result and its exact plan.
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
A short publication saves its creator and canonical path list with the command before transmission.
Recovery reads `reference.receipt` with that complete saved intent.
A plain checkpoint receipt or a changed creator/path list cannot settle this publication.
A `not_found` receipt read leaves the intent pending; it does not prove that an earlier request failed.
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
Automatic delegated-access expiry can clear a writer's current principal and write permission while preserving its receipt.
The stored receipt still names its original principal and exact command. It grants no artifact access.
Only that authenticated writer can recover the matching receipt until reset, reassignment, replacement, or terminal retirement ends the window.

NATS JavaScript can buffer requests during reconnect. The client uses a bounded flush before each request and does not add retries.
After transmission, loss, cancellation, or malformed replies leave mutations unknown.
Python task cancellation propagates as `asyncio.CancelledError` and preserves the saved mutation
for explicit recovery. It is not converted into an ordinary exception that a handler might ignore.
A later definite refusal cannot establish that an earlier unknown grant or maintenance request had no effect.
The saved control request remains until acceptance or an applicable fence establishes the outcome.
Python uses nats-py's public connection and message APIs. Those APIs collapse repeated header names
and replace malformed header text before this client receives it. The client validates the parsed
headers and strict body JSON; it cannot prove the original raw header bytes or multiplicity.
Applications must account for that upstream parsing limitation.

### A closed volume without a saved continuation

Native maintenance resumes only its saved interval.
If another operation closed the volume, `maintain()` refuses with `closed`, including after reopening the workspace.
A `recover()` result of `ready` means the journal has no pending work. It does not mean the remote volume is open.
The refusal preserves the head, writers, retained roots, and closed revision.

On an existing deployment, an operator must finish that interval through the
authenticated public service API:

1. Quiesce the volume's mutation actors. Identify its owner, volume, and incarnation from `describe()`.
2. Read the current volume with `volume.get`. Confirm that it is closed and record its exact revision.
3. Inspect `maintenance.plan` for that target and revision. Check the live roots and proposed deletions.
4. Apply `maintenance.apply` with that same target and revision, then read the volume again.
   A changed revision requires a fresh inspection; do not silently adopt a different interval.
5. Confirm the volume is open and retained references are readable before resuming the writer.

On reusable deployments, a separate private lifecycle worker can finish this recorded
interval while preserving the head and live protection promises. The existing format
uses the coordinated operator procedure above.

The existing service's volume getter, collection planner and collection application expose these operations.
Do not reset a writer or discard its journal merely to reopen a closed volume.
Do not attach a new CLI workspace to the native writer slot.
The service fences maintenance by revision; it does not record a separate maintenance-owner identity.
This existing-format procedure requires coordinated operators. Independent concurrent
public maintenance actors remain outside the qualified scope.

### Reusable lifetimes

`info.scopes[].admission` selects one reusable lifetime. A new writer saves this
binding in SQLite before its first creation request. An existing workspace keeps
its saved binding across restarts. An older unfinished creation without a binding
cannot adopt a newly admitted lifetime with the same volume name.
The binding supplies no authentication; the NATS connection still identifies the caller.
New finite publication retention is capped at the observed lease deadline.
An elapsed deadline is refused before saving or sending the publication.
Retries keep their saved deadline; the client never renews a lease implicitly.

`describe().volume.lifetime` reports the phase, absolute expiry and grace deadline,
recovery-read availability, lease limits, and reserved metadata allowance.
An expiry of zero denotes a durable volume. The client invents no lease duration.

| TypeScript                                        | Python                                                    | Operation                                                      |
| ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `renewLease(until)`                               | `renew_lease(until)`                                      | Persist and request one absolute Unix deadline in seconds.     |
| `planRemoval(path, { operationId })`              | `plan_removal(path, operation_id=...)`                    | Read-only removal plan for an initialized writer.              |
| `applyRemoval(plan)`                              | `apply_removal(plan)`                                     | Save and apply that exact plan; return the checkpoint receipt. |
| `planVolumeRelease({ operationId, endPromises })` | `plan_volume_release(operation_id=..., end_promises=...)` | List the head and protection promises the release would end.   |
| `applyVolumeRelease(plan)`                        | `apply_volume_release(plan)`                              | Save and apply that exact terminal decision.                   |

The agent chooses what to remove when its quota is full. Selective removal uses
the reported metadata reserve within its bounds. A receipt confirms the new head;
retentions and live grants can still protect removed content until their promises end.
The private worker collects unreachable objects. Removal does not create a handoff
reference. `recover()` returns its exact receipt with `kind: "remove"`.

Whole-volume release can irreversibly delete all artifacts and end every promise
in its plan. `endPromises` defaults to false; select true only after reviewing and
authorizing those effects and completing any required verified export.
The client keeps this intent pending until `capacity_returned` is true.
`disposed` alone does not return the admission charge. `recover()` returns the
result under `release` with `kind: "volume_release"` and can resume through an empty
owned-scope list. It never binds the workspace to a successor lifetime.
Each release plan includes an opaque `incarnation` binding to the deployment's native streams.
The client saves whether it observed acceptance of its exact release fence.
If slot reuse occurs first, the service can return `generation_retired` after proving that the saved generation ended in the same incarnation.
The client then records `disposed: true` and `capacity_returned: true`.
If it never observed its own fence acceptance, the high-level result also contains `acceptance_unknown: true`.
This marker preserves uncertainty about which terminal operation won. Capacity return and operation acceptance remain separate outcomes.
It is a local recovery field, absent from the wire result.
Generic `fenced`, `denied`, or missing-volume responses cannot settle a previously unknown release.
After a saved release returns `conflict`, recovery can request a read-only plan for
the exact saved request. Only a strictly greater native sequence for the same
incarnation, slot, generation, and target proves the old release fence cannot win.
The client then clears only that release intent and reports `fenced`. The lifetime
remains nonterminal. Inspect the reported lifetime and renew before ordinary work
if needed. This outcome claims neither disposal nor capacity return.
Review a new plan before another release attempt. An unknown or mismatched probe,
or a previously observed accepted fence, keeps the saved release pending.
The completed workspace refuses new mutations. Repeated recovery returns its saved result; repeating apply requires the complete identical plan.

After an unknown lifecycle mutation, call `recover()` or repeat the exact saved
operation. A changed deadline or plan is refused while the first intent is pending.
Lease renewal can coexist with an unknown ordinary operation. The client saves
one absolute renewal deadline without changing the original request or its spool.
`recover()` settles renewal first and returns `kind: "renew"`; call it again to
recover the original operation. Other mutations wait while renewal is unresolved.
Renewal needs a saved target and admission binding, even if writer initialization
has not completed. It cannot coexist with volume release or completed disposal.
An already achieved renewal still recovers after its requested deadline passes.
If the service instead returns definite `expired` for an unachieved saved deadline,
the client clears only that renewal and reports the refusal. The ordinary pending
operation stays unchanged. If the same lifetime is still renewable, request a new
absolute deadline, then recover the original operation. The local clock, `invalid`,
and unknown outcomes do not clear a previously sent renewal.
These optional operations require a reusable deployment. Existing deployments,
references, and workspaces keep their existing absent-field behavior.

On a reusable volume, `maintain()` saves its closure and waits for private collection.
Recovery observes the volume open with the exact saved collection epoch. A newer
epoch positively fences delayed work for the old interval. The client clears only
that collection continuation and reports `fenced`; a new operation can then proceed.
This path sends no public
collection application and invents no collection counts from current usage.
If the close reply was lost, the requested revision plus one identifies that
interval even when the private worker reopened it before the next observation.

### Artifact bounds

Each publication replaces the head with one file at the selected path. It does not merge previous files into the new head.
Prior references remain readable while their retention and grants remain valid.
Transfers use 512 KiB chunks. `publishStream` spools one artifact with bounded chunk memory.
`publishBytes` makes an owned input copy; use the streaming method for large content.
`readBytes` defaults to a 16 MiB whole-file allowance and verifies bytes before returning them.
`readStream` requires an explicit allowance and verifies the complete file when iteration reaches EOF.
Streamed bytes are provisional until successful completion; write to a temporary destination before exposing a download.

`release(reference)` releases a finished handoff only when no live grant still names it.
An expired short token no longer resolves; use `maintain()` to release expired unprotected retention handles from the current volume view.
`maintain()` releases expired unprotected pins and closes its own collection interval.
On a reusable deployment, it observes private maintenance completing that interval;
on an existing deployment, it performs the collection.
The client checks capacity and retention before saving a new publish command.
Admission conservatively allows space for existing content plus the new artifact, even when some objects could be shared.
All eight occupied retention slots produce an explicit capacity refusal; live handoffs are never evicted to make space.

Synchronous work can delay the caller's event loop during larger publications.
Measure encoding, database writes, and network work on the selected runtime and local filesystem.
No Windows or network-filesystem qualification is implied.
Full directory sync/hydrate remains the `sp` client path.

### SDK validation

The package suites include canonical codec vectors and transport failure cases.
Run the TypeScript suite from `typescript/` with `npm test`.
Run the Python suite from `python/` with `uv run pytest`.
The shared vectors live in [`test-fixtures/scratchpad`](../test-fixtures/scratchpad/README.md).

These checks exercise SDK behavior. Deployment qualification also needs an authenticated ScratchPad service.
Check exact artifact bytes, receipts, reader permissions, lost replies, and recovery against that service.
Exercise the selected runtime, filesystem, quotas, and workload before relying on deployment capacity.
