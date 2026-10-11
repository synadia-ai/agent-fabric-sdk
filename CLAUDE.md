# CLAUDE.md — agent-fabric-sdk

## Building an agent? Use the fabric-agent skill

If the user wants an agent on the fabric (to build one, connect it, run it
or change its model), not to work on this SDK, use the `fabric-agent` skill,
`.claude/skills/fabric-agent/SKILL.md`, and skip the rest of this file: it is
for work on the SDK itself. Never ask for a key or a token in the chat.
`fabric login`, and a `fabric connect` that needs the provider's key, go to
the user's own terminal.

## Working on this SDK

The SDK for agents on the Synadia Agent Fabric: `@synadia-ai/agent-fabric`
(TypeScript) and `synadia-ai-agent-fabric` (Python, `synadia_ai.agent_fabric`).
Tracing and the agent tools' ScratchPad extension today; the proxy helpers
later. Under `reference-agents/` sit the two reference agents, TypeScript
and Python, the worked example of the package, as the protocol SDK keeps
its examples beside each package (moved from the examples repository on
2026-09-27). Private while it is built, public at the release.

Under `plugins/` sit the fabric add-ons for the harness plugins, one small
TypeScript package per harness: `plugins/pi`, `plugins/openclaw`, and
`plugins/claude-code`. Each is an extension module the public plugin in
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
  src/durable.ts     durableRunId, durableTrace, durableHeaders, withDurableTrace: a durable run joined to its task (docs/durable.md)
  src/scratchpad.ts  references' vocabulary, and the ScratchPad port the extension runs on
  src/grant-request.ts            requestGrant, grantRequestEndpoint, the creator's rule
  src/scratchpad-extension.ts     scratchPadExtension(): AgentTools' three hooks
  src/scratchpad-cli.ts           spCliScratchPad(), scratchPadFromEnv(): the port's ready implementation over `sp`
  src/scratchpad-native.ts        nativeScratchPad(), nativeScratchPadFromEnv(), scratchPadReader(): the native NATS client; protocol, codec, SQLite workspace and workflows in scratchpad-native/
  src/plugin-contract.ts          the harness plugins' extension contract, as types — TypeScript only
  src/loop-guard.ts               loopGuard(): the 409 guard every add-on returns — TypeScript only
  src/plugin-settings.ts          resolveEdgeSubject(): the add-ons' one setting — TypeScript only
  src/plugin-scratchpad.ts        ScratchPad for a harness: settings, the variables scripts/sp reads, ScratchPadHandOn — TypeScript only
  test/unit/         no server
  test/integration/  a nats-server per file; the e2e and the interop with Python
  test/harness/      nats-server launcher (adapted from the protocol SDK's); fake-sp.mjs, a stand-in `sp`
  test/support/      fixtures, the schema validators, host/caller helpers, the ScratchPad fake
python/              synadia-ai-agent-fabric — uv, ruff, mypy (strict), pytest
  src/synadia_ai/agent_fabric/{trace,tracing,served,durable}.py   the same four modules
  src/synadia_ai/agent_fabric/{scratchpad,grant_request,scratchpad_extension,scratchpad_cli}.py
  tests/             the same suites; conftest starts the servers lazily
test-fixtures/       shared by both suites — see its README for every file's source
  schemas/           the contracts, from the fabric's design documents: edge.json, served.json
                     and the grant request's two shapes, sp-grant-{request,reply}.json
  identity/          throwaway keys and server configs, vendored from synadia-agents
  interop/           the TS and Python hosts and agents the cross-language tests spawn
plugins/             the fabric add-ons for the harness plugins, one package per harness (docs/plugins.md)
  scratchpad-skill/  the one ScratchPad skill every add-on ships: SKILL.md, scripts/sp, load-sp.mjs, install.sh
  pi/                the pi add-on's source, built like typescript/ (tsup, vitest, eslint, prettier); published
                     inside @synadia-ai/agent-fabric-pi, the whole plugin bundles/build.sh makes, never alone
    src/extension.ts the factory: tracing's hooks, the guard, the scope bound at PI's events, the headers
    test/unit/       a fake of the plugin drives the events; test/integration/ a nats-server, edge.json
  openclaw/          the OpenClaw add-on's source, built the same way; published inside @synadia-ai/agent-fabric-openclaw
    src/extension.ts the factory: tracing's hooks, the guard, the served pair, the scope at OpenClaw's events
    src/trace-scope.ts the traceparent seed: OpenClaw's trace scope store, feature-checked (from fbd16ab)
    src/scratchpad.ts  ScratchPad: the shared pieces with this package's skill/scratchpad (npm run build:sp)
    test/unit/       a fake of the plugin drives the events; test/integration/ a nats-server, served.json
  claude-code/       the Claude Code add-on's source, built the same way, and a Claude Code plugin of its own; published inside
                     @synadia-ai/agent-fabric-claude-code, the whole plugin, which .claude-plugin/marketplace.json names
    src/extension.ts the factory: tracing's hooks, the guard, the served pair on the session, end at the Stop
    src/scratchpad.ts  ScratchPad: the shared pieces, and the file scripts/sp reads (the module cannot reach Bash's environment)
    .claude-plugin/, hooks/  the plugin `agent-fabric`: the SessionStart hook that names that file; skills/scratchpad (npm run build:sp)
    test/unit/       a fake of the plugin drives the events; test/integration/ a nats-server, served.json
bundles/             self-contained harness plugins, built from the public plugin and this repo's add-on
  build.sh           [claude-code|pi|openclaw|all] → bundles/out/fabric-{claude,pi,openclaw}.tar.gz, each
                     with ScratchPad; Claude's tarball is also a marketplace, `fabric`; pi's and OpenClaw's
                     also npm packages, @synadia-ai/agent-fabric-{pi,openclaw}: the whole plugin, one install
  npm/               the READMEs the three npm packages ship
  bundle.ts          one Bun build of plugin and add-on with shared chunks: one copy of the SDK
reference-agents/    the two reference agents, the package's worked example — README.md is theirs and the tools'
  typescript/        the TypeScript agent: src/agent.ts (the five behaviours), its caller, its echo; vitest
                     src/durable.ts, start_workflow and the workflows it hosts behind AGENT_DURABLE=1, on the thin durable SDK
                     src/durable-agent.ts, src/durable-main.ts: the durable agent, the model loop as the workflow (npm run start:durable)
                     test/harness/engine.ts: the durable engine its durable tests spawn (tests/harness/engine.py in python/)
  python/            the Python agent: fabric_agent/agent.py, the same, and fabric_agent/durable.py; pytest, with the interop of the two
                     fabric_agent/durable_agent.py, durable_main.py: the durable agent (python -m fabric_agent.durable_main)
  docs/              getting-started/ (the walkthrough, one page per language) and findings.md (F1–F29)
  Makefile, scripts/setup.sh   `make setup` (the SDK checked and built, this package built, both agents installed), `make test`
.claude/skills/fabric-agent/   (and reference-agents/CLAUDE.md, which points at it) the skill for a user's Claude Code in a checkout: an agent built from the reference agent, connected with
                     `fabric` and run; every step that takes a secret handed to the user's own terminal, never asked for in the chat
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
  counts, same grant request and reply bytes, same served record, same
  durable run ids and trace. Change
  both languages in one commit; `python/tests/test_trace_wire_parity.py`,
  `test_served_wire_parity.py`, `test_grant_wire_parity.py` and
  `test_durable_wire_parity.py` compare the
  bytes against the TypeScript package, and the interop tests run each
  language against the other's host.
- **`edge.json` is the contract.** Both suites validate records against the
  vendored copy, on the wire in operator mode (a real `{account}.{user}`
  agent ID). When the fabric's design documents change it, copy it again and
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
  2026-09-27. TypeScript's native client implements the same `ScratchPadClient`
  and is the reference agent's default. Its writer requires Node 22.13+
  and an explicit persistent `SCRATCHPAD_DIR`; see `docs/scratchpad-native.md`.
  Python's native client implements the same port and is its reference agent's
  default; native operations require Python 3.12+. Native readers need no workspace.
  Both languages keep the optional CLI adapter. Tests with a fake `sp` inject
  that adapter explicitly; the real-service suites qualify native recovery.
  The variables the CLI adapter reads
  (`SCRATCHPAD_VOLUME`, `_BIN`, `_DIR`, `_GRANT_TTL_S`) are a contract.

## The protocol SDK during development

Until the SDK with the hooks is published, both packages resolve it from
the checkout of `synadia-agents` on `main` (everything of the rollout merged there on 2026-10-02), expected at
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
  `reference-agents/python`. TypeScript names the published versions on
  npm (`^0.1.0`, `^0.6.0`, `^0.1.1`), so a copy of the directory installs
  anywhere with `npm install`; `make setup` then links this package
  (`../../typescript`), the SDK (`../../../synadia-agents/…`) and the thin
  durable SDK (`../../../durable-sdk`) over that install with
  `npm install --no-save`, so the tests run the checkouts. Python takes them
  by uv path sources (`path = "../../python"`, the SDK's, and an editable
  source to `../durable-sdk/python`) until they are on PyPI. Its durable tests spawn the engine, `durable-engine
  serve`, standalone on the test's nats-server: `DE_ENGINE` (a `-dev` build)
  and `DE_LICENCE` when given, else built with Go from `../durable-engine` at
  the commit the SDK's `engine.pin` names, into `reference-agents/.engine-bin/`,
  with a test licence it mints; without either they skip. Those checkouts
  are read, built and imported, never edited; the package itself depends on
  nothing durable. Like the packages they
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

For the separate distribution suite, build the TypeScript SDK and all three
add-ons first. Use the complete
[build-and-test sequence](docs/scratchpad-binaries.md#checks-and-release-boundary);
`npm pack` installs the skill and binaries but does not build the add-ons.

The cross-version interop cases (against the last published, pre-tracing
SDK releases) are skipped unless `SYNADIA_INTEROP_PRETRACING_PY_PYTHON` /
`SYNADIA_INTEROP_PRETRACING_TS_DIR` are set; the test files say how to
prepare them.

## Reference

- The plan: the fabric's design documents, the SDK split.
- The contract: the fabric's design, §3, §4, §6.2, §8.1–§8.2, and its
  `docs/schemas/edge.json`.
- The hooks: `synadia-agents` `client-sdk/*/…/interceptor.*` and
  `agent-sdk/*/…/interceptor.*` on `sdk-release-rollout` (merged there by synadia-agents #205, 2026-09-22).
  The Python host's `extra_endpoints`, which serve the grant endpoint:
  `AgentServiceExtraEndpoint` in `agent-sdk/python/…/service.py` (#210, `218f602`).
- The agent tools and their extension hooks: `synadia-agents`
  `docs/agent-tools.md` §6.3 (#207); the fabric's view, its design
  documents' agent tools, §2.1–§2.2; the rules the
  extension was ported from, the reference agents' `tools/README.md` and
  `agents/*/` at `1e783a3`, in the examples repository before they moved
  here (`reference-agents/`, 2026-09-27).
- The tracing this was rebuilt from: `synadia-agents` at `c9d7bcb`
  (`client-sdk/typescript/src/trace.ts`, `agent.ts`; `agent-sdk/*/service.*`;
  the Python twins). The tests the split deleted: `git show --stat 6bc5527`.
