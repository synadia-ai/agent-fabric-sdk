# Native client qualification: recovery, quotas, and local spool cost

Date: 2026-09-28. These are recorded local observations, not live delivery status.
[SDK #22](https://github.com/synadia-ai/agent-fabric-sdk/issues/22) owns remaining qualification work.
The [counted results](2026-09-28-native-friendly-qualification.json) preserve the observations and measurement windows.

## Source and environment

| Component | Revision or runtime |
| --- | --- |
| SDK tests and probe | `e328a29c8d99bdeae0e7c7b4853eb810a23c615e` |
| SDK product implementation | Unchanged from `e24d6348d77fa8dc147625fc158f3208bba00330` |
| Core service fixture | `7ca1f326`; [ScratchPad #1168](https://github.com/synadia-ai/scratchpad/pull/1168) |
| Core product implementation | Unchanged from `333a0e2cadcedc669941ce3ce41e2b6095051aa7` |
| Protocol SDK development checkout | `3b9a20d88ef3e42ff4890e31c400aad4f0f836a4` |
| Host | macOS arm64; shared development host |
| Clients | Node 22.22.3; uv environment with Python 3.12.3 |

The fixture runs a real local NATS server, file-backed JetStream, activated imports, and authenticated users.
These tests introduce no simulated ScratchPad service and require no `sp` executable.
They do not repeat the deployed Linux image qualification or the six-role model workload in Live #42.
No identity, protocol, runtime client, binary, skill, or deployment pin changed.

## Counted test results

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| TypeScript unit | 315 | 0 |
| TypeScript integration | 88 | 1 |
| Python package | 432 | 1 |
| Real-service native cases, included above | 12 TypeScript; 13 Python | 0 |

Each language's skipped test needs an optional archived pre-tracing host checkout.
Neither skipped test covers native ScratchPad behavior.
Lint, formatting, TypeScript checking, and Python checking of the source and new test file passed.

Eight new cases run in each language:

| Case | Observed evidence |
| --- | --- |
| Accepted grant, close, and collection with lost replies | Each case withheld one real control reply and one real observation. Reopened workspaces replayed two identical request attempts in total. |
| Pending control | A different publication was refused before recovery. Saved intent survived workspace closure and reopening. |
| Collection recovery | Each close/apply case reclaimed three unreachable objects and preserved the head, writer receipt, and 22 retained bytes. |
| Actual reconnect | Each client observed disconnect and reconnect, then recovered one exact receipt and 26 bytes without another accepted command. |
| Operator-closed interval | Two maintenance calls refused takeover. Ready recovery retained the last receipt and left the closed state unchanged. Explicit owner collection restored progress. |
| Concurrent calls and fixed slots | One writer queued eight publications and sixteen grants. Further offers refused. Two authenticated readers verified all sixteen handoffs. |
| Byte headroom | A 3 MiB retained artifact blocked a 6 MiB candidate. Release and collection deleted eight objects and 3,146,076 bytes. |
| Object headroom | Three retained deep paths occupied 54 objects. Release and collection deleted 36 objects and 1,804 bytes. |

Both quota cases preserved the protected content, head, writer, grants, and pins on refusal.
Maintenance legitimately advanced the volume revision during preflight.
After collection, the same operation ID succeeded without a skipped writer command.
An intrinsically oversized 8.5 MiB stream was also refused before a new publication intent.

Existing cases also passed: denied scopes, Go interoperability, exact publication recovery after process death, expiry, Python cancellation, and retention reuse.
The Python suite exchanged exact bytes with the built TypeScript package.

## Checks that reject broken recovery

The core fixture passed five focused results and two registered source mutations.
The mutations omit accepted-reply dropping or target correlation and fail at their intended assertions.
Claude review tightened maintenance replay checks to exact, definite service refusals: `closed` and `conflict`.
A separate red-to-green check rejects control counters after the proxy disconnects.

The SDK mutation runner removed durable grant-intent storage in isolated source copies.
Both language tests failed specifically when reopening the workspace.
Setup failures were excluded from those results.
The unmodified source checkout passed the final suites.

An intermediate test incorrectly expected a ready result without its valid last publication receipt.
The corrected test compares that complete receipt and unchanged closed state.
This was a test expectation repair; no product repair was needed.

## Three 7 MiB publication cycles per language

Each cycle generated distinct chunks, published them, verified all bytes and their digest, and reclaimed obsolete content.
The same workspace was closed and reopened between cycles.
All six publications completed and verified 44,040,192 bytes in total.
The three cross-language digest pairs matched.

| Measurement | TypeScript | Python |
| --- | --- | --- |
| Publication times, in cycle order | 956, 896, 902 ms | 1,034, 931, 963 ms |
| Worst observed scheduling gap | 439 ms | 441 ms |
| Closed database size, every cycle | 7,372,800 bytes | 7,372,800 bytes |
| Collected objects, in cycle order | 16, 19, 19 | 16, 19, 19 |

The publication timer includes source generation, hashing, encoding, SQLite writes, and service requests.
A requested 5 ms sampler covers the full publication window, including observations before and after it.
The JSON records actual sample counts and windows.
TypeScript RSS is sampled; Python RSS is the process-lifetime maximum. Neither establishes an exact memory ceiling.

An earlier trial observed a 786 ms TypeScript gap and a 318 ms Python gap.
The final probe corrected collection accounting to include objects present immediately before collection.
Those earlier timing observations remain valid and show variation on the shared host.
Do not treat the final table as an upper bound or evidence that every pause comes from SQLite.

Database reuse held across these three cycles; they do not constitute a soak.
The measurements justify tracking event-loop responsiveness on selected Linux deployments before changing durability or execution strategy.
No runtime-library redesign follows from this local probe.

## Remaining boundaries

The new reconnect case follows an accepted publication whose reply was lost.
It does not qualify delayed delivery of every buffered control request.
Concurrent calls use one serialized writer; independent maintenance actors remain unqualified.
Startup/shutdown failure combinations, larger spools, sustained load, and selected Linux scheduling costs remain in #22.
The documented nats-py raw-header visibility limit is unchanged.

Registry installation, Windows, network filesystems, and arbitrary production capacity are outside this run.
Use the [native client guide](../scratchpad-native.md) for commands, operator recovery, and reproduction.
