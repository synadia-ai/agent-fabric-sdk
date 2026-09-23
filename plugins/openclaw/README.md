# @synadia-ai/agent-fabric-openclaw

The Synadia Agent Fabric add-on for the OpenClaw channel plugin
(`@synadia-ai/nats-channel`, `agents/openclaw` in
[`synadia-agents`](https://github.com/synadia-ai/synadia-agents)). One
extension module in the shape the plugin loads: named in
`SYNADIA_OPENCLAW_EXTENSIONS`, it puts the fabric package's tracing on the
plugin's service and on the client its agent tools prompt through, seeds
each served prompt's OpenClaw turn with a trace id of its own and binds it
to the served thread with the signed `served` pair, and puts the `409` loop
guard in front of the gateway's handler. Without it the plugin is the plain
plugin. The contract it fills is the plugin's `agents/EXTENSIONS.md`; the
spec is [`../../docs/plugins.md`](../../docs/plugins.md) §2, §3.1 and §3.3.

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

**What it does not do.** No `toolExtensions`: a harness reads no ScratchPad
reference in the MVP. No header on OpenClaw's calls: the plugin cannot add
one, which is why the pair exists.

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

## Public API

|                                                                                                                                                      |                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `default`, `createFabricExtension(ctx, env?)`                                                                                                        | the factory of the contract; `env` is where the variable is read from, `process.env` by default |
| `EXTENSION_NAME`, `IDENTITY_OFF_WARNING`, `SERVED_HARNESS`                                                                                           | the constants                                                                                   |
| `newTraceId()`, `validTraceId(v)`, `runWithTraceId(id, fn, scope?)`, `openClawTraceScope(root?)`, `OPENCLAW_TRACE_SCOPE_KEY`, `OpenClawTraceContext` | the trace scope seed on its own                                                                 |

The contract's types, the setting's precedence (`resolveEdgeSubject`) and
the loop guard (`loopGuard`) are `@synadia-ai/agent-fabric`'s, shared by
every add-on under `plugins/`.

## Development

Built like the fabric package (tsup, ESM and CJS, vitest, eslint,
prettier). It links `@synadia-ai/agent-fabric` at `file:../../typescript`,
built first, and the two protocol SDK packages by the same `file:` links
the fabric package uses; no lockfile is committed while the links point
outside the repo. Nothing of OpenClaw is a dependency, not even its types:
the seed needs `node:async_hooks` and the symbol's name. The tests: unit, a
fake of the plugin driving the events (`test/support/fake-plugin.ts`) and
the seed on its own; integration, the factory's hooks on a real
`AgentService` and `Agents` over a local `nats-server` in operator mode,
the pair and the edges on the wire validated against
`test-fixtures/schemas/served.json` and `edge.json`, signed, one id three
ways.

```sh
(cd ../../typescript && npm install && npm run build)
npm install
npm run typecheck && npm run lint && npm run format:check
npm test
npm run build
```

## License

Apache-2.0, like the fabric package. See [LICENSE](LICENSE).
