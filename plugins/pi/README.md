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
[`docs/plugins.md`](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/plugins.md) §2, §3.1, §3.2 and §9.

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

| Event                                | What the add-on does                                                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promptAccepted(request)`            | keeps `activeTrace()`, the scope tracing bound for this request, by `request.id`                                                                                                                                                                                              |
| `aroundInject(request, run)`         | runs `run` inside `bindActiveTrace(scope, …)`, which replaces the ambient context: the plugin injects the next queued prompt from the previous turn's settle hook, whose context is the previous request's                                                                    |
| `providerHeaders(request)`           | returns `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` for the request or the local turn, so the proxy files PI's own model calls on its thread; each call counts against the scope, so an edge PI's model spawns later says how many calls came before it, retries included   |
| `aroundToolCall(request, tool, run)` | binds the request's or the local turn's scope around `run`, so the edge of a `prompt_agent` PI's model calls is filed under its thread even if PI's tool runner did not inherit the injected context; a local turn has no injection, so this binding is the one its calls get |
| `promptEnded(request)`               | forgets the request                                                                                                                                                                                                                                                           |
| `localTurnStarted(turn)`             | a run no NATS prompt started: mints a root for it (`rootTraceScope()`), keeps it by `turn.id` and opens the guard on it                                                                                                                                                       |
| `localTurnEnded(turn)`               | forgets the turn and closes its guard                                                                                                                                                                                                                                         |

A request the add-on never saw (no scope kept) is left alone: no headers,
`run` called as it is.

**Local turns.** A run no NATS prompt started, typed at PI's terminal, is a
thread too. The plugin reports it as a local turn, from the run's
`agent_start` to its `agent_settled`, and the add-on gives it a root of its
own: its model calls carry the root's two headers, the agents its model
prompts hang beneath it, and a child that prompts PI back during the turn
is refused with `409`, as for a served request. No edge is written for the
root itself: it is implicit, like the root minted for an envelope without
the pair, and has no caller. Stated honestly: text typed while a run is
going joins that run, a NATS prompt's or a local turn's; PI gives the
plugin no way to tell the two apart.

**The `409` loop guard.** PI serves one turn at a time and cannot serve a
prompt while its model waits on a call to another agent, so a prompt of a
tree PI is waiting in is refused at once with `409` instead of queueing
behind the wait it is part of. PI waits from the moment its model sends a
prompt until every call the served request has open has settled: a
blocking `prompt_agent` until it returns, a call started with `wait: false`
for as long as it is open. With no call open, a prompt of the tree is
admitted. The guard is two more interceptors and a wrapper: its request
interceptor, after tracing's, keeps the served request by the scope tracing
bound for the handler's duration and refuses an arriving prompt whose root
a served request is waiting in, before `next()`, with
`RequestRejectedError(409, …)`; its prompt interceptor, on the plugin's
client, runs in the tool call's context and marks that request as waiting;
its `aroundToolCall`, inside the add-on's, lifts the mark when a tool
result counts no open call and no other agent-tool call of the request
runs. A call that fails or expires while the model runs no agent tool keeps
the mark until the next agent-tool result or the served prompt's end. The
root is read from the scope tracing bound, never from the envelope. Stated
honestly: this also refuses a legitimate second prompt of the same tree
that arrives while PI waits in it, such as a sibling delegation issued with
`wait: false` by the same coordinator; PI would have queued it anyway, and
the guard turns the queue into a refusal the caller sees at once. A local
turn is guarded the same way: the add-on opens the guard on its root at the
turn's start (`open(scope)`) and closes it at its end.

**What it does not do.** No `served` record: PI's calls carry the headers,
so they need none, and PI writes nothing to `TRACE.edges` but the edges of
its own delegations. No `stopping`: an edge is published before the prompt
it describes and counted as it goes, so there is nothing to flush.

## Naming it

The published `@synadia-ai/agent-fabric-pi` is the whole plugin since 0.2.0
(2026-10-11): the pi channel plugin, this add-on and ScratchPad's skill in
one package, installed pi's own way (`pi install npm:@synadia-ai/agent-fabric-pi`), its entry loading the add-on
unless an extension variable names others (`bundles/build.sh`, `bundles/npm/pi.md`).
This folder is the add-on's source and is not published alone. What follows
names the add-on to a channel plugin installed apart from it, as the fabric's
own launchers do with this folder built.

Built where PI runs and
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
resolves the volume and the workspace from the entry's `options.scratchpad`
(`volume`, `dir`), else the variable (`SCRATCHPAD_VOLUME`,
`SCRATCHPAD_DIR`). The URL and the credentials file are the connection
PI's channel takes, so sp connects as the agent: `options.scratchpad`'s
`url` and `creds` first, each on its own; then the context `NATS_CONTEXT`
names; with `NATS_CONTEXT` set but empty, or `NATS_URL`, `NATS_CREDS` or
`NATS_CREDENTIALS` set, those variables (`NATS_CREDS` winning) and never a
context; otherwise the `context` in `nats-channel.json`. The add-on reads
the context file, which sp cannot read itself. The workspace defaults to
`scratchpad/` in the plugin's state directory (`~/.pi/agent/scratchpad`),
created if missing; keep it across restarts. Without a volume ScratchPad is
off; without a URL and a credentials file it is off with a warning.

**What `scripts/sp` gets.** The add-on sets these in PI's process, and PI's
bash tool passes them to every command (measured on PI 0.85.1):

| Variable                              | Set                                                                                                      | `scripts/sp` adds                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `SP_NATS_URL`, `SP_NATS_CREDS`        | at start                                                                                                 | `--url`, `--creds`, every call                                                 |
| `SCRATCHPAD_DIR`                      | at start                                                                                                 | `--dir`, every call                                                            |
| `SCRATCHPAD_VOLUME`                   | at start                                                                                                 | `--volume`, on `init` only: a read refuses a volume other than the reference's |
| `SP_CREATOR`                          | at start: PI's prompt address                                                                            | `--creator`, on `publish-file`                                                 |
| `SP_THREAD_ID`, `SP_ROOT_ID`          | per served prompt, from its hand-over to PI's loop to its end; per local turn, from its start to its end | `--thread-id`, `--root-id`, every call                                         |
| `SP_CALLER_ACCOUNT`, `SP_CALLER_USER` | the same, for a verified caller; a local turn has none                                                   | `--grantee-account`, `--grantee-user`, on `grant` and after `publish-file`     |
| `SP_GRANTS_FILE`                      | at start: `<workspace>.grants`                                                                           | nothing: it records there each grant sp confirmed, for grant requests          |

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
thread's calls carry its timing. A turn typed at PI's terminal is a task of
its own: PI its root, asked by no caller, all its model calls in one
thread, and the agents it prompts beneath it.

## Public API

|                                                                                                                                                                                            |                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`, `fabricExtension(ctx, env?)`                                                                                                                                                    | the factory of the contract: resolves ScratchPad, then builds the extension; `env` is where the variables are read and ScratchPad's are set, `process.env` by default |
| `createFabricExtension(ctx, env?, scratchPad?)`                                                                                                                                            | the same, synchronous, from settings already resolved                                                                                                                 |
| `resolveEdgeSubject(options, env?)`                                                                                                                                                        | the setting's precedence, as above                                                                                                                                    |
| `SCRATCHPAD_OPTION`, `SP_VARS`, `ScratchPadHandOn`, `spBinary(env)`                                                                                                                        | ScratchPad's option key, the variables `scripts/sp` reads, the tool extension, the packaged sp's path                                                                 |
| `EXTENSION_NAME`, `EDGE_SUBJECT_OPTION`, `EDGE_SUBJECT_VAR`, `IDENTITY_OFF_WARNING`                                                                                                        | the constants                                                                                                                                                         |
| `loopGuard()`, `LOOP_GUARD_CODE`, `loopGuardDescription(rootId)`                                                                                                                           | the guard on its own: `requestInterceptor`, `promptInterceptor`, `aroundToolCall(scope, run)`, `open(scope)`, `serving(rootId)`, `waiting(rootId)`                    |
| `AgentExtensionContext`, `AgentExtension`, `HarnessEvents`, `ServedRequest`, `LocalTurn`, `Outcome`, `AgentExtensionHandles`, `AgentExtensionSettings`, `Harness`, `AgentExtensionFactory` | the plugin's contract, declared structurally so this package imports nothing of the plugin or of PI                                                                   |

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
`skill/scratchpad`. It downloads the four published binaries pinned in
`../scratchpad-skill/release.json` and verifies their archive and executable
hashes with Node 20+. `npm pack` runs it too (`prepack`). `skill/` is
gitignored. No Go compiler or service checkout is required. The
[binary guide](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/scratchpad-binaries.md) covers authenticated
downloads, offline archives, cache checks, and the included licenses.
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

Apache-2.0, like the fabric package. See [LICENSE](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/plugins/pi/LICENSE).

Short artifact references
-------------------------

The shared wrapper and grant records accept `sp-r1:` short tokens and existing `sp-ref:` tokens.
Publication uses the short form when the service and the selected client support it.
Short-token reads and resolution require a compatible `sp` binary selected through
`SCRATCHPAD_BIN`. The bundled CLI release is pinned independently; this change
does not advance that pin.
Copy the returned token unchanged into prompts and replies.
The token survives client restarts; each content read still requires current authorization.
See the [native client contract](https://github.com/synadia-ai/agent-fabric-sdk/blob/main/docs/scratchpad-native.md) for recovery and capability fallback.
