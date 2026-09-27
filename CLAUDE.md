# CLAUDE.md — agent-fabric-sdk

The SDK for agents on the Synadia Agent Fabric: `@synadia-ai/agent-fabric`
(TypeScript) and `synadia-ai-agent-fabric` (Python, `synadia_ai.agent_fabric`).
Tracing and the agent tools' ScratchPad extension today; the proxy helpers
later. Under `reference-agents/` sit the two reference agents, TypeScript
and Python, the worked example of the package, as the protocol SDK keeps
its examples beside each package (moved from the examples repository on
2026-09-27). Private while it is built, public at the release.

Under `plugins/` sit the fabric add-ons for the harness plugins, one small
TypeScript package per harness, `plugins/pi` and `plugins/openclaw` built
and Claude Code's to come. Each is an extension module the public plugin in
`synadia-agents` loads by name and hands the SDK's hooks and the harness's
events; the add-on wires `fabricTracing()` in and adds the harness piece.
The plugins stay in the public repo and are never copied here;
`docs/plugins.md` is the spec.

## Layout

```
typescript/          @synadia-ai/agent-fabric — tsup (ESM + CJS), vitest, eslint, prettier
  src/trace.ts       the vocabulary: options, scope, traceHeaders, edge record, counts
  src/tracing.ts     fabricTracing(): the SDK's three hooks built from it
  src/served.ts      the served record's vocabulary and its publisher, for the harness add-ons
  src/scratchpad.ts  references' vocabulary, and the ScratchPad port the extension runs on
  src/grant-request.ts            requestGrant, grantRequestEndpoint, the creator's rule
  src/scratchpad-extension.ts     scratchPadExtension(): AgentTools' three hooks
  src/scratchpad-cli.ts           spCliScratchPad(), scratchPadFromEnv(): the port's ready implementation over `sp`
  src/plugin-contract.ts          the harness plugins' extension contract, as types — TypeScript only
  src/loop-guard.ts               loopGuard(): the 409 guard every add-on returns — TypeScript only
  src/plugin-settings.ts          resolveEdgeSubject(): the add-ons' one setting — TypeScript only
  src/plugin-scratchpad.ts        ScratchPad for a harness: settings, the variables scripts/sp reads, ScratchPadHandOn — TypeScript only
  test/unit/         no server
  test/integration/  a nats-server per file; the e2e and the interop with Python
  test/harness/      nats-server launcher (adapted from the protocol SDK's); fake-sp.mjs, a stand-in `sp`
  test/support/      fixtures, the schema validators, host/caller helpers, the ScratchPad fake
python/              synadia-ai-agent-fabric — uv, ruff, mypy (strict), pytest
  src/synadia_ai/agent_fabric/{trace,tracing,served}.py   the same three modules
  src/synadia_ai/agent_fabric/{scratchpad,grant_request,scratchpad_extension,scratchpad_cli}.py
  tests/             the same suites; conftest starts the servers lazily
test-fixtures/       shared by both suites — see its README for every file's source
  schemas/           the contracts, from synadia-agent-fabric: edge.json, served.json
                     and the grant request's two shapes, sp-grant-{request,reply}.json
  identity/          throwaway keys and server configs, vendored from synadia-agents
  interop/           the TS and Python hosts and agents the cross-language tests spawn
plugins/             the fabric add-ons for the harness plugins, one package per harness (docs/plugins.md)
  scratchpad-skill/  the one ScratchPad skill every add-on ships: SKILL.md, scripts/sp, build-sp.sh, install.sh
  pi/                @synadia-ai/agent-fabric-pi — built like typescript/ (tsup, vitest, eslint, prettier)
    src/extension.ts the factory: tracing's hooks, the guard, the scope bound at PI's events, the headers
    test/unit/       a fake of the plugin drives the events; test/integration/ a nats-server, edge.json
  openclaw/          @synadia-ai/agent-fabric-openclaw — built the same way
    src/extension.ts the factory: tracing's hooks, the guard, the served pair, the scope at OpenClaw's events
    src/trace-scope.ts the traceparent seed: OpenClaw's trace scope store, feature-checked (from fbd16ab)
    src/scratchpad.ts  ScratchPad: the shared pieces with this package's skill/scratchpad (npm run build:sp)
    test/unit/       a fake of the plugin drives the events; test/integration/ a nats-server, served.json
  claude-code/       @synadia-ai/agent-fabric-claude-code — built the same way, and a Claude Code plugin of its own
    src/extension.ts the factory: tracing's hooks, the guard, the served pair on the session, end at the Stop
    src/scratchpad.ts  ScratchPad: the shared pieces, and the file scripts/sp reads (the module cannot reach Bash's environment)
    .claude-plugin/, hooks/  the plugin `agent-fabric`: the SessionStart hook that names that file; skills/scratchpad (npm run build:sp)
    test/unit/       a fake of the plugin drives the events; test/integration/ a nats-server, served.json
reference-agents/    the two reference agents, the package's worked example — README.md is theirs and the tools'
  typescript/        the TypeScript agent: src/agent.ts (the four behaviours), its caller, its echo; vitest
  python/            the Python agent: fabric_agent/agent.py, the same; pytest, with the interop of the two
  docs/              getting-started/ (the walkthrough, one page per language) and findings.md (F1–F29)
  Makefile, scripts/setup.sh   `make setup` (the SDK checked and built, this package built, both agents installed), `make test`
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
  counts, same grant request and reply bytes, same served record. Change
  both languages in one commit; `python/tests/test_trace_wire_parity.py`,
  `test_served_wire_parity.py` and `test_grant_wire_parity.py` compare the
  bytes against the TypeScript package, and the interop tests run each
  language against the other's host.
- **`edge.json` is the contract.** Both suites validate records against the
  vendored copy, on the wire in operator mode (a real `{account}.{user}`
  agent ID). When `synadia-agent-fabric` changes it, copy it again and
  update `test-fixtures/README.md`. The same for `served.json` and the grant
  request's `sp-grant-{request,reply}.json`, also from `docs/schemas/`.
- **What the add-ons share lives in the fabric package, TypeScript only.**
  The plugins' extension contract as types, the `409` loop guard, the
  edge subject setting and ScratchPad's pieces (`plugin-scratchpad.ts`) are
  in `typescript/src/` and exported from the package's index; an add-on imports them and never copies them. The
  plugins are TypeScript, none of this is wire, so there is no Python twin
  and the parity rule does not reach it. An add-on imports nothing of its
  harness, not even its types.
- **The ScratchPad extension holds the policy, not a client.** It never
  talks to ScratchPad or shells out to `sp`: it runs on whatever sits
  behind the `ScratchPad` port (`owns`, `grantRead`, `granted`). The
  package's own implementation of that port, `scratchpad-cli` /
  `scratchpad_cli`, is the one piece that drives `sp`, moved from the
  examples' agents at `1ed3c45` and moved to the sp v2 command line on
  2026-09-27; a later one speaking NATS directly replaces it behind the
  same `ScratchPadClient`. The variables it reads
  (`SCRATCHPAD_VOLUME`, `_BIN`, `_DIR`, `_GRANT_TTL_S`) are a contract.

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
  transitive `file:` link. `package-lock.json` is committed, generated by
  `npm install`; a clean clone installs with `npm ci`. The lockfile records
  the SDK links as links to the relative paths (`"link": true`), so it pins
  the registry packages, not the SDK checkout's contents: that is the
  checkout's commit. When the SDK's own dependencies change, `npm install`
  updates the lockfile, and the change is committed.
- Python: `[tool.uv.sources]` path sources in `python/pyproject.toml`
  (editable, so no build step); `python/uv.lock` is committed, like the SDK's.
- The add-ons, `plugins/pi`, `plugins/openclaw` and `plugins/claude-code`: `"@synadia-ai/agent-fabric": "file:../../typescript"`,
  so build `typescript/` first (`npm run build`; its `dist/` is the link's
  target), and the two SDK packages by the same `file:` links, since npm
  does not hoist a linked package's own links; installed with npm,
  `package-lock.json` committed, as for `typescript/`.

- The reference agents, `reference-agents/typescript` and
  `reference-agents/python`: this package by relative path
  (`file:../../typescript`, `path = "../../python"`), the SDK by the same
  sibling links (`file:../../../synadia-agents/…`). Like the packages they
  commit their lockfiles, `package-lock.json` and `uv.lock`, as they did in
  the examples repository. `make setup` in `reference-agents/` does the
  builds above and installs both.

When the SDK is published, replace both with the released versions
(`^0.x` / `>=0.x`), regenerate the lockfiles, and drop this section.
**At the publication of this package**, the reference agents' links switch
to the published versions of all three packages, and `make setup` shrinks
to `npm install` and `uv sync`.

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

cd ../plugins/pi              # after typescript/ is built; the same in plugins/openclaw, plugins/claude-code
npm install
npm run typecheck && npm run lint && npm run format:check
npm test                      # unit with a fake plugin + integration with a nats-server
npm run build                 # dist/, what SYNADIA_PI_EXTENSIONS (…_OPENCLAW_…, …_CLAUDE_CODE_…) points at

cd ../../reference-agents     # after typescript/ is built; `make setup` builds and installs
make setup
make test                     # typescript: typecheck + npm test; python: pytest, with the TS agent in the interop
```

All suites green means all of these: the two packages', the three add-ons',
and the reference agents' two (`reference-agents/typescript` `npm test`,
`reference-agents/python` `pytest`).

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
  The Python host's `extra_endpoints`, which serve the grant endpoint:
  `AgentServiceExtraEndpoint` in `agent-sdk/python/…/service.py` (#210, `218f602`).
- The agent tools and their extension hooks: `synadia-agents`
  `docs/agent-tools.md` §6.3 (#207); the fabric's view,
  `synadia-agent-fabric/docs/agent-tools.md` §2.1–§2.2; the rules the
  extension was ported from, the reference agents' `tools/README.md` and
  `agents/*/` at `1e783a3`, in the examples repository before they moved
  here (`reference-agents/`, 2026-09-27).
- The tracing this was rebuilt from: `synadia-agents` at `c9d7bcb`
  (`client-sdk/typescript/src/trace.ts`, `agent.ts`; `agent-sdk/*/service.*`;
  the Python twins). The tests the split deleted: `git show --stat 6bc5527`.
