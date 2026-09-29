# Linux native client preparation

Date: 2026-09-28. This report records a finite qualification window.
[SDK #22](https://github.com/synadia-ai/agent-fabric-sdk/issues/22) owns qualification scope and remaining work.
The [counted evidence](2026-09-28-linux-native-preparation.json) contains every spool cycle, report hashes, and source identity.

## Source and environment

| Input | Revision or configuration |
| --- | --- |
| SDK tests and qualification tools | `84fee0d3ee43fb6e353f19ca722c128bb112660e` |
| Core service and test fixture | `541b8c107d5b44cfcedca9c43cbac84db7432e2e` |
| Protocol SDK checkout | `3b9a20d88ef3e42ff4890e31c400aad4f0f836a4` |
| Linux | arm64, kernel 6.8.0-117, glibc 2.36 |
| TypeScript runtime | Node 22.23.3; bundled SQLite 3.51.3 |
| Python runtime | Python 3.12.14 through uv; SQLite 3.40.1 |
| Go fixture toolchain | Go 1.26.7 |
| Container limits | Four CPU quota; 4 GiB memory; no external network |
| Workspace and service storage | Linux ext4 Docker volume; no Mac filesystem bind mount |

The final source inventory matched all selected host and container files byte for byte.
It covered 213 SDK files, 1,178 core files, and 115 protocol files.
Its aggregate SHA-256 was `aab3d27c5dfeaae5c295b765488986acae3f2fdf2314ce997a10a5efee1c1519`.
The raw inventory and logs remain in the retained evidence archive.
The container sees eight host CPUs; its configured CPU quota is four.

The fixture starts actual authenticated NATS ingress, activated imports, and file-backed storage with one replica.
The run qualifies component behavior on Linux. It does not exercise the fabric's deployment or three-replica storage.
The Linux image reuses qualified development dependencies and checks their lockfiles before rebuilding the selected sources.
This procedure establishes no clean npm/PyPI installation result.

The pass changed tests, fixtures, qualification tools, and documentation.
Client runtime code, service runtime code, Fabric identity, wire operations, skills, and deployment pins were unchanged.

## Real-service recovery and lifecycle checks

All 16 TypeScript cases and 18 Python cases passed, with no skips.
The run includes the previous publication, quota, scope, lost-reply, reconnect, process-death, and cross-language cases.
The new cases cover these boundaries:

| Boundary | Observed result |
| --- | --- |
| Delayed grant | The proxy holds an actual outgoing request. A second connection receives a definite service refusal while the original remains unresolved. |
| Pending recovery | The workspace retains the exact grant through closure, reopening, and the later refusal. Releasing the original request produces the expected grant. |
| Authorization | The held request matches the published scope and intended reader. The permitted reader receives exact bytes; another reader is denied. |
| Failed construction | A mismatched workspace binding fails, releases ownership, and leaves the original receipt and content available. |
| Close during publication | Close refuses new calls and waits for active input. Another factory cannot acquire the workspace while that input remains active. |
| Successful completion | Reopening returns the exact original publication receipt. |
| Failed input | Close joins the failed publication. Reopening has no pending operation, and the next publication uses writer command one. |
| Cancelled Python close | Cancellation does not release ownership beneath active work. A second close completes, then reopening succeeds. |

The delayed-grant cases inspect the underlying service refusal, including its definite and remote origin.
They also observe the original grant's actual acceptance before final recovery.
The checks do not simulate the ScratchPad service or infer acceptance from request arrival.

The mutation runner removes the protection for an earlier unknown grant in isolated source copies.
Both language cases rejected that mutation at the specific later-refusal assertion.
Both existing grant-durability mutations also failed at the expected workspace-reopening assertion on Linux.
Setup failures cannot satisfy the control.
Nine report-checker tests also cover incomplete reports, failed or skipped cases, and credential export paths.

The final full package checks on macOS passed 407 TypeScript tests and 446 Python tests.
Each language skipped one optional archived tracing-host test; no native case was skipped.
Those runs used Node 22.22.3 and a uv environment with Python 3.12.3.
TypeScript checking, focused lint and formatting, Python source/test type checking, and focused Ruff checks passed.
A final type-check correction gave the report test's XML cases a distinct local variable name.
Its nine behavioral checks passed again; measured native sources and qualification tools were unchanged.
Harness add-ons and reference-agent package suites were not repeated in this pass.

## Ten publication cycles per language

An initial Linux baseline ran the previous 12 TypeScript and 13 Python cases, then ten 7 MiB cycles per language.
All 20 publications completed and verified 146,800,640 bytes.
Every closed workspace database measured 7,372,800 bytes throughout those cycles.
Worst observed scheduling gaps were 45.258 ms for TypeScript and 38.043 ms for Python.
Its source inventory was captured later from the retained immutable image, whose identity appears in the counted evidence.

The final run used ten distinct 32 MiB artifacts per language.
Each chunk carries its cycle and index, so later cycles cannot reuse the earlier artifact's content.
Each cycle publishes, reads and checks the complete digest, releases retention, collects, closes, and reopens the workspace.
The checks compare writer commands and both languages' complete artifact digests.
All 20 final publications completed and verified 671,088,640 bytes.

| Final measurement | TypeScript | Python |
| --- | ---: | ---: |
| Publication time range | 2,167–2,322 ms | 2,184–2,448 ms |
| Worst observed scheduling gap | 176.251 ms | 169.546 ms |
| Closed database size in every cycle | 33,615,872 bytes | 33,615,872 bytes |
| Collected objects in first cycle | 66 | 66 |
| Collected objects in each later cycle | 69 | 69 |

The final fixture reserves 512 objects and 128 MiB for the measured volume.
Ordinary fixtures retain their smaller scopes; the pass changes no product capacity limit.
No unrelated container workload ran during the final spool window.
The Mac host and its Linux virtual machine remained shared development resources.

The publication timer includes source generation, encoding, SQLite writes, and NATS operations.
The requested five-millisecond sampler covers the complete publication window.
The report preserves actual sample counts and the worst gap across every cycle.
These gaps cannot be attributed solely to SQLite flushes.
TypeScript records sampled RSS; Python records process-lifetime maximum RSS. Their scopes differ.

Database reuse held across both finite windows.
Ten cycles establish no sustained-load guarantee, latency ceiling, or immunity to every growing-history workload.
The larger artifact uses more workspace storage and shows larger scheduling gaps in this configuration.
Those observations justify monitoring representative workloads before changing the clients' persistence strategy.

## Review and evidence limits

Claude reviewed the proposed checks without editing or running them.
The final cases include its requested scope comparison, definite-service-refusal check, and exact receipt comparison.
An independent review also tightened image source replacement, filesystem recording, and separation of exported evidence from fixture credentials.
The final read-only review found no material defect in the changed sources or retained results.

A preliminary delayed-grant run exposed an incorrect fixture expectation about grant generation.
Grant generation follows the acceptance revision; the fixture had assumed a one-step increment.
The correction preserved exact principal, scope, retention, and deadline comparisons.
The failed run remains recorded; no product repair was required.

The delayed case proves one reordered-delivery sequence. It does not establish the full NATS reconnect-buffer matrix.
The lifecycle cases cover explicit failure points; they do not exhaust every startup or shutdown schedule.
Independent maintenance actors, sustained workloads, other Linux architectures, Windows, and network filesystems need separate qualification.
The documented nats-py raw-header visibility limit remains unchanged.

Use the [Linux qualification command](../../scripts/native-linux/README.md) to reproduce this pass.
Use the [native client guide](../scratchpad-native.md) for application behavior and operator recovery.
The retained local archive is kept outside this repository, at `/path/to/evidence/2026-09-28-preparation`.
Exported evidence excludes the scratch directory where fixtures create credentials.
