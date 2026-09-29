# @synadia-ai/agent-fabric-openclaw

The Synadia Agent Fabric add-on for the OpenClaw channel plugin
(`@synadia-ai/nats-channel`, `agents/openclaw` in
[`synadia-agents`](https://github.com/synadia-ai/synadia-agents)). One
extension module in the shape the plugin loads: named in
`SYNADIA_OPENCLAW_EXTENSIONS`, it puts the fabric package's tracing on the
plugin's service and on the client its agent tools prompt through, seeds
each served prompt's OpenClaw turn with a trace id of its own and binds it
to the served thread with the signed `served` pair, and puts the `409` loop
guard in front of the gateway's handler. It also ships ScratchPad's skill
with the sp command line, so OpenClaw's model reads, publishes and shares
ScratchPad content through its exec tool. Without it the plugin is the
plain plugin. The contract it fills is the plugin's `agents/EXTENSIONS.md`;
the spec is [`../../docs/plugins.md`](../../docs/plugins.md) §2, §3.1, §3.3
and §9.

## What it does

The factory, the module's default export, calls `fabricTracing()` once and
hands the plugin its three hooks, so OpenClaw is on the wire exactly what an
SDK-built agent is:

- **On the service, per prompt:** the envelope's `thread_id` and `root_id`
  are adopted, or a root minted when neither is there; a half pair or a
  malformed id is refused with `400` before the handler runs; the handler
  runs inside the trace scope.
- **On the client OpenClaw's agent tools prompt through, per prompt:** the
  child thread is minted and the pair put into the envelope, and the signed
  `edge` record is published on `TRACE.edges` before the prompt goes out,
  with the model's tool-call ID, which the plugin passes to `execute()`. A
  delegation OpenClaw's model makes hangs under its tool call in the console.
- **On the heartbeat:** `records_published` and `records_dropped`, the
  `served` records counted with the edges.

The harness piece is the join of OpenClaw's own model calls. The plugin
cannot put the fabric's headers on them, but OpenClaw stamps a W3C
`traceparent` on every model call of a turn, its trace id inherited from the
trace scope the turn was dispatched in: an `AsyncLocalStorage` OpenClaw
keeps on `globalThis` under
`Symbol.for("openclaw.diagnosticTraceScope.state.v1")`, carried through its
command lane on 2026.8 and later. The proxy files a call carrying a
`traceparent` and no SDK pair as `harness: openclaw`, the trace id its
`harness_thread_id`. So per served prompt the add-on mints a trace id, seeds
OpenClaw's scope with it around the dispatch, and publishes the binding:

| Event                                | What the add-on does                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptAccepted(request)`            | keeps `activeTrace()`, the scope tracing bound for this request, by `request.id`; mints a fresh trace id, 128 random bits as 32 lowercase hex, never all zeros; `beginTurn(scope, "openclaw")` and `bind(traceId)` on the fabric package's served publisher, which publishes `start` stamped with the arrival |
| `aroundDispatch(request, run)`       | `runWithTraceId(traceId, () => bindActiveTrace(scope, run))`: OpenClaw's turn runs with a trace context whose `traceId` is the minted id, so every model call of the turn carries it in its `traceparent`, and in the served scope; `run` is called once, synchronously, and its own promise returned         |
| `aroundToolCall(request, tool, run)` | binds the request's scope around `run`, so the edge of a `prompt_agent` OpenClaw's model calls is filed under the served thread; on 2026.8 and later the tool already runs in the handler's context and this is a no-op rebind                                                                                |
| `promptEnded(request, outcome, at)`  | `settle(outcome, at)`, which publishes `end` with the outcome (`ok`, or `error` when the dispatch threw or OpenClaw reported a dispatch error) and the time the plugin reports; the request is forgotten                                                                                                      |

A request the add-on never saw (no scope kept) is left alone: `run` called
as it is. The trace id is fresh per prompt, never the caller's thread id,
so nothing of the NATS side reaches a model provider. The seed is
feature-checked: when the global has another shape the dispatch runs as it
is and the header carries an id of OpenClaw's own; when it is absent the
store is created in OpenClaw's own shape, which OpenClaw adopts.

The pair goes through the fabric package's `servedPublisher()`, made at
`started` from the plugin's client: signed as the plugin's identity with
the record id as the nonce and the `Nats-Msg-Id`, on the edge subject, in
the order the records were due, so a pair's `end` never overtakes its
`start`. `stopping` flushes it. A prompt accepted in the moment between the
service starting and `started` gets its trace id seeded and no pair.

**The `409` loop guard.** OpenClaw serves an account's prompts one turn at
a time and cannot serve a prompt while its model waits inside a blocking
tool call, so a prompt of a tree OpenClaw is waiting in is refused at once
with `409` instead of queueing behind the wait it is part of. The guard is
the fabric package's `loopGuard()`, two more interceptors after tracing's;
the PI add-on returns the same.

**What it does not do.** No header on OpenClaw's calls: the plugin cannot
add one, which is why the pair exists.

## Naming it

Installed where OpenClaw runs, `npm install @synadia-ai/agent-fabric-openclaw`,
and named to the plugin by package name when that directory is the plugin's
or an ancestor of it, by absolute path otherwise (a package directory with
`dist/` built):

```sh
SYNADIA_OPENCLAW_EXTENSIONS=/opt/fabric/node_modules/@synadia-ai/agent-fabric-openclaw openclaw gateway run …
```

or in the account's block under `channels.nats.accounts`, where an entry
may carry options:

```json
{
  "extensions": [
    { "module": "@synadia-ai/agent-fabric-openclaw", "options": { "edgeSubject": "TRACE.edges" } }
  ]
}
```

`SYNADIA_OPENCLAW_EXTENSIONS` wins over `SYNADIA_AGENT_EXTENSIONS`, which
wins over the config field. The gateway's `gateway starting` line
(`extensions: agent-fabric`) and its `registered at` line
(`extensions=agent-fabric`) name the module when it is loaded. OpenClaw's tool policy applies to the plugin's agent tools as to any
plugin tool: a non-empty `tools.allow` must name them, or `group:plugins`.

## The one setting

The edge subject: the entry's `options.edgeSubject`, else the variable
`SYNADIA_FABRIC_EDGE_SUBJECT`, else `TRACE.edges`. The `served` pair goes on
the same subject. `null` in the options is propagate-only: lineage
forwarded, no record of either kind published, the trace id still seeded. A
subject that can never be published to stops the factory; the plugin logs
`extension "…" not loaded: …` and starts plain. There is no `tracing`
setting: the add-on's presence is the switch.

## Identity

Records are signed, so the plugin needs `senderIdentity: "signed"` with
`credentials` OpenClaw's own. With identity off the add-on warns once at
`started`, the served publisher warns once more when the first record is
due, every record owed counts as dropped on the heartbeat, and OpenClaw's
calls stand as a harness thread of their own, unbound.

## What the console shows

The served thread with OpenClaw's model calls joined through the pair, the
thread's outcome and its duration from `start` to `end`, OpenClaw `full` in
the agents view with both halves, its signed `served` records the NATS half.
A delegation OpenClaw's model makes is a child under its tool call. Two
prompts' windows can overlap, since `start` is stamped on arrival and
OpenClaw queues; the trace id, not the window, tells their calls apart.

## Stated honestly

- **OpenClaw before 2026.8** does not carry the trace scope through its
  command lane, so the calls carry an id of OpenClaw's own and the pair
  names an id no call carries.
- **The scope is OpenClaw's internal**, keyed by a versioned symbol; it will
  drift, and the seed falls back to an unseeded dispatch when it does.
- **Any well-formed `traceparent` files as OpenClaw** at the proxy until the
  virtual key names its harness (`docs/plugins.md` §3.3).

## ScratchPad

The package carries ScratchPad's skill, the one every add-on ships, in
`skill/scratchpad/`: `SKILL.md`, `scripts/sp`, and `bin/` with the sp
command line for darwin and linux on arm64 and amd64, installed from
`../scratchpad-skill` by `npm run build:sp`. The model reads `SKILL.md`
with OpenClaw's `read` tool and runs `scripts/sp` through its `exec` tool.
Nothing restricts either: the harness's tools stay as the operator
configured them, and OpenClaw's default exec mode asks nothing.

**The operator's step.** Three entries in `openclaw.json`, and a volume:

```json
{
  "skills": { "load": { "extraDirs": ["<add-on>/skill"] } },
  "agents": { "defaults": { "skills": ["scratchpad"] } },
  "tools": { "allow": ["exec", "read", "discover_agents", "prompt_agent", "answer_agent"] }
}
```

- `skills.load.extraDirs` names the directory that holds the skill's
  directory, `<add-on>/skill`.
- `agents.defaults.skills` is needed only where the agent has a skill
  allowlist: an empty one (`[]`) hides every skill. Without an allowlist,
  every skill OpenClaw finds is shown.
- `exec` and `read` join `tools.allow` when it lists tools: OpenClaw shows
  the skills only while `read` is visible, and runs `scripts/sp` through
  `exec`.
- The volume, reserved for OpenClaw's identity by the ScratchPad operator,
  in the account's extension entry, or as `SCRATCHPAD_VOLUME` in the
  gateway's environment:

```json
"extensions": [{ "module": "<add-on>", "options": { "scratchpad": { "volume": "OcVol" } } }]
```

**Where the settings come from.** The factory resolves each from the entry's
`options.scratchpad` (`volume`, `dir`, `url`, `creds`), else the variable
(`SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR`, `NATS_URL`, `NATS_CREDS`), else, for
the URL and the credentials file, the account's own `url` and
`credentials`, which is how OpenClaw's plugin connects. The workspace
defaults to `scratchpad/` in OpenClaw's state directory
(`$OPENCLAW_STATE_DIR/scratchpad`), created if missing; keep it across
restarts. Without a volume ScratchPad is off.

**What `scripts/sp` gets.** The add-on sets these in the gateway's process,
before the plugin connects; OpenClaw's exec tool builds each command's
environment from it on the gateway host, its default with the sandbox off:

| Variable                              | Set                                             | `scripts/sp` adds                                                          |
| ------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `SP_NATS_URL`, `SP_NATS_CREDS`        | at start                                        | `--url`, `--creds`, every call                                             |
| `SCRATCHPAD_DIR`                      | at start                                        | `--dir`, every call                                                        |
| `SCRATCHPAD_VOLUME`                   | at start                                        | `--volume`, on `init` only                                                 |
| `SP_CREATOR`                          | at start: OpenClaw's prompt address             | `--creator`, on `publish-file`                                             |
| `SP_THREAD_ID`, `SP_ROOT_ID`          | per served prompt, from its dispatch to its end | `--thread-id`, `--root-id`, every call                                     |
| `SP_CALLER_ACCOUNT`, `SP_CALLER_USER` | the same, for a verified caller                 | `--grantee-account`, `--grantee-user`, on `grant` and after `publish-file` |
| `SP_GRANTS_FILE`                      | at start: `<workspace>.grants`                  | nothing: it records there each grant sp confirmed, for grant requests      |

The connection has names of its own because OpenClaw's plugin reads
`NATS_URL` and `NATS_CREDS` in its environment as overrides of the
account's; the add-on never sets those. A `publish-file` during a served
prompt with a verified caller also grants that caller read on what it
published; a `grant` goes to that caller and no other. The variables are
process-wide: the plugin dispatches one turn at a time, and with ScratchPad
configured on two accounts of one gateway the last one set wins, so
configure it on one.

**References in and out.** With ScratchPad on, the add-on registers OpenClaw
as reading references (`scratchpad_refs_ok: "true"` through the extension's
`metadata`), and the references its model puts into `prompt_agent` go
through the fabric package's ScratchPad extension, as an SDK-built agent's
do: granted to a receiver that reads references, removed with a note for
any other.

**Grant requests.** A caller OpenClaw handed a reference to may hand it on
through its own agent tools; its ScratchPad extension then asks the creator,
OpenClaw, to grant the receiver read (the grant request, `grant-request.ts` in
the fabric package). The add-on answers on OpenClaw's service, by the rule every
SDK-built agent answers by: the reference must point into OpenClaw's volume, the
requester must hold a live read grant OpenClaw made it first-hand, the grantee
must be another agent, and the grant is one path, read only, ten minutes at
most, recorded as made on request, which entitles no one to ask again. The
grants OpenClaw's model makes go through `scripts/sp`, which the add-on does not
see, so `scripts/sp` records each one sp confirms in `SP_GRANTS_FILE`
(`<workspace>.grants`), and the add-on counts a live one as first-hand: it
went to the agent whose prompt OpenClaw was serving.

## Public API

|                                                                                                                                                      |                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`, `fabricExtension(ctx, env?)`                                                                                                              | the factory of the contract: resolves ScratchPad, then builds the extension; `env` is where the variables are read and ScratchPad's are set, `process.env` by default |
| `createFabricExtension(ctx, env?, scratchPad?)`                                                                                                      | the same, synchronous, from settings already resolved                                                                                                                 |
| `SCRATCHPAD_OPTION`, `SP_VARS`, `ScratchPadHandOn`, `spBinary(env)`                                                                                  | ScratchPad's option key, the variables `scripts/sp` reads, the tool extension, the packaged sp's path                                                                 |
| `EXTENSION_NAME`, `IDENTITY_OFF_WARNING`, `SERVED_HARNESS`                                                                                           | the constants                                                                                                                                                         |
| `newTraceId()`, `validTraceId(v)`, `runWithTraceId(id, fn, scope?)`, `openClawTraceScope(root?)`, `OPENCLAW_TRACE_SCOPE_KEY`, `OpenClawTraceContext` | the trace scope seed on its own                                                                                                                                       |

The contract's types, the setting's precedence (`resolveEdgeSubject`) and
the loop guard (`loopGuard`) are `@synadia-ai/agent-fabric`'s, shared by
every add-on under `plugins/`.

## Development

Built like the fabric package (tsup, ESM and CJS, vitest, eslint,
prettier). It links `@synadia-ai/agent-fabric` at `file:../../typescript`,
built first, and the two protocol SDK packages by the same `file:` links
the fabric package uses; its `package-lock.json` is committed, and a clean clone
installs with `npm ci`. Nothing of OpenClaw is a dependency, not even its types:
the seed needs `node:async_hooks` and the symbol's name. The tests: unit, a
fake of the plugin driving the events (`test/support/fake-plugin.ts`) and
the seed on its own; integration, the factory's hooks on a real
`AgentService` and `Agents` over a local `nats-server` in operator mode,
the pair and the edges on the wire validated against
`test-fixtures/schemas/served.json` and `edge.json`, signed, one id three
ways.

`npm run build:sp` installs the skill from `../scratchpad-skill` into
`skill/scratchpad`, building the sp binaries first (Go on `PATH`, a
ScratchPad checkout next to this repository); `npm pack` runs it too.
`skill/` is gitignored. ScratchPad's source is not public, so this build
needs access to it, which not every reader has.

```sh
(cd ../../typescript && npm install && npm run build)
npm install
npm run build:sp
npm run typecheck && npm run lint && npm run format:check
npm test
npm run build
```

## License

Apache-2.0, like the fabric package. See [LICENSE](LICENSE).
