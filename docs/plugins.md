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
(`reference-agents/docs/findings.md` F16). Full tracing for these
three harnesses is the fabric's headline promise, so this work is
release-critical.

## 2. The extension point the public plugin exposes

This section is the neutral contract. It is written so that §10 can be pasted
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
waits on a call to another agent, so it refuses an incoming prompt whose
`root_id` names a tree it is waiting in, with `409`. Waiting means: from
the moment the model sends a prompt until every call the served request has
open has settled — completed, failed, cancelled or expired. A blocking
`prompt_agent` holds the mark until it returns; a call started with
`wait: false` holds it for as long as it is open, since the model may
`wait_agent` on it at any moment; with no call open, a prompt of the tree
is admitted. The add-on builds it from what it already has: its own request
interceptor, placed after tracing's, keeps the served request by the scope
tracing bound for the handler's duration; its own prompt interceptor, which
runs in the async context of the `prompt_agent` call and so inside the
served request's scope, marks that request as *waiting*; the guard's
`aroundToolCall`, inside the add-on's, lifts the mark when a tool result
carries no `open_calls` (`AgentTools` counts the scope's open calls on every
result while one is) and no other agent-tool call of the request is still
running. An arriving prompt whose adopted root a served request is
*waiting* in is refused with `RequestRejectedError(409, …)` before
`next()`; every mark goes when its served prompt ends. The mark falls at a
tool result, so a call that fails or expires while the model runs no agent
tool keeps it until the model's next agent-tool result or the end of the
served prompt, whichever comes first; a result the guard cannot read leaves
the mark as it was. Stated honestly: this refuses a legitimate second
prompt of the same tree that arrives while the harness waits in it, a
sibling delegation issued with `wait: false` by the same coordinator. A
harness serves one turn at a time anyway, so that prompt would have
queued; the guard turns the wait into a refusal the caller sees at once.

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

**ScratchPad.** Built for PI (§9.11) and OpenClaw (§9.12), whose add-ons
return `scratchPadExtension` in `toolExtensions` and declare that their
harness reads references; Claude Code's returns none yet. Level B applies to the harnesses too, the model using ScratchPad's
skill and the sp command line through the harness's shell tool, with the
add-on returning `scratchPadExtension`; §9 is the design.

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
(§8), recorded as a finding: the examples' F20 (2026-09-23; since 2026-09-26
in `agent-fabric-live` `docs/findings-examples.md`), the
summarizer's call joined through the pair in the team, and OpenClaw's model
delegating to the researcher when prompted directly, every call of the turn,
tool turns included, under the one seeded id.

### 3.4 Claude Code — the `served` pair on the session, ended at the turn's `Stop`

**The join.** Claude Code sends `X-Claude-Code-Session-ID` on every model
request and `X-Claude-Code-Agent-ID` on a subagent's; the proxy files them
as `harness: claude`, `harness_thread_id` the session id, `harness_agent_id`
the agent id (`afo-design.md` §8.1; `proxy/forward.go` `claudeCodeThread`).
The plugin is an MCP server inside the session and cannot touch those
headers, so it publishes the pair naming the session (`fbd16ab`
`agents/claude-code/src/served.ts`). The console makes a subagent's calls
the child of the session's thread (`query-node.md` §5).

**What the public plugin gives it.** Built in `synadia-agents` #215
(`agents/claude-code`, merged into `sdk-release-rollout` at `85a69c8`,
measured there on Claude Code 2.1.280). The hooks are back as neutral
session events (§2.6): `SessionStart` writes `<state dir>/sessions/<pid>`
(`{session_id, source, at_ms}`), `Stop` writes `<pid>.stop`
(`{session_id, at_ms}`), `PreToolUse` on the agent tools writes
`<pid>.tools/<tool_use_id>`, all keyed by `CLAUDE_PID`; the server polls
the first two every 250 ms (`src/session-events.ts`) and reports a
`SessionStart` already on disk once at start, never an old `Stop`. The
events: `sessionStarted(sessionId, source)`; `promptAccepted(request)` in
the handler, `request.sessionId` set when the session is known;
`promptEnded(request, outcome, atMs)`, `atMs` the arrival of `reply` with
`done` for `ok`, `error` on a handler failure or at shutdown, `timeout` at
the request TTL; `aroundToolCall` for every agent-tool call;
`turnStopped(sessionId | undefined, atMs)`, the current session when the
record names none. `stopping()` is called before the plugin fails the
requests still open.

**What the add-on does.** Built in `plugins/claude-code`
(`@synadia-ai/agent-fabric-claude-code`, 2026-09-23): `src/extension.ts`
the factory and the events; its README says the same in operator terms.

1. `sessionStarted(sessionId)`: remember the session Claude Code is in now.
2. `promptAccepted(request)`: read `activeTrace()`; the session is
   `request.sessionId`, else the remembered one; when it passes the
   session-id rule (`isClaudeSessionId`, declared in the add-on: the
   pre-split rule of `fbd16ab` `src/session-id.ts`, header-safe, which a
   Claude Code UUID passes), `beginTurn(scope, "claude")` and
   `bind(sessionId)`, so `start` goes out stamped with the arrival. The
   session is bound at arrival, so a `/clear` during a turn does not move
   the binding. With no session known, no pair and one log line; the scope
   is still kept for the tool calls.
3. `promptEnded(request, outcome, atMs)`: `error` and `timeout` settle at
   once. For `ok` the turn is not over: after `reply` completes the
   request, Claude Code makes at least one more model call to write its
   closing text (`fbd16ab` `src/turn-stop.ts`). So the turn stays pending
   until a `turnStopped` of its session with a time after `atMs`, and `end`
   carries that time; after `stopWaitMs` (option, 120 s by default) with no
   `Stop`, `end` carries `atMs`.
4. `turnStopped(sessionId, atMs)`: every pending turn of that session
   answered before `atMs` ends at `atMs`, the oldest first. One `Stop` ends
   one Claude Code turn, and every prompt answered before it was answered
   in that turn, so two prompts answered in one turn share its end, and a
   prompt answered after this stop waits for the next.
5. `aroundToolCall(request, …, run)`: bind the request's trace scope.
6. `stopping()`: every pending turn ends at its reply's time, every turn
   still open ends now with `error`; then `flush()`.

**The tool-call ID** comes to the plugin from `PreToolUse` (§2.6) and to the
edge through the helper's prompt context; the add-on has no part in it.

**No SDK piece was needed.** This section named one as missing: in the MCP
process a tool call arrives as a separate MCP request, outside the prompt
handler's async context, so the helper would see it as a call outside a
served prompt, not cancelled when the prompt ends and outside the caller
guard, and the helper offered no handle to re-enter an open tools scope.
The plugin solved it without one. Its prompt handler runs inside every
request interceptor, the tools' scope included, and stays open until the
request completes; it takes `AsyncLocalStorage.snapshot()` there, after the
interceptors ran, and runs every agent-tool call for that request through
the snapshot before `aroundToolCall` and `tools.execute()`
(`agents/claude-code/server.ts`, `src/agent-tools.ts` `runAgentTool`). So
the tools scope, the caller guard and every interceptor's binding apply to
the call as if it ran in the handler, and the add-on's `aroundToolCall` is
a no-op rebind it makes anyway. An explicit scope handle stays a candidate
for the async tools (§3.5, gap 1).

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
(`agent-fabric-tests` `docs/PLAN.md`, row 8b). The add-on is built and
measured against real turns (§6 step 8); 8b wants what that run had: the
two keys and Anthropic as the provider (§6 step 6) and an interactive
session, a pseudo-terminal when scripted (§6 step 7).

### 3.5 Gaps, named

| # | Gap | Where | What it must carry | Needed by |
| --- | --- | --- | --- | --- |
| 1 | **An explicit tools scope handle.** `AgentTools` opens a scope only around a handler (`requestInterceptor`, `runInPromptScope`); nothing lets a host run later work inside an open scope | not needed (B4, 2026-09-23): the plugins re-enter the handler's context through a snapshot taken inside it (§3.4; Claude Code's `runAgentTool`, OpenClaw 2026.5.4's oldest pending request), which carries the tools scope with it; an explicit handle stays a candidate for the async tools | nothing now | — |
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
| The `409` loop guard | nothing | returns its request and prompt interceptors, calls its `aroundToolCall` in its own | `RequestRejectedError` | `loopGuard()`, `loop-guard.ts`, TypeScript only (moved from `plugins/pi` 2026-09-23), and the scope it reads |
| The `tracing` setting the plugins had (`NATS_TRACING`, `tracing: on`) | **gone**; removed by the split; not reintroduced | the add-on's presence is the switch; its one setting is the edge subject, `options.edgeSubject` or `SYNADIA_FABRIC_EDGE_SUBJECT`, read by the add-on alone | nothing | `resolveEdgeSubject()` gives every add-on the precedence (`plugin-settings.ts`, TypeScript only); validates it |
| `senderIdentity: signed` | the plugin's setting, as today | required for any record; warns once without it | identity | warns once when a record is due |
| ScratchPad references | the neutral `metadata` field (#218) | PI (§9.11), OpenClaw (§9.12): the one skill of `plugins/scratchpad-skill`, the registration key, `scratchPadExtension`; Claude Code: designed (§9) | the tools' extension hooks | `scratchPadExtension`, `spCliScratchPad` |
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
through it. The lockfiles are committed, generated by `npm install`, and a
clean clone installs with `npm ci` (they were not until 2026-09-27, so a
clean clone at a pinned commit could not build the images that install
the add-ons). At the release the three become `^0.x` dependencies.

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

**PI**, from `agent-fabric-live` `harnesses/pi/` (the examples' until
2026-09-26) and the test repo's
`internal/piagent/piagent.go`:

1. PI on `PATH` (0.85.1 here; the plugin's peer range is
   `>=0.84.0 <0.86.0`, `agents/pi/package.json` on `sdk-release-rollout`). The public plugin from the `synadia-agents` checkout with
   both SDKs built and `npm install` run in `agents/pi`; when published,
   `pi install npm:@synadia-ai/nats-pi-channel`.
2. The add-on: `npm install @synadia-ai/agent-fabric-pi`, or `plugins/pi`
   of this repo built.
3. `SYNADIA_PI_EXTENSIONS=<path or name>`, or `"extensions": ["…"]` in
   `nats-channel.json`. The add-on's presence is the switch: there is no
   `tracing` setting, and the live repo's `harnesses/pi/config/` carries
   none since their PR #26 (2026-09-23); the test repo's launcher sets the
   variable (`internal/piagent/piagent.go`).
4. A NATS context with PI's own credentials in `nats-context.json`,
   `senderIdentity: signed`, `minSenderTrust: signed` recommended.
5. The proxy as PI's provider: `models.json` with `baseUrl` the proxy's
   `/v1` and `apiKey: "$FABRIC_VIRTUAL_KEY"`, the key in the environment and
   in no file (`harnesses/pi/config/models.json`, `run.sh`).
6. Headless: `pi --mode rpc --no-extensions -e <plugin>/extensions/nats-channel.ts …`
   with `PI_CODING_AGENT_DIR` and `HOME` in a directory of its own
   (`run.sh`; `piagent.go`). The connected line names the loaded
   extensions.
7. ScratchPad (§9), when PI's model is to use it: `--skill
   <add-on>/skill/scratchpad`, and the bash tool on in place of
   `--no-builtin-tools`: `--tools bash,discover_agents,prompt_agent,answer_agent`.
   A volume reserved for PI's identity, named in the extension entry's
   `options.scratchpad.volume` or `SCRATCHPAD_VOLUME`; the connection comes
   from the plugin's NATS context, the workspace defaults to
   `~/.pi/agent/scratchpad` (`plugins/pi/README.md`, "ScratchPad"). The
   add-on's line `ScratchPad volume …, workspace …` confirms it at start.
   Measured end to end on 2026-09-27 (§9.11).

**OpenClaw**, from `agent-fabric-live` `harnesses/openclaw/`:

1. OpenClaw 2026.8 or later and a Node it accepts (`≥24.16 <25`, or
   `≥26.1`; the examples pin 2026.9.4 with Node 24). The public plugin from
   the checkout, both SDKs built, `npm install` in `agents/openclaw`; the
   config's `plugins.load.paths` names its `index.ts`; when published,
   `openclaw plugins install @synadia-ai/nats-channel`.
2. The add-on: `npm install @synadia-ai/agent-fabric-openclaw`.
3. `SYNADIA_OPENCLAW_EXTENSIONS=<path or name>`, or `"extensions": ["…"]`
   in `channels.nats.accounts.default`. The add-on's presence is the
   switch: there is no `tracing` setting, and the live repo's
   `harnesses/openclaw/config/` carries none since the examples' PR #27
   (2026-09-23).
4. `senderIdentity: signed` with `credentials` OpenClaw's own.
5. The proxy as the `fabric` provider in `models.providers`, the key from
   the environment (`apiKey: { source: "env", … }`).
6. The tool policy lets the plugin's agent tools through: `tools.allow`
   naming `discover_agents`, `prompt_agent` and `answer_agent` (the plugin
   registers them optional, so by name), no `tools.profile` (a profile is a
   layer before `allow`; `minimal` leaves nothing for it), no `deny` that
   matches them (deny wins), and no `compat.supportsTools: false` on the
   model. Measured on OpenClaw 2026.9.4 in the examples' F20 (2026-09-23).
7. `openclaw gateway run --port … --bind loopback` with `HOME`,
   `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH` in a
   directory of its own (`run.sh`). The `gateway starting` line names the
   loaded extensions.
8. ScratchPad (§9), when OpenClaw's model is to use it: `npm run build:sp`
   in the add-on, then three entries in `openclaw.json`:
   `skills.load.extraDirs: ["<add-on>/skill"]`; `"scratchpad"` in the
   agent's skill allowlist where it has one (`agents.defaults.skills`, an
   empty one hides every skill); `exec` and `read` in `tools.allow` beside
   the agent tools. And a volume reserved for OpenClaw's identity, in the
   account's extension entry (`"options": { "scratchpad": { "volume": "…" } }`)
   or `SCRATCHPAD_VOLUME`; the connection is the account's `url` and
   `credentials`, the workspace `$OPENCLAW_STATE_DIR/scratchpad`
   (`plugins/openclaw/README.md`, "ScratchPad"). The add-on's line
   `ScratchPad volume …, workspace …` confirms it at start. Measured end to
   end on 2026-09-27 (§9.12).

**Claude Code**, from `agent-fabric-live` `harnesses/claude-code/` (the
examples' until 2026-09-26), measured on Claude Code 2.1.281 in the examples'
F24 and F25 (2026-09-24; since 2026-09-26 in `agent-fabric-live`
`docs/findings-examples.md`):

1. `claude` and `bun` on `PATH` (the plugin's server and hooks run on bun).
   The plugin from the checkout, `claude --plugin-dir
   <synadia-agents>/agents/claude-code`, which loads it for the session as
   `nats-channel@inline` with its `hooks/hooks.json` (three hooks
   registered); its bundle is committed, nothing is built. The channel
   flag names it so: `--dangerously-load-development-channels
   plugin:nats-channel@inline`. When published, the marketplace path of the
   plugin's README.
2. The add-on: `npm install @synadia-ai/agent-fabric-claude-code`, or
   `plugins/claude-code` of this repo built.
3. `SYNADIA_CLAUDE_CODE_EXTENSIONS=<absolute path>` in the environment
   `claude` starts in, which its MCP server inherits (`nats channel:
   connecting {… "extensions":["agent-fabric"]}`), or `"extensions": ["…"]`
   in the channel's `config.json`. Export `PWD` too: the plugin's
   `.mcp.json` hands `${PWD}` to its server.
4. The channel's `config.json` in `NATS_STATE_DIR`: `context` a NATS
   context with Claude Code's own credentials, `owner`, `sessionName`,
   `senderIdentity: signed`, `minSenderTrust: signed`, `agentTools:
   blocking`.
5. `settings.json` in `CLAUDE_CONFIG_DIR`: `permissions.allow:
   ["mcp__plugin_nats-channel_nats"]`, the plugin's server
   (`plugin:nats-channel:nats`), so its tools run without an approval
   nobody sees.
6. The proxy as the model endpoint, with two keys. `ANTHROPIC_API_KEY`
   is an Anthropic API key of the user's own, sent as `x-api-key`: the
   channel is behind a feature flag Claude Code fetches from Anthropic
   directly, never through the base URL, and only with an Anthropic
   credential (F24 item 4). `ANTHROPIC_AUTH_TOKEN` is the virtual key,
   sent as `Authorization: Bearer` next to it; Claude Code warns that both
   are set, and sends both (F24 item 5). The proxy reads the virtual key
   from `Authorization` first and deletes both headers before it sets the
   provider's own, so the Anthropic key reaches no provider (F24 item 2;
   `proxy/forward.go`). `ANTHROPIC_BASE_URL` is the proxy's bare origin, no
   `/api` (F25 item 3). The model is Anthropic's, through the proxy (Mario,
   2026-09-24): Claude Code is Anthropic's product, its documented gateway
   shape is a proxy in front of Anthropic, and an Anthropic key means
   Anthropic bills its owner. So the virtual key names Anthropic as its
   provider, the proxy's built-in `anthropic` in production and on the
   rig `anthropic-api` (`https://api.anthropic.com,anthropic` in the test
   repo's `local/aft.local.yaml`, since `anthropic` is the stand-in's name
   there), with the tenant's Anthropic key as the provider key in the
   record and the harness `claude` (F25 items 1 and 2). No model
   variables: Claude Code runs its own default models, every call through
   the proxy, recorded with Anthropic's usage, cache reads and writes
   included (F25 item 5). The fabric never routes Claude Code to another
   model provider; F24's OpenRouter model was a stand-in for that
   measurement.
7. `HOME`, `CLAUDE_CONFIG_DIR` and `NATS_STATE_DIR` in a home of the
   instance's own, never `~/.claude`, and outside any git repository: from
   inside one, Claude Code sends that repository's `CLAUDE.md` files and
   its git status to the model with every call (F24 item 10); outside one
   it offers the skills of every directory above its working directory,
   the user's own included, which `--disable-slash-commands` removes (F25
   item 7), and with them the Skill tool, so not with ScratchPad (§9.13).
   The examples' `run.sh` keeps the home under the user's state
   directory and refuses one inside a git working tree. And a terminal:
   `claude -p` registers on the bus and serves no prompt (F24 item 7);
   interactive, the development-channels warning answered once, the
   channel is on; scripted, `tmux` with one Enter does it (F24 items 8
   and 11).
8. **Measured.** A signed caller prompted Claude Code, and the reply sat
   on the caller's thread, `harness: claude`, depth `full` with both
   halves, the session's calls joined through the pair (F24 item 8, F25
   item 4). Asked to delegate, Claude Code's model discovered and prompted
   the researcher, whose thread sits under its `prompt_agent` tool call
   with Claude Code its verified caller (F24 item 9, F25 item 4). One call
   falls outside the pair: Claude Code's prompt-suggestion call at the end
   of a turn, re-run once after the turn's `Stop` when its model reached
   for a tool, stands as a root of its own on the session id with no
   caller (F25 item 6); the pair is the turn, and the reader infers
   nothing beyond it.
9. ScratchPad (§9), when Claude Code's model is to use it: `npm run
   build:sp` in the add-on, then the add-on loaded as a plugin too, a
   second `--plugin-dir <add-on>`; `Skill(agent-fabric:scratchpad)` beside
   the plugin's tools in `permissions.allow`; `permissions: { "mode":
   "query" }` in the channel's `config.json`, so any question reaches the
   caller; and a volume reserved for Claude Code's identity, in the
   extension entry (`"options": { "scratchpad": { "volume": "…" } }`) or
   `SCRATCHPAD_VOLUME`. The connection comes from the channel's NATS
   context, the workspace defaults to `$NATS_STATE_DIR/scratchpad`; keep
   it across restarts (`plugins/claude-code/README.md`, "ScratchPad"). The
   add-on's line `ScratchPad volume …, workspace …, for the skill's
   scripts/sp through …` confirms it at start. Measured end to end on
   2026-09-27 (§9.13).

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
- **Claude Code carries an Anthropic credential** (2.1.281, §6 step 6):
  its channel is behind a flag only an Anthropic credential fetches, so
  every Claude Code on the fabric has an Anthropic API key on its machine
  and is traced because it is pointed at the proxy, by configuration.
  Sending both keys is what Claude Code's start-up warning calls
  unsupported; it works on 2.1.281 (F24 item 5) and is to be re-checked on
  releases that touch channels or gateways. The add-on is now measured
  against real turns (§6 step 8), in an interactive session only, and the
  call Claude Code makes after the turn's `Stop` falls outside the pair
  (F25 item 6).
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
  arrives while the harness waits in it, and keeps refusing after a call
  settles unseen until the model's next agent-tool result or the prompt's
  end (§3.1).
- **ScratchPad references reach PI and OpenClaw only.** A reference in a
  prompt to Claude Code is removed by the caller's `prompt_agent` before
  sending (`reference-agents/README.md`, "The agent tools"), until its
  add-on registers that it reads them; PI's and OpenClaw's do (§9.11,
  §9.12).
- **`traceparent` from any client files as OpenClaw** until M3-31 (§3.3).
- **What is measured, and where.** Every add-on, against real turns on
  the test rig: PI in the examples' F19 and OpenClaw in F20 (2026-09-23),
  Claude Code in F24 and F25 (2026-09-24). PI and OpenClaw also in the test
  system's gates, `gate/m2` on the rig and `gate/m3` on the cloud; Claude
  Code's step 8b is still to come (§3.4).

## 8. The plan to build it

Phase B of `synadia-agent-fabric/local/plan-2026-09-23.md`. Each step is a
fresh session with a paste; each ends with a run that is recorded.

| Step | Public repo (`synadia-agents`, one PR on a branch) | This repo | Examples, tests | Done when |
| --- | --- | --- | --- | --- |
| **B2 PI** | `agents/pi`: `AgentTools` (the blocking three) through `pi.registerTool`, one `Agents` client with the plugin's signer, the extension point of §2 with the PI events, `agents/EXTENSIONS.md` and the README paragraph of §10, the peer range to include 0.85, CHANGELOG; Francesco's `agents/pi/extensions/agent-tools.ts` as reference for the registration and where the active request is | `plugins/pi`: the add-on of §3.2 with its tests; gap 3 measured and written into this doc | examples: `harnesses/pi/config/nats-channel.json` and `run.sh` name the add-on in place of `tracing`; tests: `internal/piagent` sets the variable and the `aft.yaml` sibling for this repo | the examples' team on the rig (`make demo` in the examples repository) shows the editor's calls on its child thread, PI `full`, the `asked` row naming it, recorded as a finding; `gate/m2` `TestPIAtLeaf` green with its two waivers deleted |
| **B3 OpenClaw** | `agents/openclaw`: `AgentTools` registered through the channel plugin's tools (Francesco's `channel.ts` diff as reference), the client, the extension point with the OpenClaw events, `extensions` in `openclaw.plugin.json`, README, CHANGELOG, `dist/` rebuilt with tsup | gap 2 decided and built first; `plugins/openclaw`: the add-on of §3.3 | examples: `harnesses/openclaw/config/openclaw.json`, `run.sh` | the team on the rig shows the summarizer's thread with its call, the pair's outcome and duration, OpenClaw `full` with both halves, recorded as a finding |
| **B4 Claude Code** | `agents/claude-code` (#215): `AgentTools` on the MCP tool handlers, `request_id`, the hooks back as neutral session events (`hooks/hooks.json` with `SessionStart`, `Stop`, `PreToolUse`; `hooks/session-event.ts`), the client, the extension point with the Claude Code events, README, CHANGELOG, the bundle rebuilt; no SDK change, since gap 1 was not needed (the snapshot re-entry, §3.5) | `plugins/claude-code`: the add-on of §3.4 (#8) | examples: `harnesses/claude-code/`, the live run parked on F21 (2026-09-23) and done on 2026-09-24 (F24, F25); tests: step 8b, opt-in, with the two keys, Anthropic as the provider and a pseudo-terminal, an Anthropic key on the runner (§3.4, §6) | 8b's gate passes: an SDK agent prompts Claude Code, which calls a tool and replies, its calls on the child thread with the pair and the closing call inside the window; the report names the model |
| **B5 the waivers and the team** | — | this doc's §7 updated with what was measured | tests: `scenario.PluginsPending` and the `Untraced` flag on PI's `gate/m3` member removed; `gate/m2` whole on the rig; `gate/m3` on NGS with PI's member unwaived, on Mario's `-apply`; examples: `harnesses/README.md` and `team/README.md` say the harnesses are traced; Claude Code as a sixth role when 8b is done, with the same two keys, Anthropic as its provider and a pseudo-terminal (§6) | `aft run` on the rig green but for the known F8; `aft run -target ngs -apply gate/m3` green with nothing waived; the team's run recorded |
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

## 9. ScratchPad in the harnesses

The design and measured harness workflows follow. The current binary and
skill pin is `plugins/scratchpad-skill/release.json` (§9.8). Sections 9.11–9.15
record earlier runs; §9.16 defines the upload-quota recovery update.

Level B of ScratchPad applies to every agent on the fabric, the three
harnesses included: the model publishes, reads and hands on content itself.
In a harness it does so through ScratchPad's skill and the sp command line,
which the model runs through the harness's own shell tool. This section is
the design, the answers it rests on per harness, what it costs, and what
the operator has to do. It replaces the "not in a harness" of §3.1 and §7
for level B.

**Nothing here restricts the harness's shell.** The harness keeps its
tools as the operator configured them; the skill needs only that the
shell tool is on. Where a harness asks for permission, the question goes
to the caller over the protocol (a `query`, protocol spec §7), not to a
terminal (§9.5).

Every answer carries how it is known: **measured** (something was run on
this machine) or **read** (docs or code, with the place). The versions read
and run: PI 0.85.1, OpenClaw 2026.9.4, Claude Code 2.1.282 (the test
install) and 2.1.283 (the `claude` on `PATH`), the public plugins at
`synadia-agents` `sdk-release-rollout` `e8355c3` (`3b9a20d` for Claude
Code's run, §9.13), the sp command line at ScratchPad `79f8927`. Harness paths are relative to the harness's installed
package.

### 9.1 The design

Each add-on package carries one skill directory:

```
skill/scratchpad/
  SKILL.md             ScratchPad's skill, adapted (below)
  scripts/sp           the wrapper the model runs; POSIX sh
  bin/sp-darwin-arm64  the sp command line at a pinned commit (§9.8);
  bin/sp-darwin-amd64    or these four come from per-platform packages
  bin/sp-linux-arm64
  bin/sp-linux-amd64
```

**The wrapper, `scripts/sp`.** It picks the binary from `uname -s` and
`uname -m`, adds the connection, and replaces itself with the binary, so
exit codes 0–3 and the JSON on stdout and stderr pass through unchanged:

- `--url "$SP_NATS_URL" --creds "$SP_NATS_CREDS" --dir "$SCRATCHPAD_DIR"`
  on every call (the connection under names of its own, since a plugin may
  read `NATS_URL` and `NATS_CREDS` as its own; OpenClaw's does, §9.12);
- `--volume "$SCRATCHPAD_VOLUME"` on `init` only;
- `--thread-id "$SP_THREAD_ID" --root-id "$SP_ROOT_ID"` when both are set
  (§9.7);
- `--creator "$SP_CREATOR"`, the agent's prompt address, on `publish-file`;
- `--grantee-account "$SP_CALLER_ACCOUNT" --grantee-user "$SP_CALLER_USER"`
  on `grant`: the verified caller of the prompt being served; and the same
  grant after a successful `publish-file` while such a prompt is served,
  as an SDK-built agent grants the caller its reply (§9.12); each such
  grant sp confirms is recorded in `SP_GRANTS_FILE` (§9.14);
- it refuses, with exit 2 and sp's own error shape, a call that passes any
  of those flags itself, and a `grant` when no served prompt has a verified
  caller.

The rules come from the command line itself:

| Rule | Why | How known |
| --- | --- | --- |
| The wrapper turns variables into flags | sp reads no environment at all: every value is a flag (`internal/volumecli/cli.go:150-158`), and there is no `Getenv` or `LookupEnv` in `cmd/sp` or `internal/volumecli` | read, at `79f8927` and `a28bb49` |
| `--volume` on `init` only | `read` and `hydrate` refuse a `--volume` other than the reference's (`internal/volumecli/share.go:21`), and a harness reads other agents' references; the workspace commands check it only when it is given (`workspace.go:53`); `init` requires it (`workspace.go:101`) | read |
| `--dir` on every call | `read` accepts it: `sp read --url … --creds … --ref … --dir ws --volume V` parsed and failed on the token, not the flags | measured |
| The model's own connection flags are refused | Go's flag package keeps the last value of a repeated flag, so a model could otherwise point sp elsewhere; the connection stays out of the model's hands | read (Go `flag`) |
| Variables, not a command prefix | the command the model runs, and any permission question about it, stays `scripts/sp <command> …`; Claude Code's allow rules, should an operator write one, do not match past a `VAR=… cmd` prefix unless the variable is on its known-safe list (permissions docs, "Wrappers") | read |
| `grant` goes to the served prompt's caller only | the fabric's grants are first-hand: an agent grants read on its own content to the agent it hands the reference to. A reply goes to the caller, and no hook of the contract sees the reply, so the add-on cannot make that grant itself (an SDK-built agent's `grantCaller`); the model makes it, and the wrapper fixes the grantee. A reference handed to anyone else goes through `prompt_agent` and the agent tools' ScratchPad extension (`typescript/src/scratchpad-extension.ts`). The wrapper records each such grant sp confirms, so a grant request from the caller is answered from it (§9.14) | design choice, revised when PI was built (2026-09-27): the design first refused `grant`; recorded for grant requests since 2026-09-28 |

**The skill.** ScratchPad's skill, with three changes: every example runs
`scripts/sp` and passes no `--url`, `--creds`, `--dir` or `--volume`; the
"publish and share" part ends at the reference, which the model hands on
in `prompt_agent` (or in its reply) and the agent tools grant; and no
`allowed-tools`. ScratchPad's skill has `allowed-tools: Bash(sp *)`, which
in Claude Code would pre-approve the calls; without it every call follows
the operator's rules, allowed by them or asked of the caller. Claude
Code's copy carries one after all, matching `scripts/sp` by its absolute
path: it restricts nothing, and lets `scripts/sp` run without a question
(§9.13). And the skill asks for each `scripts/sp` command on its own, since
a harness that allows it by its path asks for a command that wraps it
(§9.13).

**The variables.** The names are the package's existing contract for
`scratchPadFromEnv` (`typescript/src/scratchpad-cli.ts`, `SCRATCHPAD_VOLUME`,
`SCRATCHPAD_DIR`, with `NATS_URL` and `NATS_CREDS`). The add-on resolves
them once at start: from its config entry's `options`, else from the same
variables, else, for the connection, from the plugin's own NATS context.
The plugins connect through a context (`"context": "…"` in their config,
which the add-on reads in `settings.config`), and sp reads no context, so
the add-on reads the context file for its URL and credentials path. The
connection must be the plugin's own: a caller grants read to the principal
it prompted, which is the identity the plugin registered with.
`SCRATCHPAD_DIR` defaults to `<stateDir>/scratchpad`, which the add-on
creates, since sp requires the directory to exist. `SCRATCHPAD_VOLUME` has
no default: the operator reserves a volume for the harness's identity,
as for any SDK-built agent.

**The references.** The add-on returns `scratchPadExtension` in
`toolExtensions`, on `spCliScratchPad` over the same binary and the same
workspace directory, so references the model hands to another agent are
granted, removed or refused by the rules every SDK-built agent follows.
Two build notes. The extension needs the plugin's `Agents` client, which
arrives in `started()`, after the factory has returned its
`toolExtensions`; the add-on returns a thin extension that forwards to the
real one once `started()` built it. And the model's sp calls and the
extension share one workspace, not copies of it (the skill forbids
copies). sp locks the workspace per command (`internal/volumecli/README.md`,
"Workspace files"), so this is safe, but a mutation the model left pending
makes the extension's next grant fail with `pending` until someone runs
`recover`. The reference is then removed from the prompt and the result
says so.

**What the public plugin must add, for all three.** One neutral field on
the extension contract, `metadata`: string keys the plugin merges into its
`AgentService`'s `extraMetadata`, its own keys winning. Without it no
harness can say that it reads references (§9.6). Nothing in the field
names ScratchPad.

### 9.2 Registration: making the harness load the skill

Can the extension module make the harness load a skill directory at
runtime? What is the smallest step otherwise?

| Harness | Answer | Source | How known |
| --- | --- | --- | --- |
| PI | **Not from our module.** An extension can add skills at runtime by answering `resources_discover` with `{ skillPaths }`, but our module is handed only its context, never PI's extension API, and the public plugin does not forward that event. PI loads skills from `~/.pi/agent/skills/`, `~/.agents/skills/`, a trusted project's `.pi/skills/`, a package's `pi.skills`, the `skills` setting, and `--skill <path>`. A package's `pi.skills` loads only when the package directory is given to `-e`, not a file in it, and the demo gives a file. **Smallest step:** one flag, `--skill <add-on>/skill/scratchpad`, which also loads under `--no-skills`, or the same path in the `skills` setting | `docs/skills.md` "Locations"; `docs/extensions.md` "resources_discover"; `dist/core/resource-loader.js:230-246, 277, 312-332`; the plugin's `extensions/extensions.ts:66-75`, `nats-channel.ts:828-970` | read; the directory-versus-file rule measured through PI's `DefaultResourceLoader` with a fake package |
| OpenClaw | **Not through an API.** The plugin API has no skill registration, and our module gets no API. A plugin manifest may list `skills`, but a path whose real path leaves the plugin root is refused, and a ScratchPad skill in the public plugin would break the one-way rule anyway. Our module could copy the directory into `<stateDir>/skills` (the managed directory, which is watched). That was rejected: it writes into the harness's home unasked and outlives the add-on. **Smallest step:** one config entry, `skills.load.extraDirs: ["<add-on>/skill"]`. Where an agent has a skill allowlist, the skill must also be named there: the demo sets `agents.defaults.skills: []`, which hides every skill | `docs/tools/skills.md` (locations, 39-48; plugin skills, 242-258; gating, 206-233, 461-520; watching, 703-745); `dist/plugin-skills-*.mjs:180-212`; the plugin's `src/extensions.ts:61-86` | read |
| Claude Code | **Not from our module.** The MCP server cannot register a skill. The documented runtime route is a `SessionStart` hook that writes into a skills directory and returns `reloadSkills: true`, and hooks belong to a plugin. The public plugin could carry the skill in its `skills/`, but that would break the one-way rule. **Smallest step:** the add-on package is also a Claude Code plugin in its own right (`.claude-plugin/plugin.json`, `skills/scratchpad/`), loaded with a second `--plugin-dir <add-on>` or with `CLAUDE_CODE_PLUGIN_DIRS` (2.1.280 and later). Its paths stay inside its own root, as Claude Code requires. The skill's name is then `<plugin>:scratchpad` | skills docs, "Choose where skills load"; hooks docs, "SessionStart decision control"; plugins reference, "Path rules / Containment"; env-vars docs, `CLAUDE_CODE_PLUGIN_DIRS` | read; **built and measured** (§9.13): the skill loads as `agent-fabric:scratchpad` |

### 9.3 Paths: how the model finds `scripts/sp`

| Harness | Answer | Source | How known |
| --- | --- | --- | --- |
| PI | The system prompt lists each skill with `<location>`, the absolute path of its `SKILL.md`, and says: "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands." There is no variable. The list appears only when the `read` or the `bash` tool is active; the demo's `--no-builtin-tools` turns both off | `dist/core/skills.js:275-297`; `dist/core/system-prompt.js:13-14, 30, 111` | read; the rendering measured |
| OpenClaw | The same shape: `<location>` is the absolute `SKILL.md` path (with `~/` shortened), and the line before the list tells the model to resolve relative paths against the skill directory. `{baseDir}` in a skill is left to the model, since no code substitutes it. The skills section appears only when the `read` tool is visible | `dist/skill-contract-*.mjs:38-58`; `dist/system-prompt-params-*.mjs:260, 726`; `docs/tools/creating-skills.md:134-140` | read |
| Claude Code | `${CLAUDE_SKILL_DIR}` is substituted in the skill's text and in the Bash rules of its `allowed-tools`. For a plugin skill, it is the skill's directory inside the plugin. The loaded skill also starts with "Base directory for this skill: …". The Skill tool delivers the text, so the `Read` tool may stay denied | skills docs, "Available string substitutions" | read; the "Base directory" line measured in the binary |

### 9.4 Environment: what the shell tool inherits

The four variables are static per agent. Setting them once at start is
enough.

| Harness | Answer | Source | How known |
| --- | --- | --- | --- |
| PI | **Yes.** The bash tool builds the child's environment on every call from `process.env` (plus PI's `PI_*` keys and its bin dir on `PATH`). There is no scrubbing and no spawn hook on the built-in tool. A variable our module sets at load reaches `scripts/sp`, and so does a later change | `dist/utils/shell.js:115-125`; `dist/core/tools/bash.js:50-53, 119-140`; `dist/core/agent-session.js:2191-2193` | **measured**: PI's bash tool run from a script with a variable set at load and changed later |
| OpenClaw | **Yes, on the gateway host.** The exec child's environment is built per call from `process.env`, passed through a blocklist filter, plus `OPENCLAW_SHELL=exec`. The sandbox is off by default, so exec runs on the gateway. In a sandbox, `process.env` would not pass | `dist/bash-tools-*.mjs:2996, 3029-3052`; `docs/tools/exec.md:46, 73, 82` | read; the filter measured: it keeps `SCRATCHPAD_*` and `NATS_URL` (`NATS_CREDS` was not tried by name; the filter is a blocklist) and drops `NODE_OPTIONS` ; **measured** end to end on 2026-09-27: the served prompt's pair reached `scripts/sp` through exec (§9.12) |
| Claude Code | **Not from our module.** It runs in the MCP server, a child of Claude Code and a sibling of the Bash tool's processes, so its `process.env` reaches neither. The Bash tool inherits Claude Code's launch environment and the settings' `env`. A `SessionStart` hook can append exports to `CLAUDE_ENV_FILE`, and they persist for later Bash commands. `CLAUDE_PLUGIN_ROOT` is not in the Bash tool's environment. So the operator sets the four variables in the launch environment or in `settings.json` `env`, or the add-on's own plugin ships a `SessionStart` hook that resolves them the way the module does (§9.1) and writes them to `CLAUDE_ENV_FILE` | env-vars docs (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`); settings reference, `env`; hooks docs, "Persist environment variables"; plugins reference, "Where each variable resolves" | read (the sibling processes: OS semantics); **built** (§9.13): the module writes the variables to a file, and the add-on's `SessionStart` hook names it in `CLAUDE_ENV_FILE`; measured on 2.1.283 |

### 9.5 The shell tool and permission questions

The skill needs the harness's shell tool on, and in PI and OpenClaw the
skills list needs it (or `read`) to appear at all (§9.3). Beyond that the
harness's tools stay as the operator configured them. What matters is
whether the harness asks for permission, and where the question goes: to
the caller, as a protocol `query` on the served prompt's stream, which
reaches the caller's model as the result of its `prompt_agent` and is
answered with `answer_agent` (`agents/pi/README.md:175`,
`agents/openclaw/README.md:229`), or to no one.

| Harness | The shell tool | Does the harness ask? | Does the plugin relay it? | How known |
| --- | --- | --- | --- | --- |
| PI | `bash`, a built-in, on by default; the demo runs `--no-builtin-tools`, so the operator turns it on (`--tools` naming `bash`, or no `--no-builtin-tools`) | **Never.** "No permission popups": PI has no permission system, and its tools run with the permissions of the user who started it; a confirmation flow is left to extensions (`README.md:503`, `docs/usage.md:309`, `docs/security.md:33`, `docs/extensions.md` "Permission gates") | **Nothing to relay.** The plugin emits no `query`: "PI doesn't initiate permission prompts or clarifications over this channel" (`agents/pi/README.md:308`); no ask or permission code in `agents/pi/extensions/` | read |
| OpenClaw | `exec` (and `read`, for the skills list), named in `tools.allow`; the demo allows only the three agent tools | **Only when configured to.** Gateway exec defaults to `tools.exec.mode: "full"`, no prompts; `ask` and `auto` ask a human on an allowlist miss. A prompt that finds no approval surface, or times out, resolves by `askFallback`, default `deny` (`docs/tools/exec.md:107` and "Modes"; `docs/tools/exec-approvals.md:240-245`) | **No.** The plugin has no approval handling and emits no `query` (no ask, permission or approval code in `agents/openclaw/src/`). OpenClaw can forward approval prompts to a plugin channel as ordinary outbound text, answered with `/approve <id>` (`docs/tools/exec-approvals-advanced.md:232-262, 306-314`); whether that reaches a NATS caller mid-turn was not measured, and it would be text, not a protocol question | read |
| Claude Code | `Bash`, on by default; the demo denies `Bash` and `Skill` outright, which removes both from the model's context, so the operator takes them out of `deny` | **Yes**, for any tool call no rule allows, in the default permission mode (permissions docs, "Manage permissions") | **Yes, in query mode.** With `permissions: { "mode": "query" }` in the plugin's config (`/nats-channel:configure permissions query`), the plugin takes Claude Code's `permission_request` notification (it declares `claude/channel/permission`, `server.ts:469`) and asks the caller of the last active served prompt with a `query`: the tool, its description, the input preview and "Reply 'yes' to allow or 'no' to deny." An answer of `yes`/`allow` or `no`/`deny` (or JSON with `behavior`) decides; no answer in 2 minutes, or no active served prompt, denies (`server.ts:75, 235-245, 593-634`; `agents/claude-code/README.md` "Permissions"). In the default `terminal` mode the dialog waits in the terminal, and the demo sets no mode, so a session with no human waits | read; **measured** (§9.13): four questions reached the caller as `query` and its `yes` let each call run |

So in PI, and in OpenClaw's default mode, the model runs `scripts/sp`
without a question. In Claude Code every `scripts/sp` call becomes a
question to the caller unless the operator allows it by a rule, which is
the operator's choice.

### 9.6 References: declaring `reads_scratchpad_references: true`

A caller's `prompt_agent` keeps references only for an agent whose
registration carries `scratchpad_refs_ok: "true"`, which discovery shows as
`reads_scratchpad_references` (`typescript/src/scratchpad.ts:43, 142-144`,
`scratchpad-extension.ts:138-141`). That key is registration metadata,
`$SRV.INFO`, fixed when the service starts (`agent-sdk/typescript/src/service.ts:676-690`),
so the heartbeat, which the add-on can extend, does not carry it.

| Harness | Answer | Source | How known |
| --- | --- | --- | --- |
| PI | **Not possible today.** The plugin passes `extraMetadata: { cwd }`, hard-coded, and the contract has no metadata field | `extensions/nats-channel.ts:771-773`; `extensions/extensions.ts:128-145` | read |
| OpenClaw | **Not possible today.** `extraMetadata` is `{ platform, description }`, hard-coded. The account config schema has no metadata field, and unknown keys reach `settings.config` but no metadata | `src/gateway.ts:289-292`; `src/extensions.ts:150-166`; `openclaw.plugin.json` | read |
| Claude Code | **Not possible today.** The service is built with no `extraMetadata`, and the contract has no metadata field | `server.ts:494-512`; `src/extensions.ts:163-179` | read |

**For all three: the public plugin's `metadata` field of §9.1.** The add-on
sets the key only when ScratchPad is configured (`SCRATCHPAD_VOLUME` set).
Until the field exists, a harness can publish and hand on its own
references, but references handed to it are taken out by the caller.
The field exists since synadia-agents #218 (2026-09-27, `2c6eb76` on
`sdk-release-rollout`), and PI's add-on sets the key (§9.11).

### 9.7 Trace context: `SP_THREAD_ID` and `SP_ROOT_ID` (optional for level B)

sp takes the pair as `--thread-id` and `--root-id` (`internal/volumecli/cli.go:155-156, 295`),
and the wrapper adds them from `SP_THREAD_ID` and `SP_ROOT_ID`. The ids are
per served prompt, so they cannot be set once at start.

| Harness | Answer | Source | How known |
| --- | --- | --- | --- |
| PI | **Yes, with a caveat.** The add-on sets the two variables in `process.env` at `promptAccepted` (inside the request's scope, from `activeTrace()`) and deletes them at `promptEnded`. The bash tool reads `process.env` on every call. The variables are process-wide, which is sound only because the plugin serves one prompt at a time; local typing during a remote turn gets the served ids (§7, "PI's turn boundaries"). No tool-call id | `dist/core/tools/bash.js:119-140`; the plugin's prompt queue | **measured** (the per-call read) |
| OpenClaw | **Yes through the public plugin; roughly without it.** OpenClaw's `resolve_exec_env` plugin hook adds variables to every exec call, and only the public plugin holds the API. The fallback is the PI approach, `process.env` set around `aroundDispatch`. It is read per call, but it is process-wide and depends on one turn at a time (§3.1) | `docs/plugins/hooks/reference.md:146`; `dist/bash-tools-*.mjs:2920-2948, 2999-3003` | read |
| Claude Code | **Not from our module's environment** (§9.4), **but through a file.** A `PreToolUse` hook on `Bash` could rewrite the command (`updatedInput`) and return `allow`, but the rewritten command must still pass the rules. **Built instead** (§9.13): the module writes the served prompt's ids and caller to a file at its arrival and clears them at its end, the add-on's `SessionStart` hook names the file in `SP_ENV_FILE`, and `scripts/sp` reads it on every call. Per turn, as PI's and OpenClaw's; no tool-call id | hooks docs, "PreToolUse decision control", "Persist environment variables" | read; **measured** (§9.13): the receipt carried the served prompt's pair |

### 9.8 Packaging the sp command line

The current shared build and standalone release contract is in
[Standalone ScratchPad binaries](scratchpad-binaries.md). Its one pin is
`plugins/scratchpad-skill/release.json`; harness packages and release archives
use the same executable bytes and notices. Standalone downloads occur during
explicit onboarding or image creation. Tool calls use the packaged binary.

The following historical measurements used clean source archives,
`CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' ./cmd/sp`, and Go 1.27.0.
The table was **measured** on 2026-09-27 at `79f8927`; at
`a28bb49`, the pin used in §9.15, the four were 7,404,210 B,
8,047,728 B, 7,274,656 B and 7,864,480 B, in the same order:

| Target | Size | gzip -9 | Notes |
| --- | --- | --- | --- |
| darwin/arm64 | 7,270,370 B (6.9 MiB) | 2,960,396 B | Mach-O, ad-hoc signed by the linker (`codesign -dv`); runs: the usage JSON, exit 2 |
| darwin/amd64 | 7,894,432 B (7.5 MiB) | 3,231,604 B | Mach-O x86_64 |
| linux/arm64 | 7,143,584 B (6.8 MiB) | 2,847,582 B | static ELF, stripped |
| linux/amd64 | 7,708,832 B (7.4 MiB) | 3,175,581 B | static ELF, stripped |
| all four in one npm package | 30.0 MB unpacked | 12.5 MB packed | `npm pack` of a package holding only the four |

The add-ons today are 36–64 KB each (`dist/`).

| Option | Install cost | Publishing cost | Verdict |
| --- | --- | --- | --- |
| **All four in each add-on package** | 12.5 MB download, 30.0 MB on disk, three quarters of it for other platforms | none beyond the add-on | while building: no extra packages, one pin |
| **Per-platform optional packages** (`…-sp-<os>-<arch>`, with npm's `os` and `cpu` fields, as `optionalDependencies` of each add-on) | about 3 MB download, 7.5 MB on disk; shared by the three add-ons | four more packages per sp pin | **at the release**. Stated honestly: an install with optional dependencies omitted, or a lockfile made on another platform, can leave the binary out, so the wrapper names the missing package in its error |
| **Download on first use** | a network fetch inside the model's first shell call | a public host for the binaries plus checksums | **rejected**. ScratchPad's repository is private, so it would need a host of our own, which makes the binaries as public as npm does, and it adds a network failure to a tool call |

**Stated honestly: any published option makes the sp binaries public**
while ScratchPad's source stays private. Publishing them is the
ScratchPad owners' decision to make before the release.

### 9.9 What the operator does, per harness

Common to all three: reserve a ScratchPad volume for the harness's
identity and set `SCRATCHPAD_VOLUME` (or the config entry's `options`);
keep `<stateDir>/scratchpad` on persistent storage; and use
`senderIdentity: signed`, as tracing already requires.

| Harness | Steps | Built by us |
| --- | --- | --- |
| PI | one flag, `--skill <add-on>/skill/scratchpad` (or the `skills` setting); the `bash` tool on (the demo's `--no-builtin-tools` off, or `--tools` naming `bash`). Nothing else: the connection comes from the plugin's context and the environment reaches bash | built (2026-09-27): the add-on's variables and the per-call ids (`plugins/pi`, §9.11) |
| OpenClaw | three config changes: `skills.load.extraDirs`; the skill named in the agent's skill allowlist (the demo's `[]`); `exec` and `read` in `tools.allow`; and the volume in the extension entry's options | built (2026-09-27): the add-on's variables and the per-prompt ones (`plugins/openclaw`, §9.12) |
| Claude Code | one flag, `--plugin-dir <add-on>` (or `CLAUDE_CODE_PLUGIN_DIRS`); `Skill(agent-fabric:scratchpad)` in the settings' `allow`; `Bash` and `Skill` out of the settings' `deny`, and no `--disable-slash-commands`; `permissions: { "mode": "query" }` in the plugin's config, so questions reach the caller; the volume in the extension entry's options. No variables: the add-on's hook hands them on | built (2026-09-27): the plugin manifest, the skill with its `allowed-tools`, the `SessionStart` hook and the file (`plugins/claude-code`, §9.13) |
| Public plugin, all three | — | the `metadata` field of §9.1, one neutral change per plugin |

### 9.10 Recommendation: PI first, then OpenClaw, then Claude Code

**PI first, end to end.** It has the easiest registration and the least
setup: one flag and the shell tool on, with an environment that reaches the
shell tool without any setting. Both are measured on PI 0.85.1. PI never
asks for permission, so no question has to travel. The per-call trace ids
come without a public-plugin change (§9.7), and PI runs headless on the
test rig. Nothing of ours is built beyond the add-on's variables.

**OpenClaw second.**
Registration is one config entry, plus the skill allowlist and
`tools.allow`. Its environment reaches exec without a setting (read), and
its default exec mode asks nothing. It too runs headless.

**Claude Code last.** Our module cannot give its shell the
environment, so that is a settings step or a hook of ours. Every
`scripts/sp` call is a question to the caller unless the operator allows
it. The per-call ids need a hook of ours. And it is the heaviest harness to
run: interactive only, with an Anthropic credential (§7). Its relay of
permission questions over the protocol is the one real advantage, and it
exists already.

**What blocks the design, per harness:**

- **All three:** the registration key `scratchpad_refs_ok` needs the public
  plugin's `metadata` field. Without it, references cannot be handed to a
  harness (§9.6). No add-on-only route exists.
- **Claude Code:** our module cannot give the shell its environment. It
  needs a launch or settings step, or a hook in the add-on's own plugin.
  The per-call ids need that hook too.
- **PI and OpenClaw:** nothing is impossible.

**Stated honestly.** Nothing restricts what the model runs. PI never asks,
and OpenClaw's default does not either, so the model can run any command
the operator's configuration allows, reading the credentials file included.
"The model never handles credentials" means it never passes them: the
wrapper adds them and refuses them from the model. It does not mean the
model cannot reach them.

### 9.11 PI, built and measured

Built in `plugins/pi` on 2026-09-27: the skill (`SKILL.md`, ScratchPad's
skill at `79f8927` adapted to `scripts/sp`), the wrapper (`scripts/sp`),
the builds (`build-sp.sh`, at pack time, gitignored), all three now in
`plugins/scratchpad-skill` and installed into each add-on's
`skill/scratchpad` by its `npm run build:sp` (§9.12), and the add-on's
variables (`src/scratchpad.ts`, whose shared part is now the fabric
package's `plugin-scratchpad.ts`); then,
once the public plugin had the `metadata` field, the registration key and
`scratchPadExtension` in `toolExtensions`. Two things the extension needed
from the add-on: it is built in `started()`, when the plugin's client
exists, behind a wrapper the factory returns (`ScratchPadHandOn`); and a
reference into PI's own volume counts as given, since the model publishes
with `scripts/sp`, which the extension does not see. The factory, the
module's default export, is asynchronous now: it resolves ScratchPad
before the plugin reads `metadata`, which the plugin does once before its
service starts.

**The run, measured on this machine on 2026-09-27.** A local ScratchPad from
ScratchPad's `79f8927` (`scratchpad serve`, provisioned with one volume per
agent) on a `nats-server` 2.14.6 in operator mode; one tenant account with
two users, a caller and PI. PI 0.85.1 with the public plugin at `e8355c3`
and this add-on, started as §6 step 7 says, the model
`anthropic/claude-sonnet-5`. The caller, an SDK client signing its prompt:

1. published `The secret word is kumquat-40479.` in its own volume and
   granted PI's user read;
2. prompted PI with the reference, asking for the word and for a file of
   PI's own holding it backwards, shared with the caller.

What PI's model did, from its session, every command through the bash tool:
`cat` of the skill's `SKILL.md`; `scripts/sp read --ref …`, which returned
the 34 bytes, decoded with `base64 -d`; `scripts/sp publish-file`, refused
with `workspace has no created volume; run init`; `scripts/sp init`, which
created its volume; `scripts/sp publish-file` again, whose receipt carries
the served prompt's pair (`"trace":{"thread_id":…,"root_id":…}`);
`scripts/sp grant --ref …`, the grantee filled in by the wrapper. It never
passed a connection flag. Its reply named `kumquat-40479` and ended with its
reference; the caller read that reference with its own credentials and got
`97404-tauqmuk`.

Also measured by the run: with `--tools` naming `bash` and the plugin's
tools, PI listed the skill, and its model's tools were exactly `bash`,
`discover_agents`, `prompt_agent` and `answer_agent` (asked in a second
prompt, which also ran a `discover_agents` call); the plugin's service
needs publish on `$SYS.REQ.USER.INFO` for its identity check, which the
test users first lacked.

**The second run: references handed on, measured on 2026-09-27.** The same
stack with a third tenant user and volume; the public plugin at `2c6eb76`,
with #218. The receiver was the TypeScript reference agent
(`reference-agents/typescript`, ScratchPad on, the model
`claude-sonnet-5` through Anthropic's OpenAI-compatible endpoint). The
caller's discovery showed `scratchpad_refs_ok=true` on both PI and the
reader, PI's from the plugin's real registration. The caller asked PI to
publish a file holding a launch code and to ask the reader, through
`prompt_agent`, what the file said, without telling it the code. PI's
model published with `scripts/sp`, called `prompt_agent` with only the
instruction and the reference, and the reader's reply carried the code:
the reference agent read the file with its own credentials and handed the
content to its model. PI's volume then showed two grants on the file: one
to the caller, which the model made with `scripts/sp grant` (the wrapper
names the served prompt's caller), and one to the reader, which the
extension made in `prompt_agent`. The reader's reply carried a reference
of its own, which PI's model read back with `scripts/sp read`. So the
skill now says that a reference for another agent goes into `prompt_agent`
unchanged, with no grant of the model's own.

### 9.12 OpenClaw, built and measured

Built in `plugins/openclaw` on 2026-09-27, with two changes to what PI's
build had.

**One skill for every add-on.** `SKILL.md`, `scripts/sp` and the sp build
moved out of `plugins/pi` into `plugins/scratchpad-skill`, with an
`install.sh` each add-on's `npm run build:sp` (and `prepack`) runs: it
builds sp once into the shared `bin/` and copies the skill and the binaries
into the add-on's `skill/scratchpad`, which the add-on packages. PI's
operator step, `--skill <add-on>/skill/scratchpad`, is unchanged. The code
both add-ons need moved into the fabric package, TypeScript only like the
rest of the plugins' contract (`typescript/src/plugin-scratchpad.ts`): the
settings' resolution, the start-time and per-prompt variables, the packaged
sp's path and port (given the add-on's skill directory), and
`ScratchPadHandOn`. For OpenClaw the resolution also takes the connection
from the plugin's own configuration, the account's `url` and `credentials`.

**The add-on.** As PI's: the default export resolves ScratchPad first; with
a volume the add-on sets the variables before the plugin connects,
declares `scratchpad_refs_ok` through `metadata`, and returns the
ScratchPad extension in `toolExtensions`. The per-prompt variables are set
around the dispatch (`aroundDispatch`) and cleared at `promptEnded`; the
plugin dispatches one turn at a time (§3.1).

**Two changes to the wrapper, from what the runs showed.**

- *The connection's names.* OpenClaw's plugin reads `NATS_URL` and
  `NATS_CREDS` in the gateway's environment as overrides of the account's
  connection: the first run logged `env override NATS_URL (account=default):
  matches config`, harmless only because the add-on had set the account's
  own values. `scripts/sp` now reads `SP_NATS_URL` and `SP_NATS_CREDS`, and
  the add-on never sets the others; the final run logged no override.
- *The caller's grant.* In the first two OpenClaw runs the model published
  its file, handed it to the reader through `prompt_agent` (granted there
  by the extension), and never ran `scripts/sp grant` for the caller, so
  the caller's read was refused (`denied`), although the skill says to
  grant before replying and the model had read it in the same turn. A
  separate step the model has to remember is a step it skips. So a `publish-file` during a served prompt
  with a verified caller now also grants that caller read, first-hand, as
  an SDK-built agent grants the caller its reply; the result carries
  `granted_to_caller` or `caller_grant_error`. The grant rule is unchanged:
  the only grantee is the served prompt's caller.

**The run, measured on this machine on 2026-09-27.** The local ScratchPad of
§9.11 with four tenant users and volumes: the caller, OpenClaw, the reader
(the TypeScript reference agent, ScratchPad on) and one unused. OpenClaw
2026.9.4 on Node 24, the public plugin loaded from `sdk-release-rollout`
`364b791` (its `index.ts`), this add-on named in the account's extension
entry with `options.scratchpad.volume`, the three config entries of §6 step
8, the model `claude-sonnet-5` through Anthropic's OpenAI-compatible
endpoint. The caller published `The secret word is saffron-489.`, granted
OpenClaw's user read, and prompted OpenClaw with the reference: find the
word, publish a file of its own with the word backwards and let the caller
read it, hand that file to the reader through `prompt_agent` without the
word, and report. Discovery showed `scratchpad_refs_ok=true` on OpenClaw
and on the reader. What OpenClaw's model did, from its session:

1. `read` of the skill's `SKILL.md`, then `exec` of `scripts/sp read`, the
   caller's 32 bytes;
2. `scripts/sp publish-file`, refused (`run init`), `scripts/sp init`, then
   `publish-file` again, whose result carried
   `granted_to_caller` (grant 8) and the served prompt's pair in the
   receipt (`"trace":{"thread_id":…,"root_id":…}`): the per-prompt
   variables reached OpenClaw's exec tool;
3. `discover_agents` for the reader, then `prompt_agent` with the reference
   alone; the extension granted the reader read (grant 9), and the reader's
   reply carried the file's content;
4. the reply named the word and the reader's answer, and ended with the
   reference, which the caller read with its own credentials:
   `984-norffas`.

OpenClaw's volume afterwards: grant 8 to the caller, grant 9 to the reader,
both on the published file. The run took 68 s.

### 9.13 Claude Code, built and measured

Built in `plugins/claude-code` on 2026-09-27. The add-on package is also a
Claude Code plugin, `agent-fabric` (`.claude-plugin/plugin.json`), which is
how the skill loads (§9.2): `skills/scratchpad`, installed by `npm run
build:sp` from `plugins/scratchpad-skill`, and one hook. The factory, the
module's default export, is asynchronous now, as PI's and OpenClaw's: it
resolves ScratchPad first, and with a volume declares
`scratchpad_refs_ok` through `metadata` and returns the ScratchPad
extension in `toolExtensions`.

**The environment: a hook of the add-on's, not a settings step.** Two
things reach Claude Code's Bash tool (§9.4): the settings' `env`, and a
hook. The settings step would have the operator copy four values the
add-on already resolves, and it is fixed per install: the served prompt's
trace and caller change every turn and cannot go there. The hook asks
nothing more of the operator than the skill does, since the package is
already a plugin for the skill, and a plugin carries hooks. So:

- the module writes the variables to `<state dir>/agent-fabric/<CLAUDE_PID>.env`,
  `NAME=value` lines, whole through a rename on every change: the
  connection, the workspace, the volume and the creator at start, the
  served prompt's trace and verified caller at `promptAccepted`, cleared at
  `promptEnded` (a second prompt in the same turn holds them until it ends,
  then the first again), the file removed at `stopping`;
- the hook, at `SessionStart`, appends `export SP_ENV_FILE='<that path>'` to
  `CLAUDE_ENV_FILE`, the state directory by the plugin's own rule
  (`NATS_STATE_DIR`, else `~/.claude/channels/nats`);
- `scripts/sp` reads the file on every call: its ten names and no others,
  each value assigned as it is, never run. When the file exists it is the
  truth, so a served prompt's variable it does not name is unset.

So the trace and the caller reach every `scripts/sp` call of the turn with
no step of the operator's. Per turn, like PI's and OpenClaw's: no
tool-call id. The other routes: a `PreToolUse` hook that rewrites the
command changes the command a permission rule must match (§9.7); a
`FileChanged` hook re-exporting after each write would hang on the
watcher's timing; `CLAUDE_ENV_FILE` is offered to `SessionStart`, `Setup`,
`CwdChanged` and `FileChanged` hooks only (hooks docs, "Persist
environment variables"). Measured on 2.1.283 before it was built: a
`SessionStart` hook's export in `CLAUDE_ENV_FILE` reaches later Bash
commands, and `CLAUDE_PID`, which the plugin's MCP server and its hooks
already key their files by, is in the Bash tool's environment too.

**The skill's `allowed-tools`.** Claude Code's copy carries
`allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)`, which `install.sh
--allowed-tools` adds to the front matter; the shared skill has none.
`Bash(scripts/sp *)`, the form of ScratchPad's own line, does not match:
the model runs `scripts/sp` by its absolute path, and with that rule the
call was asked. With `${CLAUDE_SKILL_DIR}`, which Claude Code substitutes in
a skill's Bash rules, it ran without a question. All measured on 2.1.283,
interactive; under `claude -p` no skill's grant applied, not even
`allowed-tools: Bash`, while the same rule given as `--allowedTools` did,
and the channel is interactive only anyway (§6). Two more things measured:
Claude Code asks before it loads a skill that carries `allowed-tools` (a
skill without one loads unasked), so the operator allows
`Skill(agent-fabric:scratchpad)`, a rule that also matches the model's bare
`scratchpad`; and the grant holds for the turn that loaded the skill,
cleared with the next message (skills docs, "Pre-approve tools for a
skill").

**Commands of their own.** The first run asked the caller four questions,
each relayed as a `query` and answered `yes`: the skill, and three commands
that wrapped `scripts/sp` (`SP=<path>; $SP describe` after a base64 decode,
`SP=<path>; $SP init && printf … | $SP publish-file …`, and `scripts/sp
read … | python3 -c …`). A rule matches each part of a compound command,
and a variable for the path matches nothing. So the shared skill now asks
for each `scripts/sp` command on its own, its path written out, its output
piped nowhere, content in on standard input, and `data_base64` decoded in a
command of its own, `echo … | base64 -d`, which Claude Code runs unasked
(measured). With that and the skill allowed, the run below asked nothing.

**The run, measured on this machine on 2026-09-27.** The local ScratchPad of
§9.11, provisioned afresh with a Claude Code user and volume beside the
caller's, PI's, the reader's and OpenClaw's. Claude Code 2.1.283,
interactive in `tmux`, in a home of its own outside any git repository, the
public plugin at `sdk-release-rollout` `3b9a20d` with this add-on as its
extension (the channel's `config.json`, `options.scratchpad.volume`) and as
a second `--plugin-dir`; the channel's `permissions.mode` `query`; in
`settings.json` the plugin's tools and `Skill(agent-fabric:scratchpad)`
allowed, and `defaultMode: "default"`, since the account's default was
auto mode, whose classifier would decide in place of a question. Claude
Code's own default model, on Anthropic directly with an Anthropic API key:
the run measures ScratchPad, not the join of the model calls (§3.4). The
reader was the TypeScript reference agent, ScratchPad on. The caller
published `The secret word is quince-32704.`, granted Claude Code's user
read, and prompted it with the task of §9.12. Discovery showed
`scratchpad_refs_ok=true` on Claude Code, from the plugin's real
registration, and on the reader. What Claude Code's model did, from its
transcript:

1. the Skill tool, `scratchpad`, unasked; `scripts/sp read --ref …` by its
   absolute path, unasked: the caller's 33 bytes; `echo … | base64 -d`;
2. `printf '%s\n' "40723-ecniuq" | scripts/sp publish-file --source - …`,
   refused (`run init`), `scripts/sp init`, then `publish-file` again,
   whose result carried `granted_to_caller` (grant 8) and the served
   prompt's pair in the receipt (`"trace":{"thread_id":…,"root_id":…}`):
   the file reached the Bash tool;
3. `prompt_agent` to the reader with an instruction and the reference; the
   extension granted the reader read (grant 9), the reader read the 13
   bytes with its own credentials, and answered `40723-ecniuq`;
4. `reply` with the word, the reader's answer and the reference, which the
   caller read with its own credentials: `40723-ecniuq`.

No permission question reached the caller. The run took 63 s. Claude
Code's volume afterwards: grant 8 to the caller, grant 9 to the reader,
both on the published file. After the turn the file held the five
start-time variables only, and at `/exit` the server removed it.

What the other runs showed. In the first, the reader read Claude Code's
file (its log: 13 characters), but its model answered that it could not,
and offered its own reply file; the hand-on had worked, the reading had
not. Two runs between it and the one above were the launcher's fault: it
made the home anew and lost the workspace, the volume's journal, so `init`
was refused with `exists`; then it carried a workspace of the previous
stack's keys into a fresh one, refused as another principal's. Both times
the model named the cause and ran no `reset`. The operator's rule stands:
keep the workspace. And measured on the way: `--disable-slash-commands`,
the remedy §6 gives for the skills of the directories above the working
directory, removes the Skill tool itself, so it and ScratchPad exclude each
other; a home of the instance's own already keeps the user's skills out.

**Two more things for the operator, measured in a running stack
(2026-09-27, Claude Code 2.1.283).** Claude Code can start in auto mode,
where its own classifier approves or blocks tool calls, so no permission
question reaches the caller: the settings pin `permissions.defaultMode:
"default"`. And a session's first prompt can be served before Claude Code
lists the session's skills, so an instruction conditioned on the listing
fails once; the model is told to call the skill by name whenever it holds a
reference. `plugins/claude-code/README.md` carries both in the operator's
steps.

### 9.14 Grant requests for what a harness published

Built in the fabric package and the three add-ons on 2026-09-28. An agent
handed a reference may read it, not pass it on: ScratchPad has no
delegation, so an agent that hands on a reference it did not create asks
the creator to grant the receiver read (`typescript/src/grant-request.ts`).
An SDK-built agent answers on `agents.sp-grant.<its address>`, by one rule:
the reference points into its own volume, the requester holds a live read
grant the creator made it first-hand, the grantee is another agent; then one
path, read only, the usual expiry, recorded as made on request, which
entitles no one to ask again. Until now a harness did not answer, so a
reference a harness published and its caller handed on was taken out of
the prompt, and the receiver got the text alone.

**The endpoint.** `ScratchPadHandOn.start` takes the plugin's service,
which `started()` hands every add-on, and adds `grantRequestEndpoint` to it
through the service's own `addEndpoint` (`AgentService.service`, the SDK's
public route for an endpoint added after start): the plugin builds its
service before the add-on could name an extra endpoint, and the contract
has no field for one. The same endpoint, the same `SenderGate`, the same
rule and the same port as an SDK-built agent's, so no public-plugin
change.

**The ledger.** The rule asks whether the creator granted the requester
read first-hand, and the port answers from a ledger of the grants it made
itself. A harness's grants to its caller are made by `scripts/sp`, in the
model's shell, which no hook sees (§9.1). So the wrapper records them:
after sp confirms a grant, the model's `grant` or the one after a
`publish-file`, it appends `<expires_at> <account> <user> <reference>` to
`SP_GRANTS_FILE`, which the add-on sets at start to `<workspace>.grants`
(through the file of §9.13 in Claude Code's case) and prunes of expired
lines. The add-on's port (`withRecordedGrants`) counts a live recorded
grant on that exact reference, to that requester, as first-hand, since the
wrapper grants only to the served prompt's verified caller, the agent the
harness handed its reply to, as an SDK-built agent's grant to the caller of
its reply is first-hand. Grants the extension or the endpoint made are in
the port's own ledger, as before; one made on request never entitles.

**Stated honestly.** The file is the model's to write, as its shell is: a
model that writes a line there could have a grant made to an agent of its
choosing. It could already do that, and more, by running the sp binary with
the credentials the operator gave the harness (§9.10, "Stated honestly"),
so the file widens nothing. The record is on the machine, not in
ScratchPad: a harness moved to another machine without its workspace
answers no request about the grants it made before.

**The run, measured on this machine on 2026-09-28.** A local ScratchPad
from `79f8927` (`scratchpad serve`) on `nats-server` in operator mode, one
tenant account with a caller, PI and a reader, a volume each. PI 0.85.1
with the public plugin at `sdk-release-rollout` `3b9a20d` and this add-on,
started as §6 step 7 says, the model `claude-sonnet-5` through Anthropic's
OpenAI-compatible endpoint. The reader was the TypeScript reference agent,
ScratchPad on. The caller was an SDK-built agent: `AgentTools` with the
fabric package's `scratchPadExtension` over `spCliScratchPad`, and no
model, its tool calls made by a script.

1. The caller's `prompt_agent` asked PI to publish a file with a launch
   code and reply with its reference. PI's model read `SKILL.md`, ran
   `scripts/sp init`, then `printf … | scripts/sp publish-file --source -`;
   the wrapper granted the caller read (grant 8) and recorded it. PI
   replied with the reference in 14 s; the caller read the file with its
   own credentials.
2. The caller's `prompt_agent` handed the reference, unchanged, to the
   reader. The extension asked PI; PI's add-on logged `grant request:
   granted` with the reader as grantee and the caller as requester, and
   made grant 9, to the reader. The reference stayed in the prompt
   (`references_removed` absent), and the reader read the 31 bytes with its
   own credentials and handed them to its model.

PI's volume afterwards, as sp `describe` shows it: grant 8 to the caller
and grant 9 to the reader, on the one file. What the reader's model made of
it: it quoted the code, then said it could not verify the content, since it
arrived in its prompt and not through a tool of its own, the reading of
§9.13's first run again. Its own reply by reference failed (`invalid`, in
its log), which this run did not look into.

The suites: each add-on's `test/integration/grant-requests.test.ts` runs the
same hand-on against the add-on started through its own `started()`, with
the fabric package's stand-in sp, and the refusals: no recorded grant to the
requester, or an expired one. `plugins/pi/test/unit/scripts-sp.test.ts`
covers the wrapper's record.

### 9.15 The skill at ScratchPad `a28bb49`

On 2026-09-28 the skill moved from ScratchPad `79f8927` to `a28bb49`, the
commit the native clients speak. That run used the build script's `SP_COMMIT`
pin. The shared pin now lives in `plugins/scratchpad-skill/release.json` (§9.8).
What changed in the command line between the two (`internal/volumecli`,
its README, and ScratchPad's own skill), and what it changed here:

| Change in sp | Here |
| --- | --- |
| A publication is prepared into a private disk spool in the workspace (`publication.spool`) before upload; a rerun with the same operation id uses the saved bytes and never reads the source again; the intent check compares the flags, not the content | `SKILL.md`: changed content needs a new operation id |
| `recover` reconciles an accepted receipt first, then uploads the saved spool and submits the same command | `SKILL.md`, "Resolve a failed command" |
| New `spool-inspect` and `spool-remove [--apply]`; a preparation refused before its command, and a publication abandoned by `reset --apply`, leave a spool that blocks every publication and `recover` (`pending`) until removed | `SKILL.md`; the wrapper adds the connection and workspace to them as to any command, and takes `--help` as a flag without a value; the CLI adapter (below) |
| `hydrate` reports `symlinks`; sync keeps literal symbolic links and executable modes; `read` returns files up to 16 MiB | `SKILL.md`; nothing parses hydrate's reply |
| Workspace and journal format 2: a workspace written by `79f8927` is refused | the operator's step below |

**The CLI adapter's capacity path.** `spCliScratchPad` and
`SpCliScratchPad`, on a `capacity` refusal, clean up and publish the same
commit once more. Measured at `a28bb49` against `scratchpad serve`: with
every retention slot pinned, the refusal leaves a `preparing` spool; the
retry, with the same operation id or another, and `recover` then refuse
with `pending` ("preparation is incomplete; inspect and remove its spool
explicitly") until `spool-remove --apply`, after which the same operation
id publishes. Both adapters now run `spool-remove --apply` right after a
definite `capacity` refusal, before looking at the slots, so a refusal
that cleanup cannot help no longer wedges the next commit either. The
reply is checked in its exact shape: `present`, `files`, `bytes`,
`removable`, `applied`, and `phase` exactly when a spool is present. A
spool the CLI keeps (the refused command is still pending) ends the commit
with the capacity refusal, and the next mutation recovers first. The
stand-in sp of both packages models the spool.

**Byte-quota defect observed at `a28bb49`.** Content beyond
the volume's encoded-byte allowance is refused at upload, after the
command was prepared, so the writer stays `pending`: `recover` uploads
again and is refused again, `spool-remove` refuses ("operation not
permitted in this status"), and only `reset --apply`, then
`spool-remove --apply`, frees the workspace. At `79f8927` the same file
was refused locally before preparation and the writer stayed `ready`. The
adapters never reset, by design. Section 9.16 describes the correction for
new uploads and the recovery boundary for existing pending workspaces.

**The operator's step: workspaces from `79f8927`.** sp at `a28bb49`
refuses a workspace the earlier sp wrote (`workspace binding is invalid`),
and a fresh workspace cannot `init` the volume under a new operation id
(`exists`). Measured: move the old workspace aside, make an empty private
directory in its place, and run `init` with the volume's original
creation operation id, which the old `workspace.journal` holds as
`creation.operation_id`; that attaches the same volume incarnation, and
publishing works. Grants recorded in `SP_GRANTS_FILE` are the add-on's own
file and stay valid.

**The run, measured on this machine on 2026-09-28.** A local ScratchPad
from `a28bb49` (`scratchpad serve`) on `nats-server` in operator mode, one
tenant account with a caller, PI and a reader, a volume each. PI 0.85.1
with the public plugin at `sdk-release-rollout` `d333f26` and this add-on,
its skill built at `a28bb49`, started as §6 step 7 says, the model
`claude-sonnet-5`. The reader was the TypeScript reference agent with the
native client. The caller was an SDK client: `AgentTools` with
`scratchPadExtension` over `spCliScratchPad` and sp at `a28bb49`.

1. The caller published a secret word with the CLI adapter and handed its
   reference to PI with `prompt_agent`; the extension granted PI read.
2. PI's model read `SKILL.md`, then `scripts/sp read` (32 bytes, decoded
   with `base64 -d`); `scripts/sp publish-file` was refused with `run
   init`; `scripts/sp init`, then `publish-file` again, whose result
   carried `granted_to_caller`, recorded in the grants file.
3. PI's `prompt_agent` handed its reference, unchanged, to the reader. The
   reader's native client read the 24 bytes, committed its reply, granted
   PI read and appended its own reference.
4. PI read the reader's reference with `scripts/sp read` and replied in
   99 s. The caller read PI's file with its own credentials: `PI relays:
   quince-52943.`

What the reader's model made of it: it declined to vouch for content that
arrived in its prompt, as in §9.13's and §9.14's runs; the reads, grants
and references all went through.

### 9.16 Upload-quota recovery from sp-v0.1.1

The shared release pin selects the correction for ScratchPad issue #1160.
A new upload checks its complete encoded graph against the volume's quota
before sending content. It prepares the journal's checkpoint only after
upload succeeds. A quota refusal during upload therefore preserves a
previously ready writer. Inspect the saved spool with `scripts/sp spool-remove`,
then use `scripts/sp spool-remove --apply` to abandon it. This preserves the
writer and its next command number. Partial remote reservations remain
charged until explicit maintenance collects them.

An existing pending checkpoint stays protected, including one saved by the
earlier CLI after an upload refusal. Recover it first. Never automatically
reset a writer merely because a response says `capacity`.

PI, OpenClaw, and Claude Code copy the same maintained Fabric skill during
`npm run build:sp` and `prepack`. The standalone archives derive their
generic skill from the pinned ScratchPad source. The
[distribution checks](scratchpad-binaries.md#checks-and-release-boundary)
compare their shared recovery instructions and inspect all three npm
archives for the exact generated skill and executable hashes.

## 10. Appendix: the text for the public repo

To be pasted as it is. No fabric word appears below; the check of §8 is
run on it.

### 10.1 `agents/EXTENSIONS.md`

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

### 10.2 The paragraph for each plugin's README

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
