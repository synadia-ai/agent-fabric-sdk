# How a plugin joins the fabric

**Version:** 0.1.0-alpha · **Date:** 2026-09-23 · **Status:** the spec for phase B; draft for Francesco's review

This document is two things. It is the spec the next three sessions build
from, in this order: PI, OpenClaw, Claude Code. And it is the guide a plugin
author reads who wants a harness plugin from the public protocol repo to
take part in the Synadia Agent Fabric. Every claim below names its
mechanism and cites the code it rests on. The interface shapes in
TypeScript are proposals until they are built; where a hook the add-on
needs does not exist yet, §3.5 names the gap.

The repos: `synadia-agents` (public; the protocol SDKs and the plugins, on
branch `sdk-release-rollout` at `40fab3a`), this repo (`agent-fabric-sdk`,
private while it is built; the fabric package and, under `plugins/`, the
add-ons), `synadia-agent-fabric` (the decisions and the contracts). The
plugins' state before the SDK split is `synadia-agents` `fbd16ab` (PR #201,
2026-09-21); the split is `f2ff6ed` (PR #205, 2026-09-22).

## 1. The shape in one screen

**One plugin per harness, in the public repo.** `agents/pi`,
`agents/openclaw` and `agents/claude-code` in `synadia-agents` are the only
plugins for Claude Code, OpenClaw and PI. They speak the protocol and nothing
else. Each will offer the SDK's agent tools, `AgentTools`, with the blocking
three by default (`discover_agents`, `prompt_agent`, `answer_agent`;
`BLOCKING_AGENT_TOOLS` in `@synadia-ai/agents`), so every harness can
discover and prompt the other agents (`synadia-agents` `docs/agent-tools.md`
§5). Today none of the three has tools: PI registers two slash commands
(`agents/pi/extensions/nats-channel.ts`, `pi.registerCommand` for
`nats-status` and `nats-configure`), OpenClaw registers none
(`agents/openclaw/src/channel.ts`), Claude Code exposes `reply` and
`request_info` (`agents/claude-code/server.ts`).

**One extension point, neutral.** Each plugin loads optional extension
modules named by an environment variable or its config file, and hands each
module what the protocol SDK's hooks accept, its tools' extension hooks, and
the harness's events (§2). The public repo never names what an extension is
for.

**One add-on per harness, here.** `plugins/pi`, `plugins/openclaw` and
`plugins/claude-code` in this repo are such modules. Each wires the fabric
package's tracing, `fabricTracing()`, into the plugin's client and service,
and adds the harness piece the fabric needs: the trace headers on PI's model
calls, the `served` pair and the `traceparent` seed for OpenClaw, the
`served` pair on the Claude Code session for Claude Code (§3).

**Without the variable, nothing changes.** A plugin that loads no extension
is the plain plugin as it is today at `40fab3a`.

**Why not two plugins.** Francesco asked why the plugins should exist twice,
in `synadia-agents` and here. They should not (decision 34 in
`synadia-agent-fabric/CLAUDE.md`, 2026-09-23). A second copy drifts from the
first, and every harness fix would land twice. The split's rules also
require this shape (`synadia-agent-fabric/docs/sdk-split.md` §1): the
dependency goes one way, from the fabric to the protocol SDK, never back;
nothing is copied, the fabric repo depends on the published SDK packages;
and nothing fabric-specific enters the public repo, not in code, not in
READMEs, not in doc names.

**Why now.** Until 2026-09-21 the three plugins carried tracing themselves.
The split removed it from both SDKs and from the plugins (the diff
`fbd16ab..f2ff6ed` under `agents/` is 3266 lines, tests included) and
rebuilt it here on the SDK's hooks. Since then the three harnesses are not
traced at all: their model calls stand as one-call threads outside the tree
(`agent-fabric-examples` `docs/findings.md` F16). Full tracing for these
three harnesses is the fabric's headline promise, so this work is
release-critical.

## 2. The extension point the public plugin exposes

This section is the neutral contract. It is written so that §9 can be pasted
into the public repo without a fabric word. Names are proposals.

### 2.1 Naming the module: the variable and its config twin

The variable is **`SYNADIA_AGENT_EXTENSIONS`**, with one per-harness
variable that wins over it: `SYNADIA_PI_EXTENSIONS`,
`SYNADIA_OPENCLAW_EXTENSIONS`, `SYNADIA_CLAUDE_CODE_EXTENSIONS`. The config
twin is a field **`extensions`** in each plugin's own configuration: PI's
`nats-channel.json`, OpenClaw's `channels.nats.accounts.<id>` block (and so
the manifest's config schema in `openclaw.plugin.json`), Claude Code's
`~/.claude/channels/nats/config.json`. Precedence: the per-harness variable,
then the shared variable, then the config field, the same order the three
plugins already use for `SYNADIA_PI_OWNER` over `SYNADIA_OWNER` over the
config's `owner` (`agents/pi/README.md` "Environment variables",
`agents/claude-code/README.md` "Environment variables").

The reason for this name: decision 34 proposed `SYNADIA_AGENT_EXTENSIONS`,
the `SYNADIA_*` prefix is the convention the three plugins already share for
settings that mean the same thing in each, and `AGENT` says the extensions
belong to the agent the plugin registers, not to the harness. A single
`extensions` config field keeps the per-harness spelling identical.

The value names one or more modules, separated by commas in the variable,
as a JSON array in the config. Each entry is a **package name** or an
**absolute path** (a directory with a `package.json`, or a file). The config
form also takes an object, `{ "module": "…", "options": { … } }`, so a
module can be given settings the plugin does not interpret (§2.3). A
relative path is refused: the plugins' working directories differ per
harness, so a relative path would mean something different in each.

### 2.2 Loading

The plugin resolves each entry and loads it with a dynamic `import()`, once,
at start, before it connects. A path is imported as a `file:` URL; a package
name is resolved from the plugin's own location upward, the way any import
is, so an extension installed next to the plugin or above it is found by
name and one installed elsewhere is given by path.

This works from Claude Code's bundled `runtime/server.js` too. The bundle is
a `Bun.build` of `server.ts` with both SDKs inlined
(`agents/claude-code/scripts/build-runtime.ts`). A dynamic `import()` whose
specifier is a runtime value is left in the bundle as an import for the
runtime, so the bundle must keep it that way: the specifier stays a
variable, never a literal the bundler could inline, and the plugin never
lists the extension as a dependency of its own. The consequence is that an
extension always runs on its own installed copy of the SDK packages, never
on the plugin's. §2.7 says what that requires of the SDK and of the fabric
package.

A module that cannot be resolved, cannot be imported, or whose factory
throws is logged once, with the error, and the plugin starts plain. The
plugin's status output (PI's `/nats-status`, OpenClaw's `gateway starting`
line, Claude Code's `request_info` and its `connecting` log event) names the
extensions it loaded, so a misspelled path is visible.

### 2.3 The module's export

One default export, a factory, called once at start with what the plugin
knows before it connects. It returns the extension, or a promise of it.

```ts
// Proposed. Names are the public plugin's; nothing here is specific to any extension.
import type { Agents, AgentToolsExtension, Logger, PromptInterceptor } from "@synadia-ai/agents";
import type { AgentService, RequestInterceptor } from "@synadia-ai/agent-service";

export type Harness = "pi" | "openclaw" | "claude-code";

/** What the plugin knows when it loads the module, before it connects. */
export interface AgentExtensionContext {
  readonly harness: Harness;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly settings: {
    /** The address tokens: agents.prompt.<token>.<owner>.<name>. */
    readonly owner: string;
    readonly name: string;
    readonly senderIdentity: "off" | "signed";
    readonly minSenderTrust: "any" | "signed";
    /** Where the plugin keeps its files, when it has such a directory. */
    readonly stateDir?: string;
    /** The plugin's configuration as read, unknown keys included; read-only. */
    readonly config: Readonly<Record<string, unknown>>;
  };
  /** The `options` of this module's config entry, verbatim; `{}` when the variable named it. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The plugin's logger, in the SDK's `Logger` shape. */
  readonly logger: Logger;
}

export default function createExtension(
  ctx: AgentExtensionContext,
): AgentExtension | Promise<AgentExtension>;
```

The identity signer is not handed to the factory. Signing goes through the
plugin's `Agents` client, which the extension receives once the plugin is on
the bus (`started`, §2.4). The client's `publishSigned(subject, payload,
{ nonce })` signs with the plugin's identity, and a prompt interceptor gets
the same through its `ctx.identity`. So an extension never holds a signer.

### 2.4 What the plugin hands the extension, and what it takes back

```ts
export interface AgentExtension {
  readonly name: string;
  /** (a) For the plugin's `Agents` client: `new Agents({ interceptors })`. */
  readonly promptInterceptors?: ReadonlyArray<PromptInterceptor>;
  /** (a) For the plugin's `AgentService`, before the plugin's own interceptors. */
  readonly requestInterceptors?: ReadonlyArray<RequestInterceptor>;
  /** (a) For the plugin's `AgentService`: `heartbeatExtras`. */
  readonly heartbeatExtras?: () => Readonly<Record<string, unknown>>;
  /** (b) For the plugin's `AgentTools`: `extensions`. */
  readonly toolExtensions?: ReadonlyArray<AgentToolsExtension>;
  /** After the service started: the live handles. Awaited, bounded by the plugin. */
  started?(handles: { readonly agents: Agents; readonly service: AgentService }): void | Promise<void>;
  /** Before the plugin stops its service. Awaited, bounded by the plugin. */
  stopping?(): void | Promise<void>;
  /** (c) The harness's events. */
  readonly events?: HarnessEvents;
}
```

**(a) The SDK's hooks.** The plugin gives its `AgentService` the extension's
request interceptors and heartbeat extras, and its `Agents` client the
extension's prompt interceptors. These are the SDK's own types, so this
needs no type of any extension's: `PromptInterceptor` in two phases
(`client-sdk/typescript/src/prompt/interceptor.ts`),
`RequestInterceptor.aroundRequest(ctx, next)` and `RequestRejectedError`
(`agent-sdk/typescript/src/interceptor.ts`), `heartbeatExtras`
(`AgentServiceOptions`, `agent-sdk/typescript/src/service.ts`). The
service's interceptors run in order: the extensions' first, in the order
loaded, then the plugin's own, which today is one, the tools' scope
(`tools.requestInterceptor`). So an extension's interceptor wraps the
plugin's, and a request an extension refuses opens no tools scope.
`heartbeatExtras` is one provider per service; a plugin with extras of its
own, none today, merges them and lets its own keys win.

Today the plugins give these constructors nothing of the kind. Each
constructs one `AgentService` with `nc`, the address tokens, `identity:
{ signer }` when signed, and `minSenderTrust`
(`agents/pi/extensions/nats-channel.ts`, `agents/openclaw/src/gateway.ts`,
`agents/claude-code/server.ts`). None keeps an `Agents` client: PI and
OpenClaw create none, Claude Code creates one to find a free session name at
start and closes it. The tools work of phase B gives each plugin one client,
with the same signer as its service and the extensions' interceptors, and
that client is what `AgentTools` prompts through.

**(b) The tools' extension hooks.** `AgentTools` takes `extensions`, each
with any of three hooks: discovery fields, a prompt rewrite, a reply look
(`docs/agent-tools.md` §6.3; `AgentToolsExtension` in
`client-sdk/typescript/src/tools/agent-tools.ts`). The plugin passes the
extension's `toolExtensions` through. The tool subset is the plugin's
setting, not the extension's: the plugin offers the blocking three by
default and its configuration may name the six; an extension may not change
it, since a subset the helper refuses would stop the plugin at start
(§5 of the tools contract).

**(c) The harness's events.** These are what the pre-split code needed, per
harness, read at `fbd16ab` and written as plugin events. Two kinds: a
*notification*, called and forgotten, and a *wrapper*, which the plugin
calls around one of its own steps so the extension can run that step inside
a context of its choosing.

```ts
export interface ServedRequest {
  /** The plugin's id for the request, unique in the process. */
  readonly id: string;
  /** The envelope's fields the protocol does not define (§5.6), as decoded. */
  readonly extras: Readonly<Record<string, unknown>>;
  /** The verified sender's id, when the signature verified. */
  readonly caller?: string;
  /** Claude Code only: the session the prompt was delivered to, when known. */
  readonly sessionId?: string;
}

export type Outcome = "ok" | "error" | "timeout";

export interface HarnessEvents {
  // Every harness.
  promptAccepted?(request: ServedRequest): void;
  promptEnded?(request: ServedRequest, outcome: Outcome, atMs: number): void;
  aroundToolCall?<T>(request: ServedRequest | undefined, toolName: string, run: () => T): T;
  // PI.
  aroundInject?<T>(request: ServedRequest, run: () => T): T;
  providerHeaders?(request: ServedRequest): Readonly<Record<string, string>> | undefined;
  // OpenClaw.
  aroundDispatch?<T>(request: ServedRequest, run: () => Promise<T>): Promise<T>;
  // Claude Code.
  sessionStarted?(sessionId: string, source: string): void;
  turnStopped?(sessionId: string | undefined, atMs: number): void;
}
```

| Event | Harness | Kind | When the plugin calls it | Pre-split need it replaces |
| --- | --- | --- | --- | --- |
| `promptAccepted` | all | notification, synchronous | inside the prompt handler, in the request's async context, after every interceptor has run. An extension reads here what its own request interceptor bound | PI: `activeTrace()` captured at `enqueue` (`nats-channel.ts` `fbd16ab`); OpenClaw: `activeTrace()` at `beginTurn` (`gateway.ts`); Claude Code: the same plus `resolveClaudeSessionId` (`server.ts`) |
| `promptEnded` | all | notification, synchronous | when the plugin settles the request: PI at `agent_settled`, or a failure or expiry; OpenClaw when the dispatch resolved, `error` when it threw or reported a dispatch error; Claude Code when `reply` completed with `done`, on a handler failure, or on the 30-minute request TTL (`timeout`) | OpenClaw's `turn.settle(status)`; Claude Code's `pending.outcome` |
| `aroundToolCall` | all | wrapper, synchronous | around every `tools.execute()`, with the request the plugin believes the model is working in: PI's and OpenClaw's active turn, Claude Code's `request_id` argument or its last active request | Francesco's `activeTrace() ?? promptQueue.active?.trace` in PI, `associateAgentTraceScope` in OpenClaw, `lastActiveRequestId` in Claude Code (`cozis/feat/non-sdk-prompt-tools`) |
| `aroundInject` | PI | wrapper, synchronous | around `pi.sendUserMessage()`; the extension must call `run` once and return its value | `injectInScope(pending.trace, …)` |
| `providerHeaders` | PI | query, synchronous | from PI's `before_provider_headers` while a served request is PI's active turn; the plugin merges the returned headers into the event's headers | `Object.assign(event.headers, active.traceHeaders)` |
| `aroundDispatch` | OpenClaw | wrapper, asynchronous | around `dispatchInboundDirectDmWithRuntime()` | `runWithTraceId(traceId, …)` |
| `sessionStarted` | Claude Code | notification, synchronous | when the plugin learns of a `SessionStart` from its hook (§2.6), with the hook's `session_id` and `source` | the `SessionStart` file read at prompt arrival |
| `turnStopped` | Claude Code | notification, synchronous | when the plugin learns of a `Stop` from its hook, with the time the hook recorded | the `Stop` file polled by `turnStopWaiter` |

Synchronous means the plugin does not await a returned promise. The
wrappers preserve synchrony: `aroundInject` and `aroundToolCall` must call
`run` synchronously and return what it returned, a promise included, so an
extension that binds an `AsyncLocalStorage` around `run` changes nothing of
the step's timing. `started` and `stopping` are awaited, each bounded by the
plugin (a few seconds), so a slow extension delays start or stop by at most
that.

### 2.5 When the extension throws

The plugin keeps serving. Every event call is wrapped: a throw is logged
once per event name and ignored; a wrapper that throws before it called
`run`, or returns without calling it, has `run` called by the plugin itself.
Fail-open is how tracing always behaved (the fabric package's
`publishEdge`, `typescript/src/tracing.ts`; the pre-split `ServedPublisher`).

The interceptors keep the SDK's semantics, which are not the plugin's to
change: a request interceptor that throws before `next()` refuses the
request with that error (`RequestRejectedError` gives the code; anything
else is `500`), and a prompt interceptor's `beforePrompt` that throws fails
that prompt. A tools extension that breaks the contract is a bug the helper
throws or logs (§6.3 of the tools contract). The fabric's tracing never
throws from these hooks except to refuse a malformed envelope with `400`,
and the `409` guard of §3.1 refuses on purpose.

### 2.6 What the public plugin must keep or add

- **The events of (c)**, called where the table says. For PI and OpenClaw
  this is a few lines in the handler, the settle path and the dispatch.
- **Claude Code's hooks come back into the public plugin, as neutral session
  events.** Before the split the plugin shipped `hooks/hooks.json` and
  `hooks/session-event.ts` (`fbd16ab`): a `SessionStart` hook wrote the
  current session id to `<state dir>/sessions/<Claude Code pid>`, a `Stop`
  hook wrote the turn's end time next to it, and the server read the files.
  The split removed them with tracing (they wrote nothing with tracing off).
  They return, and they always write: the plugin, not an extension, owns the
  harness's hooks, and two neutral needs want them regardless of any
  extension. `SessionStart` lets the server follow `/clear`, which starts a
  new session id under the same MCP server (`src/session-id.ts` at
  `fbd16ab`); the session id is also what `request_info` can report. And a
  third hook, **`PreToolUse`**, gives the plugin the model's tool-call ID,
  which an MCP tool call does not carry: the hook's input holds
  `tool_use_id` and `tool_name` (Claude Code's hooks reference, 2026-09-23),
  the hook runs to completion before the tool executes, so the file it
  writes is there when the `prompt_agent` request reaches the server, and
  the plugin passes the id to `tools.execute(name, args, { toolCallId })`
  as the tools contract asks (§3.11). `CLAUDE_PID` names the Claude Code
  process in a hook's environment; the server falls back to its parent pid
  as before. How the server learns of a `Stop` while a reply waits for it,
  a watch on the sessions directory or a bounded poll, is the plugin's.
- **Claude Code's `request_id`.** A `request_id` argument on `prompt_agent`
  and the other tools names the served prompt when several are pending;
  the helper ignores arguments it does not define
  (`synadia-agent-fabric/docs/agent-tools.md` §2.3). The plugin adds it to
  the definitions it shows and uses it to pick the request for
  `aroundToolCall`, falling back to its last active request, which it
  already tracks for permission queries (`server.ts`, `lastActiveRequestId`).
- **One persistent `Agents` client** per plugin, with the plugin's signer and
  the extensions' prompt interceptors, for `AgentTools` (§2.4 (a)).

### 2.7 What the extension may not do

- **Reach into the plugin's internals.** The extension sees the context of
  §2.3, the handles of `started`, and the events. Nothing else is promised.
- **Change the wire.** The protocol fields and `Agent-Sender` cannot be set
  by an interceptor; the SDK refuses them (`PromptExtras`). An extension adds
  fields the protocol does not define (§5.6) and headers, and publishes
  messages of its own through `publishSigned`.
- **Refuse a prompt except through the SDK's interceptor.** The one way to
  refuse is `RequestRejectedError` thrown before `next()`; the `409` loop
  guard of §3.1 is expressed exactly so. An extension never answers the
  caller itself.
- **Assume it shares the plugin's copy of the SDK.** The extension runs on
  its own installed copy of `@synadia-ai/agents` and
  `@synadia-ai/agent-service` (§2.2), always for Claude Code's bundle and
  usually for the others. So anything crossing the boundary must be
  copy-safe: the interceptor and extension types are structural interfaces;
  the host recognizes a `RequestRejectedError` from another copy by its
  `name` (`service.ts`, the `instanceof || err.name === …` check); the
  fabric package keeps the trace scope and the record counters on
  `globalThis` under a well-known symbol for exactly this case
  (`typescript/src/trace.ts`, the comments at `COUNTERS_KEY` and
  `STORAGE_KEY`).

## 3. What the add-on does, per harness

The add-on is one TypeScript package per harness (§5), each exporting the
factory of §2.3. Everything fabric-specific is here and in the fabric
package; nothing of it is in the public plugin.

### 3.1 Common to the three

**Tracing on the service and the client.** The factory calls
`fabricTracing({ edgeSubject })` once (`typescript/src/tracing.ts`) and
returns its three hooks: `requestInterceptor` in `requestInterceptors`,
`promptInterceptor` in `promptInterceptors`, `heartbeatExtras` as itself.
That gives the harness exactly what an SDK-built agent has:

- On the service, per request: the envelope's `thread_id` and `root_id` are
  adopted, or a root is minted when neither is there; a half pair, or a
  malformed id, is refused with `400` before the handler runs
  (`scopeFor`, `lineageField`); the handler runs inside the trace scope,
  which `activeTrace()` reads.
- On the client, per prompt: phase one mints the child thread and puts the
  pair into the envelope, inheriting root and parent from the ambient scope;
  phase two publishes the signed `edge` record on the edge subject,
  `TRACE.edges` by default (`DEFAULT_EDGE_SUBJECT`), the record id doubling
  as the `Agent-Sender` nonce and the `Nats-Msg-Id`. The record follows
  `test-fixtures/schemas/edge.json`, vendored from the fabric's
  `docs/schemas/edge.json`.
- On the heartbeat: `records_published` and `records_dropped`, the
  process-wide counts (`traceRecordCounts`), so the console sees what a
  harness failed to publish.

**The tool-call ID.** `AgentTools` puts the model's tool-call ID into every
prompt's context under `toolCallId` (`TOOL_CALL_ID_CONTEXT_KEY`), and the
prompt interceptor writes it on the edge. So a delegation the harness's
model makes hangs under its tool call in the console with no extension
code, once the plugin passes the id to `execute()`
(`synadia-agent-fabric/docs/agent-tools.md` §2.1).

**The `409` loop guard.** A harness cannot serve a prompt while its model
waits inside a blocking tool call, so it refuses an incoming prompt whose
`root_id` names a tree it is waiting in, with `409`
(`synadia-agent-fabric/docs/agent-tools.md` §2.3; decision 31). The add-on
builds it from what it already has: its own request interceptor, placed
after tracing's, marks the request's root as *served* for the handler's
duration; its own prompt interceptor, which runs in the async context of
the `prompt_agent` call and so inside the served request's scope, marks that
root as *waiting*; an arriving prompt whose adopted root is marked *waiting*
is refused with `RequestRejectedError(409, …)` before `next()`. The mark is
cleared when the served prompt ends. Stated honestly: this refuses a
legitimate second prompt of the same tree that arrives while the harness
waits in it, a sibling delegation issued with `wait: false` by the same
coordinator. PI and OpenClaw serve one turn at a time anyway, so that prompt
would have queued; the guard turns the wait into a refusal the caller sees
at once.

**Identity.** `edge` and `served` records are signed, so the add-on needs
`senderIdentity: signed`. With identity off the add-on logs one warning at
start, as the pre-split plugins did (`tracing is on but senderIdentity is
off; trace records are signed, so none will be published`), the fabric
package warns once more when the first record is due, and every record owed
counts as dropped (`publishEdge`; the pre-split `ServedPublisher`).

**Settings.** One: the edge subject, default `TRACE.edges`, from the config
entry's `options.edgeSubject` or the variable `SYNADIA_FABRIC_EDGE_SUBJECT`,
validated by the fabric package (`assertValidTraceOptions`). The add-on's
presence is the switch; there is no `tracing` setting (§4).

**ScratchPad.** Not in a harness for the MVP. The fabric package's
`scratchPadExtension` exists and fits `toolExtensions`, but a harness hands
files over as attachments only; references in a harness are level D, Phase
III (`synadia-agent-fabric/docs/agent-tools.md` §2.3). The add-ons return
no `toolExtensions`.

### 3.2 PI — the SDK's headers on PI's own model calls

**The join.** PI fires `before_provider_headers` before every provider
request (PI 0.85.1 on this machine, `dist/core/extensions/types.d.ts`; the
pre-split plugin used it on 0.84). The proxy files a call by the SDK pair
when it carries `X-Synadia-Thread-ID` and `X-Synadia-Root-ID`
(`afo-design.md` §8.1; `proxy/forward.go` `sdkThreadIDsFromRequest`). So
PI's calls need no record: the headers alone put them on the served thread,
exactly as an SDK agent's.

**What the add-on does.**

1. `promptAccepted(request)`: read `activeTrace()`, the scope tracing bound
   for this request, and keep it by `request.id`.
2. `aroundInject(request, run)`: run `run` inside `bindActiveTrace(scope,
   …)`, so PI's loop, and any tool it executes, sees this request's thread
   and nothing else's. The pre-split code also neutralized the injecting
   context first with `AsyncLocalStorage.snapshot()`, because a prompt was
   injected from another prompt's settle hook; whether B2 needs that depends
   on where the plugin injects from (§3.5, gap 3). Measured in B2 (PI
   0.85.1, 2026-09-23): the plugin does inject the next queued prompt from
   the previous turn's settle hook, so `bindActiveTrace`, an
   `AsyncLocalStorage.run`, replaces that context and no snapshot is
   needed; `plugins/pi` does exactly this.
3. `providerHeaders(request)`: return `bindActiveTrace(scope, traceHeaders)`.
   One call per provider request, so the scope's `turnCountHint` counts PI's
   model calls, retries included, and an edge PI's model spawns later says
   how many calls came before it. The pre-split code computed the headers
   once at `enqueue` and reused them; the wire is the same two headers
   either way, only the hint on the edge differs.
4. `aroundToolCall(request, …, run)`: bind the request's scope, so a
   `prompt_agent` PI's model calls writes its edge under the served thread
   even when PI's tool runner has not inherited the injected context.

No `served` record. PI writes nothing to `TRACE.edges` but the edges of its
own delegations.

**What the console shows when it works.** PI's model calls on the child
thread the caller's edge created, PI the executor, its depth `full` in the
agents view; the `asked` row of the caller's story names PI. A delegation
PI's model makes is a grandchild under its tool call. No outcome or
duration from a pair: PI publishes none, and the thread's calls carry its
timing. F16 item 4 in the examples' findings describes today's picture; the
same run with the add-on is the check.

**What the test repo asserts.** The three waivers marked
`scenario.PluginsPending` go: `scenarios/smoke/pi_one_prompt_test.go` (the
console step: the root as one thread with PI's call at its key's counts, PI
the executor, filed as an SDK thread), `scenarios/gate/m2/pi_at_leaf_test.go`
(the log half: PI's thread one level down with its call, stamped with the
pair agent-1's edge names, that edge verified; the console half: two
threads, PI's with its call, agent-1 its verified caller), and the three
`Waive` calls guarded by `Untraced` on PI's member in
`scenarios/gate/m3/acceptance_path_test.go` (full depth, its call under the
root, the tree naming it the executor).

### 3.3 OpenClaw — a trace id per prompt and the `served` pair

**The join.** OpenClaw puts a W3C `traceparent` header on every model call
of a turn, its trace id inherited from the trace scope active when the turn
was dispatched: an `AsyncLocalStorage` OpenClaw keeps on `globalThis` under
`Symbol.for("openclaw.diagnosticTraceScope.state.v1")`, carried through its
command lane on 2026.8 and later (`agents/openclaw/src/trace-scope.ts` at
`fbd16ab`). The proxy files a call carrying a well-formed `traceparent` and
no SDK pair as the harness pair, `harness: openclaw`, `harness_thread_id`
the 32-hex trace id (`proxy/forward.go` `openClawThread`). The plugin cannot
add headers to OpenClaw's provider requests, so it publishes the binding
instead: two signed `served` records per prompt on `TRACE.edges`, `start`
on arrival and `end` with the outcome, naming the thread and the trace id,
bare (`afo-design.md` §8.3; `docs/schemas/served.json`). The reader attaches
the calls filed under that id between the two.

**What the add-on does.** Built in `plugins/openclaw`
(`@synadia-ai/agent-fabric-openclaw`, 2026-09-23): `src/extension.ts` the
factory and the events, `src/trace-scope.ts` the seed from `fbd16ab`; its
README says the same in operator terms.

1. `promptAccepted(request)`: read `activeTrace()`; mint a fresh trace id,
   128 random bits as 32 lowercase hex, never all zeros (`newTraceId`);
   publish `served` `start` with `ts` now, `thread_id` and `root_id` from
   the scope, `harness: "openclaw"`, `harness_thread_id` the trace id. A
   fresh id per prompt, never the caller's thread id, so nothing of the NATS
   side reaches a model provider.
2. `aroundDispatch(request, run)`: run `run` inside OpenClaw's trace scope
   with a context whose `traceId` is the minted id (`runWithTraceId`),
   feature-checked: when the global has another shape, `run` runs as is and
   the header carries an id of OpenClaw's own.
3. `promptEnded(request, outcome, atMs)`: publish `served` `end` with that
   outcome and time. OpenClaw's outcomes are `ok` and `error`.
4. `aroundToolCall(request, …, run)`: bind the request's trace scope, so
   `prompt_agent` from OpenClaw's tool runner writes its edge under the
   served thread. OpenClaw serves one turn at a time per account, so the
   active request is the one.

The records go through the fabric package's `servedPublisher({ agents })`
(`typescript/src/served.ts`, built 2026-09-23; §3.5, gap 2): signed through
the plugin's client, `agents.publishSigned` with the record id as nonce, on
the edge subject, and counted on the same process-wide counters as the edges
(`countTraceRecordPublished`, `countTraceRecordDropped`), so the heartbeat
reports them. Records are published in the order they were due, so a pair's
`end` never overtakes its `start` (the pre-split `ServedPublisher`'s chain,
kept). The add-on makes one publisher at `started(handles)` from the
plugin's `agents` (a prompt accepted in the moment between the service
starting and `started` gets its id seeded and no pair), and per prompt: `beginTurn(scope, "openclaw")` at
`promptAccepted`, `bind(traceId)` once the id is minted, which publishes
`start` stamped with the arrival, `settle(outcome, atMs)` at `promptEnded`,
which publishes `end`; `flush()` at `stopping`. A bad trace id is refused
by `bind` with a warning and the prompt gets no pair; without a signer the
publisher warns once and every record owed counts as dropped. The
publisher recognizes the missing signer by the error's `name` as well as
its class, since the plugin's client throws its own copy's class (§2.7).

**The proxy's half, and its open flaw.** The derivation from `traceparent`
is on the proxy's `dev` since 2026-09-16. Today any well-formed
`traceparent` files as OpenClaw (`BUGS.txt` 25; the board's M3-31): an
OpenTelemetry-instrumented client or a mesh sends one, and nothing in the
header names OpenClaw. The decided direction is that the virtual key record
names its harness (`key_management.md`, our change) and the proxy derives
the OpenClaw pair only for such a key (B7 of the plan). Until then a stray
`traceparent` gets an OpenClaw thread.

**What the console shows when it works.** The summarizer's child thread
with its call joined through the pair, the outcome and the duration from
`start` to `end`, OpenClaw `full` in the agents view with both halves, its
signed `served` records its NATS half (the examples' `team/README.md`,
"What to look at in the console"). Two prompts' windows can overlap, since
`start` is stamped on arrival and OpenClaw queues; the trace id, not the
window, tells their calls apart.

**What the test repo asserts.** Nothing yet: the test repo runs PI as its
harness and has no OpenClaw scenario. The examples' team run is the check
(§8), recorded as a finding.

### 3.4 Claude Code — the `served` pair on the session, and the piece it waits for

**The join.** Claude Code sends `X-Claude-Code-Session-ID` on every model
request and `X-Claude-Code-Agent-ID` on a subagent's; the proxy files them
as `harness: claude`, `harness_thread_id` the session id, `harness_agent_id`
the agent id (`afo-design.md` §8.1; `proxy/forward.go` `claudeCodeThread`).
The plugin is an MCP server inside the session and cannot touch those
headers, so it publishes the pair naming the session (`fbd16ab`
`agents/claude-code/src/served.ts`). The console makes a subagent's calls
the child of the session's thread (`query-node.md` §5).

**What the add-on does.** Built in `plugins/openclaw`
(`@synadia-ai/agent-fabric-openclaw`, 2026-09-23): `src/extension.ts` the
factory and the events, `src/trace-scope.ts` the seed from `fbd16ab`; its
README says the same in operator terms.

1. `promptAccepted(request)`: read `activeTrace()`; if `request.sessionId`
   is a well-formed session id (`isClaudeSessionId`), publish `served`
   `start` with `harness: "claude"`, `harness_thread_id` the session id,
   `ts` the arrival. The session is bound at arrival, so a `/clear` during a
   turn does not move the binding. The plugin resolves the session id from
   its `SessionStart` file first and from `CLAUDE_CODE_SESSION_ID` in its
   environment second, as `resolveClaudeSessionId` did.
2. `promptEnded(request, outcome, atMs)`: the turn is not over. After the
   `reply` tool completes the request, Claude Code makes at least one more
   model call to write its closing text (`fbd16ab` `src/turn-stop.ts`). So
   the add-on waits for `turnStopped` with a time after `atMs`, at most
   120 s (`STOP_WAIT_MS`), and publishes `end` with the hook's time and the
   outcome. Without hooks, or when no `Stop` comes in time, or on shutdown,
   `end` carries `atMs`. A failed or expired request ends at once.
3. `aroundToolCall(request, …, run)`: bind the request's trace scope. This
   is the one place the MCP shape bites, see below.

**The tool-call ID** comes to the plugin from `PreToolUse` (§2.6) and to the
edge through the helper's prompt context; the add-on has no part in it.

**The one SDK piece that does not exist yet.** The helper's request
interceptor opens the tools scope around the prompt handler
(`runInPromptScope`), and a `prompt_agent` call belongs to that scope only
when it runs inside the handler's async context (§3.3 of the tools
contract). In the MCP process the tool call arrives as a separate MCP
request, outside that context, so the helper sees it as a call *outside a
served prompt* (§3.4): it is not cancelled when the served prompt ends, and
the caller guard does not apply. The add-on can bind the *trace* scope
around the call with `bindActiveTrace`, so the edge is right, but it cannot
enter the *tools* scope: the helper offers no handle to re-enter an open
scope. That is the SDK follow-up parked as (a) in the plan, un-parked by B4:
an explicit scope handle, in both SDKs, that a host opens for a served
prompt and runs later work inside. It is named here as a dependency and not
designed here.

**What the console shows when it works.** The session's calls on the child
thread, the closing call inside the window, the outcome and the duration
from the pair; a subagent's calls as children of the session's thread.
Everything the session does between the two records is filed under the
prompt: local typing during a NATS-driven turn, and a second NATS prompt
answered in the same turn, share the window.

**What the test repo asserts.** Step 8b of its plan, Claude Code at the
leaf: an SDK agent prompts Claude Code, which calls a tool and replies, a
real Anthropic-shaped model through the proxy, `CLAUDE_CONFIG_DIR` and
`HOME` inside the run directory, opt-in and never in CI
(`agent-fabric-tests` `docs/PLAN.md`, row 8b). It waits for an Anthropic key
from Mario and for the add-on.

### 3.5 Gaps, named

| # | Gap | Where | What it must carry | Needed by |
| --- | --- | --- | --- | --- |
| 1 | **An explicit tools scope handle.** `AgentTools` opens a scope only around a handler (`requestInterceptor`, `runInPromptScope`); nothing lets a host run later work inside an open scope | the protocol SDK, both languages (follow-up (a) of the plan) | open a scope for a served prompt with its `caller`; run a function inside it later; close it, cancelling the open calls, when the prompt ends | B4 (Claude Code); B2 if PI's tool runner does not inherit the injected context (gap 3) |
| 2 | **The `served` vocabulary.** Built in the fabric package on 2026-09-23 (Mario's decision of that day: both languages, like the edge record), from the pre-split `fbd16ab` `agents/openclaw/src/served.ts` and `agents/claude-code/src/served.ts`: `buildServedRecord(agent, threadId, rootId, harness, harnessThreadId, phase, status?, ts?)` in the schema's key order, `validHarnessThreadId` (the pre-split `validHarnessId` rule, plus the lone-surrogate refusal `validToolCallId` has), `servedPublisher({ agents, subject?, logger? })` over `agents.publishSigned` with the record id as nonce, one chain so records leave in the order they were due, counted on the trace counters, fail-open, `beginTurn(scope, harness)` → `bind` / `settle`, `flush()`; the Python twin `build_served_record`, `served_publisher` over `Agents.publish_signed(nonce=)`, which the Python client has; `served.json` vendored at `5b13989`; both suites validate a `start` and an `end` against it and `test_served_wire_parity.py` compares the bytes | closed | nothing more; the two add-ons import it | — |
| 3 | **PI's context inheritance.** Measured in B2 on PI 0.85.1 (2026-09-23, by the plugin's session, confirmed on the rig in the examples' F19): the turn, `before_provider_headers`, a tool's `execute` and the following `agent_settled` all run in the async context of the `pi.sendUserMessage()` caller, also when the plugin injects the next queued prompt from the previous turn's settle hook. So the scope the add-on binds at `aroundInject` flows to the tools, `aroundToolCall`'s rebind is a no-op the add-on makes anyway, and PI does not need gap 1 | closed | nothing more | — |
| 4 | **`turn_count_hint` for OpenClaw and Claude Code.** Their calls carry no SDK headers, so nothing counts them; an edge their model spawns says `0` | the contract allows it: a hint, never a claim (`edge.json`) | nothing; stated honestly | none |

## 4. What stays where

| Piece | Public plugin (`synadia-agents`) | Add-on (`agent-fabric-sdk/plugins/<harness>`) | Protocol SDK | Fabric package (`@synadia-ai/agent-fabric`) |
| --- | --- | --- | --- | --- |
| `AgentTools`: definitions, execution, the scope, the guards of §3.8 | offers them; the blocking three by default, the six by configuration | nothing | provides them (`@synadia-ai/agents`, PR #207, #211) | nothing |
| The extension point: variable, config field, loading, events | owns it | is one module of it | its hook types are what the plugin hands over | nothing |
| Claude Code's hooks and session events (`SessionStart`, `Stop`, `PreToolUse`) | owns them, always active, neutral | consumes `sessionStarted` and `turnStopped` | nothing | nothing |
| The tool-call ID in the prompt context | Claude Code's plugin gets it from `PreToolUse`; every plugin passes it to `execute()` | nothing | puts it in `PromptOptions.context` as `toolCallId` | reads it and writes it on the edge |
| Tracing: the `edge` record, the envelope pair, the half-pair `400`, the record counts | nothing | wires `fabricTracing()` into the client and the service | the hooks it runs on (PR #205) | `fabricTracing()`, `traceHeaders()`, `activeTrace()`, `bindActiveTrace()` |
| PI's headers on its model calls | exposes `before_provider_headers` as `providerHeaders` | computes them inside the request's scope | nothing | `traceHeaders()` |
| OpenClaw's `traceparent` seed | exposes the dispatch as `aroundDispatch` | seeds OpenClaw's trace scope with the minted id | nothing | nothing |
| The `served` publisher | nothing | publishes the pair (OpenClaw, Claude Code) through it | `publishSigned` with a nonce | `servedPublisher()`, `buildServedRecord()` and the vocabulary (`served.ts`, its Python twin `served.py`; gap 2, closed) |
| The extension contract's types (`AgentExtension`, `HarnessEvents`, `ServedRequest`, …) | declares them, `agents/*/…/extensions.ts` | imports them | the hook types they name | declares them structurally, `plugin-contract.ts`, TypeScript only (moved from `plugins/pi` 2026-09-23) |
| The `409` loop guard | nothing | returns its request and prompt interceptors | `RequestRejectedError` | `loopGuard()`, `loop-guard.ts`, TypeScript only (moved from `plugins/pi` 2026-09-23), and the scope it reads |
| The `tracing` setting the plugins had (`NATS_TRACING`, `tracing: on`) | **gone**; removed by the split; not reintroduced | the add-on's presence is the switch; its one setting is the edge subject, `options.edgeSubject` or `SYNADIA_FABRIC_EDGE_SUBJECT`, read by the add-on alone | nothing | `resolveEdgeSubject()` gives every add-on the precedence (`plugin-settings.ts`, TypeScript only); validates it |
| `senderIdentity: signed` | the plugin's setting, as today | required for any record; warns once without it | identity | warns once when a record is due |
| ScratchPad references | nothing | nothing for the MVP (level D, Phase III) | the tools' extension hooks | `scratchPadExtension`, for SDK-built agents |
| The proxy's half: the SDK pair, the harness pairs, the `traceparent` flaw | — | — | — | the proxy (`agent-fabric-model-proxy`), M3-31 |

## 5. Packaging and loading

**Decision: one small package per harness**, under `plugins/pi`,
`plugins/openclaw` and `plugins/claude-code`, published as
`@synadia-ai/agent-fabric-pi`, `@synadia-ai/agent-fabric-openclaw` and
`@synadia-ai/agent-fabric-claude-code`. Each depends on
`@synadia-ai/agent-fabric` (which brings the two SDK packages, its regular
dependencies today, `typescript/package.json`) and on nothing of the
harness: the OpenClaw add-on needs only `node:async_hooks` and the symbol
name, the PI add-on returns plain header records, the Claude Code add-on
reads plain events. So no harness type enters any package of ours, and the
fabric package stays free of harness dependencies. Each add-on carries the
one file of the harness piece and a test that drives the factory through
the events of §2.4 with a fake plugin: a queued prompt with lineage gives
the two headers; a dispatched prompt gives a `start`, a seeded scope and an
`end`; a `prompt_agent` inside `aroundToolCall` writes its edge under the
served thread. An integration test with a `nats-server`, in the pattern of
`typescript/test/integration/`, checks the records on the wire against the
vendored schemas.

**Rejected: subpath exports of the fabric package** (`@synadia-ai/agent-fabric/pi`
and so on). One package would carry three harness pieces every SDK-built
agent installs and never uses, its version would bump for a fix in one
harness, and the OpenClaw symbol and the Claude Code session shape would
sit in the package the Python twin mirrors, where they have no twin. Three
packages, each a few hundred lines, cost three `package.json` files and
nothing else.

**TypeScript only.** All three plugins are TypeScript; there is no Python
add-on. Of the plugins' needs the fabric package's Python half carries only
the `served` vocabulary and its publisher, the TypeScript half's twin byte
for byte (gap 2, closed 2026-09-23), as the repo's rule requires of every
wire artefact.

**Installed next to the harness and named in the variable.** An operator
installs the add-on where the harness runs, `npm install
@synadia-ai/agent-fabric-pi` in a directory of their choosing, and names it:
by package name when that directory is the plugin's or an ancestor of it,
by absolute path otherwise (`SYNADIA_PI_EXTENSIONS=/opt/fabric/node_modules/@synadia-ai/agent-fabric-pi`).
The examples' and the test repo's launchers, which build their own homes for
each harness, give the path.

**The development path while the SDK is unpublished.** This repo resolves
the SDK from the checkout of `synadia-agents` on `sdk-release-rollout` next
to it, through `file:` dependencies in `typescript/package.json`, built
caller then host, installed with npm and never bun (`CLAUDE.md`, "The
protocol SDK during development"). Each add-on does the same for
`@synadia-ai/agent-fabric`: `"@synadia-ai/agent-fabric": "file:../../typescript"`,
built first (`npm run build` in `typescript/`), and the SDK links inherited
through it. The lockfiles are not committed while the links point outside
the repo. At the release the three become `^0.x` dependencies with
lockfiles, like the fabric package.

## 6. How to run each harness on the fabric

What every harness needs, whichever it is: the public plugin; the add-on;
the variable or config field naming it; the proxy as the harness's model
endpoint with a virtual key issued through the console for the harness's
own identity; and `senderIdentity: signed` with credentials for that
identity. Without identity, the plugin runs plain with a warning: PI's calls
still file under the caller's thread, since the headers need no signature,
but no `edge` and no `served` record is published, each counts as dropped,
and OpenClaw's and Claude Code's calls stand as harness threads of their
own, unbound.

**PI**, from `agent-fabric-examples` `harnesses/pi/` and the test repo's
`internal/piagent/piagent.go`:

1. PI on `PATH` (0.85.1 here; the plugin's peer range says `<0.85.0`, which
   B2 widens). The public plugin from the `synadia-agents` checkout with
   both SDKs built and `npm install` run in `agents/pi`; when published,
   `pi install npm:@synadia-ai/nats-pi-channel`.
2. The add-on: `npm install @synadia-ai/agent-fabric-pi`, or `plugins/pi`
   of this repo built.
3. `SYNADIA_PI_EXTENSIONS=<path or name>`, or `"extensions": ["…"]` in
   `nats-channel.json`, in place of the `"tracing": "on"` the configurations
   still carry today (`harnesses/pi/config/nats-channel.json`; the test
   repo's launcher sets `NATS_TRACING=on`), which the plain plugin ignores.
4. A NATS context with PI's own credentials in `nats-context.json`,
   `senderIdentity: signed`, `minSenderTrust: signed` recommended.
5. The proxy as PI's provider: `models.json` with `baseUrl` the proxy's
   `/v1` and `apiKey: "$FABRIC_VIRTUAL_KEY"`, the key in the environment and
   in no file (`harnesses/pi/config/models.json`, `run.sh`).
6. Headless: `pi --mode rpc --no-extensions -e <plugin>/extensions/nats-channel.ts …`
   with `PI_CODING_AGENT_DIR` and `HOME` in a directory of its own
   (`run.sh`; `piagent.go`). The connected line names the loaded
   extensions.

**OpenClaw**, from `harnesses/openclaw/`:

1. OpenClaw 2026.8 or later and a Node it accepts (`≥24.16 <25`, or
   `≥26.1`; the examples pin 2026.9.4 with Node 24). The public plugin from
   the checkout, both SDKs built, `npm install` in `agents/openclaw`; the
   config's `plugins.load.paths` names its `index.ts`; when published,
   `openclaw plugins install @synadia-ai/nats-channel`.
2. The add-on: `npm install @synadia-ai/agent-fabric-openclaw`.
3. `SYNADIA_OPENCLAW_EXTENSIONS=<path or name>`, or `"extensions": ["…"]`
   in `channels.nats.accounts.default`, in place of `"tracing": "on"`
   (`harnesses/openclaw/config/openclaw.json`).
4. `senderIdentity: signed` with `credentials` OpenClaw's own.
5. The proxy as the `fabric` provider in `models.providers`, the key from
   the environment (`apiKey: { source: "env", … }`).
6. `openclaw gateway run --port … --bind loopback` with `HOME`,
   `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` in a
   directory of its own (`run.sh`). The `gateway starting` line names the
   loaded extensions.

**Claude Code**, as expected, parked in the examples until an
Anthropic-shaped model stands behind the proxy (the test repo's step 8b;
`harnesses/README.md`, Mario on 2026-09-17):

1. The plugin from the marketplace, `/plugin marketplace add
   synadia-ai/synadia-agents` and `/plugin install
   nats-channel@synadia-plugins`; the session started with
   `claude --dangerously-load-development-channels plugin:nats-channel@synadia-plugins`
   (`agents/claude-code/README.md`, "Quick Setup").
2. The add-on: `npm install @synadia-ai/agent-fabric-claude-code`.
3. `SYNADIA_CLAUDE_CODE_EXTENSIONS=<path>` in the environment Claude Code is
   started in, which its MCP server inherits, or `"extensions": ["…"]` in
   `~/.claude/channels/nats/config.json`.
4. `senderIdentity: signed` through `/nats-channel:configure identity signed`,
   with a NATS context carrying Claude Code's own credentials.
5. The proxy as the model endpoint: Claude Code's `ANTHROPIC_BASE_URL` to
   the proxy and the virtual key as `ANTHROPIC_API_KEY`; the proxy needs an
   Anthropic-shaped provider behind it for these calls.
6. For a headless run, `CLAUDE_CONFIG_DIR` and `HOME` in a run directory,
   never `~/.claude` (the test repo's rule for 8b).

## 7. Stated honestly

- **Structure is self-reported.** The edge is the caller's claim, the pair
  is the plugin's, and the proxy records what the headers say. The console
  verifies signatures, not truth (`afo-design.md` §10).
- **PI's turn boundaries.** The turn spans everything PI does for the prompt
  until it settles, retries and the compaction after an answer included. A
  compaction before the turn is not stamped, and local typing during a
  remote turn files under the remote thread; PI gives the plugin no way to
  tell the two apart (`afo-design.md` §8.3).
- **OpenClaw before 2026.8.** The trace id is not carried through the turn
  queue, so the model calls carry an id of OpenClaw's own and the pair names
  an id no call carries. The scope is an internal of OpenClaw's, keyed by a
  versioned symbol; it will drift, and the add-on feature-checks it and
  falls back to an unseeded dispatch.
- **Claude Code without its hooks** (`disableAllHooks`): no `SessionStart`
  file, so a prompt after `/clear` files under the session the server
  started with; no `Stop`, so `end` carries the reply's time and the closing
  call falls outside the window. `CLAUDE_PID` is documented for hooks; for
  the MCP server the plugin falls back to its parent pid.
- **The add-on's failure is silent to the harness.** Fail-open means a
  record that fails to publish shows only as `records_dropped` on the
  heartbeat and a warning in the plugin's log. A misspelled extension path
  gives the plain plugin with one log line; the status output is where to
  look.
- **Two copies of the SDK.** The add-on runs on its own copy (§2.7). What
  crosses the boundary is copy-safe by construction today; a future SDK
  change that checks a class by `instanceof` alone would break it silently.
- **The `409` guard over-refuses** a sibling prompt of the same tree that
  arrives while the harness waits in it (§3.1).
- **No ScratchPad references in a harness.** Level D, Phase III. A
  reference in a prompt to a harness is removed by the caller's
  `prompt_agent` before sending (`agent-fabric-examples` `tools/README.md`).
- **`traceparent` from any client files as OpenClaw** until M3-31 (§3.3).
- **Nothing here is measured yet.** The pre-split plugins ran end to end
  against Francesco's proxy on 2026-09-16 and PI's leaf ran on the rig
  until 2026-09-21; the shape of §2 has not run anywhere. B2 is where it
  first does.

## 8. The plan to build it

Phase B of `synadia-agent-fabric/local/plan-2026-09-23.md`. Each step is a
fresh session with a paste; each ends with a run that is recorded.

| Step | Public repo (`synadia-agents`, one PR on a branch) | This repo | Examples, tests | Done when |
| --- | --- | --- | --- | --- |
| **B2 PI** | `agents/pi`: `AgentTools` (the blocking three) through `pi.registerTool`, one `Agents` client with the plugin's signer, the extension point of §2 with the PI events, `agents/EXTENSIONS.md` and the README paragraph of §9, the peer range to include 0.85, CHANGELOG; Francesco's `agents/pi/extensions/agent-tools.ts` as reference for the registration and where the active request is | `plugins/pi`: the add-on of §3.2 with its tests; gap 3 measured and written into this doc | examples: `harnesses/pi/config/nats-channel.json` and `run.sh` name the add-on in place of `tracing`; tests: `internal/piagent` sets the variable and the `aft.yaml` sibling for this repo | the examples' team on the rig (`make demo` in `agent-fabric-examples`) shows the editor's calls on its child thread, PI `full`, the `asked` row naming it, recorded as a finding; `gate/m2` `TestPIAtLeaf` green with its two waivers deleted |
| **B3 OpenClaw** | `agents/openclaw`: `AgentTools` registered through the channel plugin's tools (Francesco's `channel.ts` diff as reference), the client, the extension point with the OpenClaw events, `extensions` in `openclaw.plugin.json`, README, CHANGELOG, `dist/` rebuilt with tsup | gap 2 decided and built first; `plugins/openclaw`: the add-on of §3.3 | examples: `harnesses/openclaw/config/openclaw.json`, `run.sh` | the team on the rig shows the summarizer's thread with its call, the pair's outcome and duration, OpenClaw `full` with both halves, recorded as a finding |
| **B4 Claude Code** | first, gap 1 in both SDKs with tests, its own PR; then `agents/claude-code`: `AgentTools` on the MCP tool handlers, `request_id`, the hooks back as neutral session events (`hooks/hooks.json` with `SessionStart`, `Stop`, `PreToolUse`; `hooks/session-event.ts`), the client, the extension point with the Claude Code events, README, CHANGELOG, the bundle rebuilt | `plugins/claude-code`: the add-on of §3.4 | tests: step 8b, opt-in, on a laptop with an Anthropic key | 8b's gate passes: an SDK agent prompts Claude Code, which calls a tool and replies, its calls on the child thread with the pair and the closing call inside the window; the report names the model |
| **B5 the waivers and the team** | — | this doc's §7 updated with what was measured | tests: `scenario.PluginsPending` and the `Untraced` flag on PI's `gate/m3` member removed; `gate/m2` whole on the rig; `gate/m3` on NGS with PI's member unwaived, on Mario's `-apply`; examples: `harnesses/README.md` and `team/README.md` say the harnesses are traced; Claude Code as a sixth role when 8b is done | `aft run` on the rig green but for the known F8; `aft run -target ngs -apply gate/m3` green with nothing waived; the team's run recorded |
| **B7 M3-31** (alongside) | — | — | the fabric's `key_management.md`: the key names its harness; the proxy derives the OpenClaw pair only for such a key (Francesco, or us) | the proxy's scripted case for a stray `traceparent` files no harness pair |

**The rule for every public-repo PR.** Before the push: `git diff
sdk-release-rollout... | grep -iE 'fabric|scratchpad|afo|synadia-agent-fabric'`
returns nothing (PR text and code comments do not matter, files do); no
absolute path of any machine in the diff; when the Claude Code plugin's
TypeScript source changes, `runtime/server.js` is rebuilt with bun 1.3.14
from a `git archive` export of the branch, since the repo's CI rebuilds the
bundle from packed SDK artefacts and fails on any byte difference
(`synadia-agents` `CLAUDE.md`; `agents/claude-code/scripts/lock-install.ts`
names 1.3.14 as the version that builds the committed bundle; this machine
has bun 1.4.0). `bun run verify:bundle` before the commit. Francesco is
informed when Mario says (B6).

## 9. Appendix: the text for the public repo

To be pasted as it is. No fabric word appears below; the check of §8 is
run on it.

### 9.1 `agents/EXTENSIONS.md`

> # Extensions
>
> The Claude Code, OpenClaw and PI plugins can load extension modules. An
> extension adds behaviour around the plugin without changing the plugin or
> the protocol: it can add fields and headers to the prompts the plugin's
> agent tools send, publish signed messages of its own alongside them,
> refuse an incoming prompt with a protocol error, add fields to the
> heartbeat, extend the agent tools through their extension hooks, and
> follow the harness's events. Without an extension the plugin behaves as
> this README describes.
>
> **Naming an extension.** Set `SYNADIA_AGENT_EXTENSIONS` to one or more
> module specifiers separated by commas, or the per-harness variable that
> wins over it (`SYNADIA_PI_EXTENSIONS`, `SYNADIA_OPENCLAW_EXTENSIONS`,
> `SYNADIA_CLAUDE_CODE_EXTENSIONS`), or the `extensions` array in the
> plugin's configuration. A specifier is a package name, resolved from the
> plugin's own directory upward like any import, or an absolute path to a
> package directory or a file. A configuration entry may be an object,
> `{ "module": "…", "options": { … } }`, whose `options` the plugin hands to
> the module unread. Relative paths are refused.
>
> **What a module exports.** One default export: a factory, called once at
> start with the harness's name, the plugin's name and version, its resolved
> settings (owner, name, identity and trust modes, its state directory, its
> configuration as read), the entry's `options` and the plugin's logger. It
> returns the extension, or a promise of it.
>
> **What the plugin takes from the extension.** Prompt interceptors, given
> to the plugin's `Agents` client; request interceptors and a heartbeat
> extras provider, given to the plugin's `AgentService`, the extensions'
> interceptors running before the plugin's own; extensions for `AgentTools`;
> a `started` callback with the live client and service once the plugin is
> on the bus, and a `stopping` callback before it leaves; and handlers for
> the harness's events. These are the SDK's own types
> (`PromptInterceptor` and `AgentToolsExtension` in `@synadia-ai/agents`,
> `RequestInterceptor` and `heartbeatExtras` in `@synadia-ai/agent-service`).
>
> **The harness's events.** Every plugin reports a prompt accepted, called
> synchronously inside the prompt handler after the interceptors ran, and a
> prompt ended with its outcome; every plugin runs each agent-tool call
> inside the extension's `aroundToolCall` wrapper, naming the served prompt
> the model works in. PI also runs the hand-over of a prompt to its loop
> inside `aroundInject`, and asks `providerHeaders` for headers to add to
> the provider request of an active prompt. OpenClaw runs the turn's
> dispatch inside `aroundDispatch`. Claude Code reports `sessionStarted`
> and `turnStopped` from its hooks. A wrapper must call its `run` argument
> once, synchronously, and return its value.
>
> **Failure.** A module that cannot be loaded is logged once and the plugin
> starts without it. An event handler that throws is logged and ignored; a
> wrapper that does not call `run` has it called by the plugin. Interceptors
> keep the SDK's rules: a request interceptor that throws before `next()`
> refuses the request, with the code of a `RequestRejectedError` or `500`;
> a prompt interceptor's first phase that throws fails that prompt.
>
> **Limits.** An extension may not set the protocol's fields or the
> `Agent-Sender` header, may not change the tools offered, and sees nothing
> of the plugin beyond the context, the handles and the events above. It
> runs on its own installed copy of the SDK packages; the plugin's status
> output names the extensions it loaded.

### 9.2 The paragraph for each plugin's README

**PI** (`agents/pi/README.md`, a section "Extensions" after "In-PI commands"):

> ## Extensions
>
> The extension can load extension modules that add behaviour around it:
> interceptors for its client and service, extensions for its agent tools,
> and handlers for PI's events, among them the headers PI sends on its
> provider requests while a NATS prompt is its active turn. Name them in
> `SYNADIA_PI_EXTENSIONS` or `SYNADIA_AGENT_EXTENSIONS`, or as the
> `extensions` array in `nats-channel.json`. `/nats-status` lists the
> modules loaded. The contract is [`../EXTENSIONS.md`](../EXTENSIONS.md).

**OpenClaw** (`agents/openclaw/README.md`, a section "Extensions" after
"Configuration reference"):

> ## Extensions
>
> The plugin can load extension modules that add behaviour around it:
> interceptors for its client and service, extensions for its agent tools,
> and handlers for the gateway's events, among them the dispatch of a turn.
> Name them in `SYNADIA_OPENCLAW_EXTENSIONS` or `SYNADIA_AGENT_EXTENSIONS`,
> or as `extensions` in the account's block under `channels.nats.accounts`.
> The `gateway starting` line lists the modules loaded. The contract is
> [`../EXTENSIONS.md`](../EXTENSIONS.md).

**Claude Code** (`agents/claude-code/README.md`, a section "Extensions"
after "Configuration"):

> ## Extensions
>
> The channel can load extension modules that add behaviour around it:
> interceptors for its client and service, extensions for its agent tools,
> and handlers for the session's events. The plugin's hooks
> (`hooks/hooks.json`) record the session id at `SessionStart`, the turn's
> end at `Stop` and the tool-call id at `PreToolUse` under
> `<state dir>/sessions/`, keyed by the Claude Code process; the server
> reads them to follow `/clear`, to close a turn when Claude Code is done,
> and to pass the model's tool-call id to its agent tools. Name extensions
> in `SYNADIA_CLAUDE_CODE_EXTENSIONS` or `SYNADIA_AGENT_EXTENSIONS`, or as
> the `extensions` array in `config.json`; `request_info` lists the modules
> loaded. The contract is [`../EXTENSIONS.md`](../EXTENSIONS.md).
