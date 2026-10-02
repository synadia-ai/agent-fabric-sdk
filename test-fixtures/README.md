# test-fixtures/

Shared by the TypeScript and Python suites, so both packages are tested
against the same bytes. Everything here is either vendored, with its source
and commit below, or the fabric's own. Schema text changes and the additive
grant-request reference pattern are recorded below.

| Path | What | Source |
| --- | --- | --- |
| `scratchpad/` | Canonical content bytes, rejection cases, full and short references, and an escaped JSON byte-bound intent | Protocol vector set `scratchpad-v2-vector-build-2f59c514` and locally generated public reference vectors; [vector details](scratchpad/README.md) |
| `schemas/edge.json` | The edge record's JSON Schema, the contract every record must validate against (the fabric's design, §6.2) | The fabric's design documents, `docs/schemas/edge.json`: the constraints as at `f92ba41` (last changed in `2c93858`, 2026-09-16); the texts reworded here for publication on 2026-09-29, the source to follow |
| `schemas/served.json` | The served record's JSON Schema: a harness plugin's binding of a thread to the harness's own thread ID, two per received prompt (the fabric's design, §8.3) | The fabric's design documents, `docs/schemas/served.json`: the constraints as at `5b13989` (last changed in `235e73f`, 2026-09-17); the texts reworded here for publication on 2026-09-29, the source to follow |
| `schemas/sp-grant-request.json`, `schemas/sp-grant-reply.json` | The grant request's two shapes: what a requester sends a reference's creator, and what the creator answers | The fabric's design documents, `docs/schemas/`: the constraints as at `d0f4188` (last changed in `9b5a9d3`, 2026-09-22); from the examples repository's `tools/` until 2026-09-22; the request's texts reworded here for publication on 2026-09-29, the source to follow |
| `identity/keys.json` | Throwaway user nkeys (alice, bob, carol, dave, erin). **Test-only. Never reuse.** | `synadia-agents` `test-fixtures/identity/` at `d558aff` (the SDK split's branch) |
| `identity/nkey-noaccounts.conf` | One nkey user (alice), global account `$G`, port-less | as above |
| `identity/operator/` | Operator mode: `operator.conf` (ACME, APP, SYS preloaded), `alice.creds` and `carol.creds` (ACME), `bob.creds` (APP), `keys.json`. ACME exports `agents.>` and `$SRV.>`, which APP imports, so bob can discover and prompt ACME's agents and send them grant requests. Real `A…`/`U…` keys, so an agent ID has the `{account}.{user}` form `edge.json` requires | as above, `identity/operator/` |
| `identity/operator/dave.creds` | A third ACME user, dave (the user nkey `identity/keys.json` names dave), for a caller in the agents' own account: ScratchPad grants only within a reference's account. Its user JWT has the claims of alice's, signed with ACME's seed in `identity/operator/keys.json` | Minted here on 2026-09-27; the SDK's fixture has two ACME users |
| `interop/py-agent-service-host.py`, `interop/ts-agent-service-host.ts` | Minimal hosts for the cross-language tests; `TRACE=1` runs the fabric, otherwise the protocol SDK alone | Adapted from `synadia-agents` `test-fixtures/interop/` at `c9d7bcb`, where tracing still lived in the SDK |
| `durable/` | The seven JetStream resources of the durable-execution library `@synadia-ai/durable` / `synadia-durable` (prefix `de`): three streams, three key-value buckets and an object store, in the JetStream API's stream configuration shape, with `num_replicas` 3 and 256 MiB on each sized resource. The reference agents' durable tests create them, at one replica, before the worker starts | The fabric's onboarding: the configurations it applies to a tenant's account, as at `da5a9d5` (2026-10-02), dumped from the library 0.6.1's own provisioning at `f775586` |
| `interop/py-scratchpad-agent.py`, `interop/ts-scratchpad-agent.ts` | An agent with an in-memory ScratchPad for the cross-language grant request tests: reads references, hands its own to a verified caller, answers grant requests, and prints one JSON line per prompt, grant and request | The fabric's own |

The configs are port-less: the harnesses pass `-a 127.0.0.1 -p <port>`.
Lint them with `nats-server -t -c <file>`.

When the contract changes, copy `edge.json`, `served.json`,
`sp-grant-request.json` or `sp-grant-reply.json` again, byte for byte, from
the fabric's design documents' `docs/schemas/` and update its commit above; the
schema tests in both suites then say whether the packages still write valid
records and requests.

**The schemas' texts.** On 2026-09-29 their `description`, `$comment` and
`title` texts were reworded here for publication: no colleague, internal
decision or internal document named, no dated proposal, the rule in plain
words. That prose change preserved the constraints. `python/tests/test_schema_constraints.py` holds
the digest of each file with those texts removed: it moves only when a
constraint does, and a new copy updates it.

The grant-request fixture is synchronized with the proposed canonical Fabric
grant-request contract dated 2026-09-30. It accepts both `sp-r1:` and `sp-ref:`;
every other request constraint is unchanged. This extension follows the baseline
provenance in the table above. The proposal remains under review, with acceptance
and activation gated separately. See the [native client contract](../docs/scratchpad-native.md#activate-short-references)
for rollout requirements.
The durable-reference vector in `scratchpad/reference-short-v1.json` is generated
from the existing public v2 descriptor; see `scratchpad/README.md`.
