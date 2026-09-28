# @synadia-ai/agent-fabric-pi

The Synadia Agent Fabric add-on for the PI channel plugin
(`@synadia-ai/nats-pi-channel`, `agents/pi` in
[`synadia-agents`](https://github.com/synadia-ai/synadia-agents)). One
extension module in the shape the plugin loads: named in
`SYNADIA_PI_EXTENSIONS`, it puts the fabric package's tracing on the
plugin's service and on the client its agent tools prompt through, the
fabric's two headers on PI's own model calls, and the `409` loop guard in
front of PI's handler. It also ships ScratchPad's skill with the sp command
line, so PI's model reads, publishes and shares ScratchPad content through
its bash tool. Without it the plugin is the plain plugin. The contract it
fills is the plugin's `agents/EXTENSIONS.md`; the spec is
[`../../docs/plugins.md`](../../docs/plugins.md) §2, §3.1, §3.2 and §9.

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
its own delegations. No `stopping`: an edge is published before the prompt
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

## ScratchPad

The package carries ScratchPad's skill, adapted for an agent on the fabric,
in `skill/scratchpad/`: `SKILL.md`, `scripts/sp`, and `bin/` with the sp
command line for darwin and linux on arm64 and amd64. It is the one skill
every add-on ships, kept in `../scratchpad-skill` and installed here by
`npm run build:sp`. The model runs
`scripts/sp` through PI's bash tool; the harness's tools stay as the
operator configured them, and PI asks no permission for any command.

**The operator's step.** Start PI with the skill and the bash tool on:

```sh
pi --mode rpc … \
  -e <plugin>/extensions/nats-channel.ts \
  --skill <add-on>/skill/scratchpad \
  --tools bash,discover_agents,prompt_agent,answer_agent
```

`--skill` loads the directory even under `--no-skills`. PI lists the skill
to the model only when its `bash` or `read` tool is on, so
`--no-builtin-tools` alone hides it; `--tools` naming `bash` and the
plugin's tools keeps them. Then name a volume for PI's identity, reserved
by the ScratchPad operator: the extension entry's `options.scratchpad`, or
the variable.

```json
{ "module": "@synadia-ai/agent-fabric-pi", "options": { "scratchpad": { "volume": "PiVol" } } }
```

**Where the settings come from.** Once the service is up, the add-on
resolves each from the entry's `options.scratchpad` (`volume`, `dir`, `url`,
`creds`), else the variable (`SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR`,
`NATS_URL`, `NATS_CREDS`), else, for the URL and the credentials file, the
plugin's own NATS context (`NATS_CONTEXT`, or `context` in
`nats-channel.json`), which sp cannot read itself. The workspace defaults to
`scratchpad/` in the plugin's state directory (`~/.pi/agent/scratchpad`),
created if missing; keep it across restarts. Without a volume ScratchPad is
off; without a URL and a credentials file it is off with a warning.

**What `scripts/sp` gets.** The add-on sets these in PI's process, and PI's
bash tool passes them to every command (measured on PI 0.85.1):

| Variable                              | Set                                                           | `scripts/sp` adds                                                              |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `SP_NATS_URL`, `SP_NATS_CREDS`        | at start                                                      | `--url`, `--creds`, every call                                                 |
| `SCRATCHPAD_DIR`                      | at start                                                      | `--dir`, every call                                                            |
| `SCRATCHPAD_VOLUME`                   | at start                                                      | `--volume`, on `init` only: a read refuses a volume other than the reference's |
| `SP_CREATOR`                          | at start: PI's prompt address                                 | `--creator`, on `publish-file`                                                 |
| `SP_THREAD_ID`, `SP_ROOT_ID`          | per served prompt, from its hand-over to PI's loop to its end | `--thread-id`, `--root-id`, every call                                         |
| `SP_CALLER_ACCOUNT`, `SP_CALLER_USER` | the same, for a verified caller                               | `--grantee-account`, `--grantee-user`, on `grant` and after `publish-file`     |
| `SP_GRANTS_FILE`                      | at start: `<workspace>.grants`                                | nothing: it records there each grant sp confirmed, for grant requests          |

The connection has names of its own, not `NATS_URL` and `NATS_CREDS`, which
a plugin may read as its own connection. The model passes none of these
flags; `scripts/sp` refuses them, and refuses a `grant` when no served
prompt has a verified caller, so PI grants read on what it publishes to the
agent that prompted it and to no other. A `publish-file` during a served
prompt with a verified caller also makes that grant, as an SDK-built agent
grants the caller its reply: the result carries `granted_to_caller`, or
`caller_grant_error`. Models skip a separate grant step often enough that
the publication makes it (`docs/plugins.md` §9.12).
On a platform sp is not built for, `scripts/sp` says so, in sp's own error
shape with exit 2. `SCRATCHPAD_BIN` names another sp binary.

**References in and out.** With ScratchPad on, the add-on registers PI as
reading references (`scratchpad_refs_ok: "true"` through the extension's
`metadata`), so discovery shows `reads_scratchpad_references: true` and a
caller's `prompt_agent` hands them to PI. And the references PI's model puts
into its own `prompt_agent` go through the fabric package's ScratchPad
extension, as an SDK-built agent's do: a receiver that reads references is
granted read, first-hand, right before the prompt goes out; any other gets
the text without them and the call's result says how many were removed; a
reference PI was neither given nor made is refused. A reference into PI's
own volume counts as made by PI, since its model publishes with
`scripts/sp`, which the extension does not see. The extension's own grants
run the packaged sp directly, with the settings above.

**Grant requests.** A caller PI handed a reference to may hand it on
through its own agent tools; its ScratchPad extension then asks the creator,
PI, to grant the receiver read (the grant request, `grant-request.ts` in
the fabric package). The add-on answers on PI's service, by the rule every
SDK-built agent answers by: the reference must point into PI's volume, the
requester must hold a live read grant PI made it first-hand, the grantee
must be another agent, and the grant is one path, read only, ten minutes at
most, recorded as made on request, which entitles no one to ask again. The
grants PI's model makes go through `scripts/sp`, which the add-on does not
see, so `scripts/sp` records each one sp confirms in `SP_GRANTS_FILE`
(`<workspace>.grants`), and the add-on counts a live one as first-hand: it
went to the agent whose prompt PI was serving.

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

|                                                                                                                                                                               |                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`, `fabricExtension(ctx, env?)`                                                                                                                                       | the factory of the contract: resolves ScratchPad, then builds the extension; `env` is where the variables are read and ScratchPad's are set, `process.env` by default |
| `createFabricExtension(ctx, env?, scratchPad?)`                                                                                                                               | the same, synchronous, from settings already resolved                                                                                                                 |
| `resolveEdgeSubject(options, env?)`                                                                                                                                           | the setting's precedence, as above                                                                                                                                    |
| `SCRATCHPAD_OPTION`, `SP_VARS`, `ScratchPadHandOn`, `spBinary(env)`                                                                                                           | ScratchPad's option key, the variables `scripts/sp` reads, the tool extension, the packaged sp's path                                                                 |
| `EXTENSION_NAME`, `EDGE_SUBJECT_OPTION`, `EDGE_SUBJECT_VAR`, `IDENTITY_OFF_WARNING`                                                                                           | the constants                                                                                                                                                         |
| `loopGuard()`, `LOOP_GUARD_CODE`, `loopGuardDescription(rootId)`                                                                                                              | the guard on its own: `requestInterceptor`, `promptInterceptor`, `serving(rootId)`, `waiting(rootId)`                                                                 |
| `AgentExtensionContext`, `AgentExtension`, `HarnessEvents`, `ServedRequest`, `Outcome`, `AgentExtensionHandles`, `AgentExtensionSettings`, `Harness`, `AgentExtensionFactory` | the plugin's contract, declared structurally so this package imports nothing of the plugin or of PI                                                                   |

The setting's precedence, the loop guard and the contract's types live in
`@synadia-ai/agent-fabric`, shared by every add-on under `plugins/`; this
package re-exports them, the contract's `PluginHarness` as `Harness`.

## Development

Built like the fabric package (tsup, ESM and CJS, vitest, eslint,
prettier). It links `@synadia-ai/agent-fabric` at `file:../../typescript`,
built first, and the two protocol SDK packages by the same `file:` links
the fabric package uses; its `package-lock.json` is committed, and a clean clone
installs with `npm ci`. The tests: unit, a fake of the plugin driving the events
(`test/support/fake-plugin.ts`); integration, the factory's hooks on a real
`AgentService` and `Agents` over a local `nats-server` in operator mode,
the edges on the wire validated against `test-fixtures/schemas/edge.json`.

`npm run build:sp` installs the skill from `../scratchpad-skill` into
`skill/scratchpad`, building the sp binaries first from ScratchPad's
repository, a checkout next to this one (`SCRATCHPAD_SRC` names another),
at the commit pinned in `../scratchpad-skill/release.json`, with Go on
`PATH`; `npm pack` runs it too (`prepack`). `skill/` is gitignored.
`test/unit/scripts-sp.test.ts` drives the shared `scripts/sp` with fake
binaries and a fake `uname`, and runs the real binary for this machine
through the installed copy when it is built.

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
