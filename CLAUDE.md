# CLAUDE.md — agent-fabric-sdk

The SDK for agents on the Synadia Agent Fabric: `@synadia-ai/agent-fabric`
(TypeScript) and `synadia-ai-agent-fabric` (Python, `synadia_ai.agent_fabric`).
Tracing and the agent tools' ScratchPad extension today; the proxy helpers
and the fabric plugins later. Private while it is built, public at the
release.

## Layout

```
typescript/          @synadia-ai/agent-fabric — tsup (ESM + CJS), vitest, eslint, prettier
  src/trace.ts       the vocabulary: options, scope, traceHeaders, edge record, counts
  src/tracing.ts     fabricTracing(): the SDK's three hooks built from it
  src/scratchpad.ts  references' vocabulary, and the ScratchPad port the agent implements
  src/grant-request.ts            requestGrant, grantRequestEndpoint, the creator's rule
  src/scratchpad-extension.ts     scratchPadExtension(): AgentTools' three hooks
  test/unit/         no server
  test/integration/  a nats-server per file; the e2e and the interop with Python
  test/harness/      nats-server launcher (adapted from the protocol SDK's)
  test/support/      fixtures, the schema validators, host/caller helpers, the ScratchPad fake
python/              synadia-ai-agent-fabric — uv, ruff, mypy (strict), pytest
  src/synadia_ai/agent_fabric/{trace,tracing}.py   the same two modules
  src/synadia_ai/agent_fabric/{scratchpad,grant_request,scratchpad_extension}.py
  tests/             the same suites; conftest starts the servers lazily
test-fixtures/       shared by both suites — see its README for every file's source
  schemas/           the contracts: edge.json (from synadia-agent-fabric) and the
                     grant request's two shapes (from agent-fabric-examples)
  identity/          throwaway keys and server configs, vendored from synadia-agents
  interop/           the TS and Python hosts and agents the cross-language tests spawn
plugins/             placeholder: the fabric versions of the Claude Code, OpenClaw, PI plugins
```

## Rules

- **This repo depends on the protocol SDK and never copies it.** The SDK is
  `synadia-agents` (`@synadia-ai/agents`, `@synadia-ai/agent-service`,
  `synadia-ai-agents`, `synadia-ai-agent-service`). Use its public exports
  and hooks only — no deep imports, no private attributes, no monkeypatching
  its internals, in the source or in the tests. If a hook cannot carry
  something, stop and report it; the fix belongs in the SDK. Test fixtures
  and the nats-server harness are the only things adapted from it, with
  their source commit recorded.
- **The dependency goes one way.** Nothing in `synadia-agents` may name the
  fabric; nothing fabric-specific goes back into it.
- **The two packages are wire-identical.** Same edge record bytes and key
  order, same envelope fields, same headers, same 400s, same heartbeat
  counts, same grant request and reply bytes. Change both languages in one
  commit; `python/tests/test_trace_wire_parity.py` and
  `test_grant_wire_parity.py` compare the bytes against the TypeScript
  package, and the interop tests run each language against the other's
  host.
- **`edge.json` is the contract.** Both suites validate records against the
  vendored copy, on the wire in operator mode (a real `{account}.{user}`
  agent ID). When `synadia-agent-fabric` changes it, copy it again and
  update `test-fixtures/README.md`. The same for the grant request's
  `scratchpad_grant.{request,reply}.json` from `agent-fabric-examples`.
- **The ScratchPad extension holds the policy, not a client.** It never
  talks to ScratchPad or shells out to `sp`: the agent passes its own
  client behind the `ScratchPad` port (`owns`, `grantRead`, `granted`).

## The protocol SDK during development

Until the SDK with the hooks is published, both packages resolve it from
the checkout of `synadia-agents` on branch `sdk-release-rollout`, expected at
`../synadia-agents` next to this repo:

- TypeScript: `file:` dependencies in `typescript/package.json`. They point
  at the built packages, so build those first, caller then host, as the
  SDK's READMEs say:
  `(cd ../synadia-agents/client-sdk/typescript && bun run build)`, then
  `(cd ../synadia-agents/agent-sdk/typescript && bun install && bun run build)`.
  Install this repo with **npm** — bun cannot resolve the SDK's own
  transitive `file:` link. `package-lock.json` is not committed while the
  links point outside the repo.
- Python: `[tool.uv.sources]` path sources in `python/pyproject.toml`
  (editable, so no build step); `python/uv.lock` is committed, like the SDK's.

When the SDK is published, replace both with the released versions
(`^0.x` / `>=0.x`), commit a TypeScript lockfile, and drop this section.

## Running the suites

Both need `nats-server` on PATH (integration tests skip without it); the
interop tests also need `uv` (TS side) and `bun` (Python side).

```bash
cd typescript
npm install
npm run typecheck && npm run lint && npm run format:check
npm test                      # unit + integration + interop with the Python hosts
npm run build                 # dist/ (ESM + CJS)

cd ../python
uv sync
uv run ruff check . && uv run ruff format --check . && uv run mypy
uv run pytest                 # unit + integration + interop with the TS hosts + byte parity
```

The cross-version interop cases (against the last published, pre-tracing
SDK releases) are skipped unless `SYNADIA_INTEROP_PRETRACING_PY_PYTHON` /
`SYNADIA_INTEROP_PRETRACING_TS_DIR` are set; the test files say how to
prepare them.

## Reference

- The plan: `synadia-agent-fabric/docs/sdk-split.md`.
- The contract: `synadia-agent-fabric/docs/afo-design.md` §3, §4, §6.2,
  §8.1–§8.2, and `docs/schemas/edge.json`.
- The hooks: `synadia-agents` `client-sdk/*/…/interceptor.*` and
  `agent-sdk/*/…/interceptor.*` on `sdk-release-rollout` (merged there by synadia-agents #205, 2026-09-22).
- The agent tools and their extension hooks: `synadia-agents`
  `docs/agent-tools.md` §6.3 (#207); the fabric's view,
  `synadia-agent-fabric/docs/agent-tools.md` §2.1–§2.2; the rules the
  extension was ported from, `agent-fabric-examples` `tools/README.md` and
  `agents/*/` at `1e783a3`.
- The tracing this was rebuilt from: `synadia-agents` at `c9d7bcb`
  (`client-sdk/typescript/src/trace.ts`, `agent.ts`; `agent-sdk/*/service.*`;
  the Python twins). The tests the split deleted: `git show --stat 6bc5527`.
