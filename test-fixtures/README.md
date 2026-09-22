# test-fixtures/

Shared by the TypeScript and Python suites, so both packages are tested
against the same bytes. Everything here is either vendored — copied, with
its source and commit below, never edited — or the fabric's own.

| Path | What | Source |
| --- | --- | --- |
| `schemas/edge.json` | The edge record's JSON Schema, the contract every record must validate against (afo-design.md §6.2) | `synadia-agent-fabric` `docs/schemas/edge.json` at `f92ba41` (last changed in `2c93858`, 2026-09-16) |
| `schemas/scratchpad_grant.request.json`, `schemas/scratchpad_grant.reply.json` | The grant request's two shapes: what a requester sends a reference's creator, and what the creator answers | `agent-fabric-examples` `tools/` at `1e783a3` (last changed in `fffa221`, 2026-09-17) |
| `identity/keys.json` | Throwaway user nkeys (alice, bob, carol, dave, erin). **Test-only. Never reuse.** | `synadia-agents` `test-fixtures/identity/` at `d558aff` (branch `mario/sdk-split`) |
| `identity/nkey-noaccounts.conf` | One nkey user (alice), global account `$G`, port-less | as above |
| `identity/operator/` | Operator mode: `operator.conf` (ACME, APP, SYS preloaded), `alice.creds` and `carol.creds` (ACME), `bob.creds` (APP), `keys.json`. ACME exports `agents.>` and `$SRV.>`, which APP imports, so bob can discover and prompt ACME's agents and send them grant requests. Real `A…`/`U…` keys, so an agent ID has the `{account}.{user}` form `edge.json` requires | as above, `identity/operator/` |
| `interop/py-agent-service-host.py`, `interop/ts-agent-service-host.ts` | Minimal hosts for the cross-language tests; `TRACE=1` runs the fabric, otherwise the protocol SDK alone | Adapted from `synadia-agents` `test-fixtures/interop/` at `c9d7bcb`, where tracing still lived in the SDK |

The configs are port-less: the harnesses pass `-a 127.0.0.1 -p <port>`.
Lint them with `nats-server -t -c <file>`.

When the contract changes, copy `edge.json` again from `synadia-agent-fabric`
(or the grant request's schemas from `agent-fabric-examples`) and update the
commit above; the schema tests in both suites then say whether the packages
still write valid records and requests.
