# Sustained native client qualification — 2026-09-29

Work item: [SDK #22](https://github.com/synadia-ai/agent-fabric-sdk/issues/22).
Implementation: [SDK #41](https://github.com/synadia-ai/agent-fabric-sdk/pull/41) and
[ScratchPad #1172](https://github.com/synadia-ai/scratchpad/pull/1172).
The [fixed workload contract](../native-sustained-plan.md) defines the gates.
The [counted JSON](2026-09-29-native-sustained.json) preserves unrounded measurements and source identity.
PR and issue state belongs in those trackers.

## Result and interpretation

The fixed 30-minute workload passed: 360 artifact publications and 5,158,993,920 independently verified bytes
in 1,800.060 seconds. Both actual receipt-loss cases recovered the exact stored receipt after writer process death
and service-instance restart. The worst paired cycle took 3,641.298 ms against a ten-second allowance.
The maximum scheduled start delay was 22.897 ms.

Publication times show no substantial history-linked degradation within this window.
The 32 MiB median from the first to the fourth quarter changed from 2,292 to 2,323 ms in TypeScript
and from 2,330 to 2,336 ms in Python. All four windows and their worst samples appear below.
Workspaces reached the largest spool size and then reused that space.
Native live content stayed near 82.6 MiB while the run transferred 4.805 GiB.
Physical file allocation and memory are separate measurements; memory is not asserted stable.
This evidence supports the current implementation for the measured workload. No runtime repair was needed.

## Workload and environment

One Linux arm64 container ran a real ScratchPad service with authenticated NATS imports and file-backed R1 storage.
It had four CPUs, 4 GiB memory, a 4 GiB memory-plus-swap limit, and no external network.
The Docker volume uses ext4 according to mount information. The runtime's `stat -f` reports the family as `ext2/ext3`.
Runtimes were Node 22.23.3, Python 3.12.14 through uv, Python SQLite 3.40.1, and Go 1.26.7.

Each language wrote a separate 128 MiB / 512-object volume under the same authenticated owner.
Both writers published concurrently every ten seconds, rotating 1, 8, and 32 MiB streams.
Each chunk differed by language, cycle, and index. The opposite language read every artifact as a separately authenticated grantee
and checked its complete size and SHA-256 digest against an independent oracle.
Each volume retained a canary and its last three artifacts. Grants lasted 20 seconds; references lasted 3,600 seconds.
The writer observed each old grant's deadline, released the retention, and collected after each cycle.
Workspaces remained open between the explicit fault checkpoints.

At cycle 60, the fixture withheld TypeScript's actual accepted publication reply; at cycle 120, Python's.
It compared each dropped receipt with stored service state before the writer received SIGKILL.
A new service instance opened against the existing broker and connection.
Each replacement writer reopened its workspace, observed the pending publication, recovered the exact receipt,
and completed a cross-language byte check. Both timed-run faults used 1 MiB artifacts.
The earlier 12-cycle rehearsal also passed both faults, with 8 and 32 MiB artifacts.

## Publication and read latency

Each quarter contains 45 cycles per language and 15 observations at each artifact size.
Values are milliseconds, rounded to three decimals. Publication includes encoding, SQLite work, and network work.
Intentional reply-loss timeouts remain in the 1 MiB worst samples in TypeScript Q2 and Python Q3.

| Writer / size | Statistic | Q1 | Q2 | Q3 | Q4 |
| --- | --- | ---: | ---: | ---: | ---: |
| TypeScript / 1 MiB | Median publish | 186.369 | 193.054 | 192.284 | 193.578 |
| TypeScript / 1 MiB | Worst publish | 189.288 | 2152.884 | 203.591 | 197.154 |
| TypeScript / 1 MiB | Worst cross-language read | 29.105 | 29.803 | 29.084 | 28.614 |
| TypeScript / 8 MiB | Median publish | 658.469 | 672.963 | 672.532 | 673.620 |
| TypeScript / 8 MiB | Worst publish | 682.253 | 712.776 | 694.552 | 691.809 |
| TypeScript / 8 MiB | Worst cross-language read | 191.256 | 189.260 | 182.007 | 181.298 |
| TypeScript / 32 MiB | Median publish | 2292.236 | 2332.925 | 2321.504 | 2323.479 |
| TypeScript / 32 MiB | Worst publish | 2309.249 | 2410.446 | 2349.115 | 2433.731 |
| TypeScript / 32 MiB | Worst cross-language read | 690.441 | 702.407 | 688.838 | 724.367 |
| Python / 1 MiB | Median publish | 185.322 | 190.705 | 192.518 | 190.584 |
| Python / 1 MiB | Worst publish | 189.169 | 198.015 | 2178.216 | 193.235 |
| Python / 1 MiB | Worst cross-language read | 29.290 | 29.586 | 29.405 | 28.723 |
| Python / 8 MiB | Median publish | 662.124 | 674.185 | 674.330 | 675.966 |
| Python / 8 MiB | Worst publish | 688.158 | 704.893 | 694.337 | 691.894 |
| Python / 8 MiB | Worst cross-language read | 189.282 | 193.013 | 184.760 | 182.284 |
| Python / 32 MiB | Median publish | 2329.968 | 2371.692 | 2355.040 | 2336.282 |
| Python / 32 MiB | Worst publish | 2348.452 | 2437.842 | 2376.304 | 2434.370 |
| Python / 32 MiB | Worst cross-language read | 689.637 | 700.229 | 687.764 | 721.464 |

Worst publication event-loop gaps were 223.240 ms for TypeScript and 192.416 ms for Python.
These measure the full publication path. They do not isolate SQLite flush cost or establish a deployment pause ceiling.

## Read availability during collection

Canary readers sampled once per second through the opposite language.
The labels below identify the volume's writer, so TypeScript's canary was read by Python.

| Volume writer | Successful background reads | Expected `closed` during collection | Worst read (ms) | Worst active coverage gap (ms) |
| --- | ---: | ---: | ---: | ---: |
| TypeScript | 1743 | 58 | 201.349 | 1059.303 |
| Python | 1742 | 59 | 231.793 | 1023.489 |

All 3,485 successful background reads matched the canary's exact bytes.
The 117 `closed` refusals occurred only during the corresponding collection interval.
Each collection was followed by an additional successful exact canary read: 360 such checks in total.
Both final reads after the full 1,800 seconds also succeeded.
Coverage checks examined the first read, successive read starts, and the final boundary of every active watch segment.
The two recorded restart pauses were 137.131 and 150.455 ms and were excluded from those active segments explicitly.

## Storage and memory

Every post-collection volume sample satisfied the 42 MiB / 128-object gates and held exactly the expected retentions.
Each database grew from 1,069,056 bytes to 33,615,872 bytes on the first 32 MiB publication.
It reached 33,619,968 bytes at cycle 5 and stayed there for all 175 remaining samples, including that cycle.
Sampled WAL size was zero for both clients.
Quarter maxima for workspace files were identical in all four quarters:

| Workspace | Database bytes | Rollback journal bytes | Combined bytes |
| --- | ---: | ---: | ---: |
| TypeScript | 33,619,968 | 57,968 | 33,677,936 |
| Python | 33,619,968 | 33,699,368 | 67,319,336 |

Python's exclusive SQLite connection retained a reusable rollback journal.
The qualification counts database, journal, and WAL together against the 96 MiB workspace gate.
These are file lengths. Native physical allocation below is measured separately from allocated file blocks.

| Sampled quarter maximum (bytes) | Q1 | Q2 | Q3 | Q4 |
| --- | ---: | ---: | ---: | ---: |
| Native stream live bytes | 86,593,728 | 86,593,759 | 86,593,773 | 86,593,824 |
| Native physical allocated bytes | 148,041,728 | 151,674,880 | 150,949,888 | 153,436,160 |
| TypeScript process lifetime RSS | 162,574,336 | 163,258,368 | 164,904,960 | 166,465,536 |
| Python process lifetime RSS | 49,131,520 | 49,270,784 | 49,283,072 | 48,537,600 |
| Combined broker/service process RSS | 731,512,832 | 761,241,600 | 763,715,584 | 775,372,800 |

File walks were non-atomic and had no vanished entries. These are post-cycle observations, not transient allocation peaks.
The native stream remained below 112 MiB and sampled physical allocation below 1 GiB.
Client process-lifetime RSS resets when that writer restarts. The combined fixture RSS includes the embedded broker and service;
it cannot be interpreted as service-only memory. Its sampled maximum increased across the window, so no memory plateau is claimed.

## Controls, regression, and review

- The real-data control rejected an actual read from the wrong reference.
- In each language, three retained 32 MiB artifacts fit. A fourth was refused with `capacity`, without a pending write.
  All three retentions remained present. Explicit release and collection freed at least 64 MiB and allowed new exact cross-language progress.
  This exercises client admission against real service quota and state. Existing conformance cases cover service enforcement separately.
- The final run required control evidence from the exact same source inventory.
- The two-minute rehearsal completed 24 artifacts and 343,932,928 verified bytes, including both exact recoveries.
- The retained Linux regression passed all 16 TypeScript and 18 Python native cases without skips.
  Its original ten-cycle 32 MiB probe completed 20 publications and 671,088,640 verified bytes.
- All 11 focused sustained-report tests passed on macOS and Linux. They reject incomplete or misleading evidence.
- The core service checker passed 53 required results and 9 behavioral controls in both normal and race modes.
  Its new storage case read 18,874,368 exact bytes, counted 40 objects, and verified that observation did not mutate state.
- All 22 core PR checks passed on the qualified fixture head. Wiki, prose, and ADR-link checks also passed.

Claude Opus 5.5 and an independent agent reviewed the controller and workers before the final run.
Resolved findings required exact canary checks throughout the interval, cleanup and exit-status evidence,
matching-source control evidence, rollback-journal accounting, and rejection of vanished-file observations.
The quota control was corrected to retain artifacts deliberately because the clients collect automatically under pressure.
These changes strengthen the qualification harness. Client runtime, service runtime, identity, and API code did not change.

## Exact inputs and retained evidence

| Input | Revision |
| --- | --- |
| SDK workload and workers | `f19ec8a158d151eef20944fde088d9ef206e02db` |
| ScratchPad fixture | `ba5aa1d68c51a6619bef2a6cbba80e284b404793` |
| Protocol checkout | `3b9a20d88ef3e42ff4890e31c400aad4f0f836a4` |
| Delivered SDK runtime used unchanged | `17b27bee95332b49302825998e7dff3a5ec1b461` |

The selected source inventory contains 1,513 files. Hashes were compared with Git blobs before and after the run.
Its SHA-256 is `7fb79e4605120b34e5b28eed4ef9c94b84015fc177b6e6fbb248b1b570dadde9`.
The image ID is `sha256:e0b26d3adb9b0c480d0abaf5b6b180fa35287404d67767c0e5b935746aebb391`.
The control evidence SHA-256 is `ff82192293c7327d645a0574006e5fb3622d67994aa06e89a2f45f3a34f15da6`.
All three input checkouts were clean during qualification. This report is a subsequent documentation commit.

Original results, every cycle, canary samples, fault receipts, matching controls, source inventories, review, and logs are retained at
`scratchpad-redesign-evidence/2026-09-29-sdk-sustained/` beside the private checkouts.
`make-report.py` there reruns the committed controller's evidence checks and compares the complete recomputed summary with the original.
The checked-in counted JSON was produced by that script after the container exited successfully without an OOM kill.
Test credentials remained outside exported evidence.

## Limits and next use

This is a finite R1 component qualification on one Linux architecture and local filesystem.
It covers service-instance restart with a live broker and actual writer process death after an observed unknown result.
It does not cover broker restart, service-process death, arbitrary crash points, OS failure, or R3 failover.
The complete reconnect-buffer matrix, independent maintenance actors, other platforms/filesystems,
public npm/PyPI installation, and general latency or memory bounds remain outside this result.
The nats-py raw-header visibility limitation remains documented in the client contract.

Use the measured result alongside the earlier Live qualification when starting friendly-user work.
The sustained scripts and fixture require no binary release or deployment-pin change.
SDK and Live integration state remains in their PRs.
