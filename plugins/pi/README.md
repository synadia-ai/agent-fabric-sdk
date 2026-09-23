# @synadia-ai/agent-fabric-pi

The Synadia Agent Fabric add-on for the PI channel plugin
(`@synadia-ai/nats-pi-channel`, `agents/pi` in
[`synadia-agents`](https://github.com/synadia-ai/synadia-agents)). One
extension module in the shape the plugin loads: named in
`SYNADIA_PI_EXTENSIONS`, it puts the fabric package's tracing on the
plugin's service and on the client its agent tools prompt through, the
fabric's two headers on PI's own model calls, and the `409` loop guard in
front of PI's handler. Without it the plugin is the plain plugin. The
contract it fills is the plugin's `agents/EXTENSIONS.md`; the spec is
[`../../docs/plugins.md`](../../docs/plugins.md) §2, §3.1 and §3.2.

## What it does

The factory, the module's default export, calls `fabricTracing()` once and
hands the plugin its three hooks, so PI is on the wire exactly what an
SDK-built agent is:

- **On the service, per prompt:** the envelope's `thread_id` and `root_id`
  are adopted, or a root minted when neither is there; a half pair or a
  malformed id is refused with `400` before the handler runs; the handler
  runs inside the trace scope.
- **On the client PI's agent tools prompt through, per prompt:** the child
  thread is minted and the pair put into the envelope, and the signed `edge`
  record is published on `TRACE.edges` before the prompt goes out, with the
  model's tool-call ID, which the plugin passes to `execute()`. A delegation
  PI's model makes hangs under its tool call in the console.
- **On the heartbeat:** `records_published` and `records_dropped`.

The harness piece is the scope. PI's loop does not run in the handler's
async context, so the add-on keeps each served request's scope by the
plugin's request id and binds it where the plugin says the request is being
worked on:

| Event                                | What the add-on does                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptAccepted(request)`            | keeps `activeTrace()`, the scope tracing bound for this request, by `request.id`                                                                                                                                                                                 |
| `aroundInject(request, run)`         | runs `run` inside `bindActiveTrace(scope, …)`, which replaces the ambient context: the plugin injects the next queued prompt from the previous turn's settle hook, whose context is the previous request's                                                       |
| `providerHeaders(request)`           | returns `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` for the request, so the proxy files PI's own model calls on the served thread; each call counts against the scope, so an edge PI's model spawns later says how many calls came before it, retries included |
| `aroundToolCall(request, tool, run)` | binds the request's scope around `run`, so the edge of a `prompt_agent` PI's model calls is filed under the served thread even if PI's tool runner did not inherit the injected context                                                                          |
| `promptEnded(request)`               | forgets the request                                                                                                                                                                                                                                              |

A request the add-on never saw (no scope kept) is left alone: no headers,
`run` called as it is.

**The `409` loop guard.** PI serves one turn at a time and cannot serve a
prompt while its model waits inside a blocking tool call, so a prompt of a
tree PI is waiting in is refused at once with `409` instead of queueing
behind the wait it is part of. The guard is two more interceptors: its
request interceptor, after tracing's, keeps the served request by the scope
tracing bound for the handler's duration and refuses an arriving prompt
whose root a served request is waiting in, before `next()`, with
`RequestRejectedError(409, …)`; its prompt interceptor, on the plugin's
client, runs in the tool call's context and marks that request as waiting.
The mark goes when the served prompt ends. The root is read from the scope
tracing bound, never from the envelope. Stated honestly: this also refuses a
legitimate second prompt of the same tree that arrives while PI waits in it,
such as a sibling delegation issued with `wait: false` by the same
coordinator; PI would have queued it anyway, and the guard turns the queue
into a refusal the caller sees at once.

**What it does not do.** No `served` record: PI's calls carry the headers,
so they need none, and PI writes nothing to `TRACE.edges` but the edges of
its own delegations. No `toolExtensions`: a harness reads no ScratchPad
reference in the MVP. No `stopping`: an edge is published before the prompt
it describes and counted as it goes, so there is nothing to flush.

## Naming it

Installed where PI runs, `npm install @synadia-ai/agent-fabric-pi`, and
named to the plugin by package name when that directory is the plugin's or
an ancestor of it, by absolute path otherwise (a package directory with
`dist/` built):

```sh
SYNADIA_PI_EXTENSIONS=/opt/fabric/node_modules/@synadia-ai/agent-fabric-pi pi …
```

or in `nats-channel.json`, where an entry may carry options:

```json
{
  "extensions": [
    { "module": "@synadia-ai/agent-fabric-pi", "options": { "edgeSubject": "TRACE.edges" } }
  ]
}
```

`SYNADIA_PI_EXTENSIONS` wins over `SYNADIA_AGENT_EXTENSIONS`, which wins
over the config field. The plugin's connect line and `/nats-status` list
`extensions=agent-fabric` when the module is loaded.

## The one setting

The edge subject: the entry's `options.edgeSubject`, else the variable
`SYNADIA_FABRIC_EDGE_SUBJECT`, else `TRACE.edges`. `null` in the options is
propagate-only: lineage forwarded, no record published, no counts on the
heartbeat. A subject that can never be published to (empty, an empty token,
whitespace, a wildcard, not a string) stops the factory; the plugin logs
`extension "…" not loaded: …` and starts plain, so the mistake is visible at
start. There is no `tracing` setting: the add-on's presence is the switch.

## Identity

Records are signed, so the plugin needs `senderIdentity: "signed"` with a
NATS context carrying PI's own credentials. With identity off the add-on
warns once at `started`, the fabric package warns once more when the first
record is due, every record owed counts as dropped on the heartbeat, and
PI's model calls still file under the caller's thread, since the headers
need no signature.

## What the console shows

PI's model calls on the child thread the caller's edge created, PI the
executor, its depth `full`; the caller's `asked` row names PI. A delegation
PI's model makes is a grandchild under its tool call, PI's edge signed and
verified. No outcome or duration from a pair: PI publishes none, and the
thread's calls carry its timing.

## Public API

|                                                                                                                                                                               |                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `default`, `createFabricExtension(ctx, env?)`                                                                                                                                 | the factory of the contract; `env` is where the variable is read from, `process.env` by default       |
| `resolveEdgeSubject(options, env?)`                                                                                                                                           | the setting's precedence, as above                                                                    |
| `EXTENSION_NAME`, `EDGE_SUBJECT_OPTION`, `EDGE_SUBJECT_VAR`, `IDENTITY_OFF_WARNING`                                                                                           | the constants                                                                                         |
| `loopGuard()`, `LOOP_GUARD_CODE`, `loopGuardDescription(rootId)`                                                                                                              | the guard on its own: `requestInterceptor`, `promptInterceptor`, `serving(rootId)`, `waiting(rootId)` |
| `AgentExtensionContext`, `AgentExtension`, `HarnessEvents`, `ServedRequest`, `Outcome`, `AgentExtensionHandles`, `AgentExtensionSettings`, `Harness`, `AgentExtensionFactory` | the plugin's contract, declared structurally so this package imports nothing of the plugin or of PI   |

The setting's precedence, the loop guard and the contract's types live in
`@synadia-ai/agent-fabric`, shared by every add-on under `plugins/`; this
package re-exports them, the contract's `PluginHarness` as `Harness`.

## Development

Built like the fabric package (tsup, ESM and CJS, vitest, eslint,
prettier). It links `@synadia-ai/agent-fabric` at `file:../../typescript`,
built first, and the two protocol SDK packages by the same `file:` links
the fabric package uses; no lockfile is committed while the links point
outside the repo. The tests: unit, a fake of the plugin driving the events
(`test/support/fake-plugin.ts`); integration, the factory's hooks on a real
`AgentService` and `Agents` over a local `nats-server` in operator mode,
the edges on the wire validated against `test-fixtures/schemas/edge.json`.

```sh
(cd ../../typescript && npm install && npm run build)
npm install
npm run typecheck && npm run lint && npm run format:check
npm test
npm run build
```

## License

Apache-2.0, like the fabric package. See [LICENSE](LICENSE).
