# @synadia-ai/agent-fabric-claude-code

The Synadia Agent Fabric add-on for the Claude Code channel plugin
(`nats-channel`, `agents/claude-code` in
[`synadia-agents`](https://github.com/synadia-ai/synadia-agents)). One
extension module in the shape the plugin loads: named in
`SYNADIA_CLAUDE_CODE_EXTENSIONS`, it puts the fabric package's tracing on the
plugin's service and on the client its agent tools prompt through, binds
each served prompt to the Claude Code session it was delivered to with the
signed `served` pair, its `end` at the turn's `Stop` so the closing model
call falls inside the window, and puts the `409` loop guard in front of the
channel's handler. Without it the plugin is the plain plugin. The contract
it fills is the plugin's `agents/EXTENSIONS.md`; the spec is
[`../../docs/plugins.md`](../../docs/plugins.md) §2, §3.1 and §3.4.

## What it does

The factory, the module's default export, calls `fabricTracing()` once and
hands the plugin its three hooks, so the session is on the wire exactly what
an SDK-built agent is:

- **On the service, per prompt:** the envelope's `thread_id` and `root_id`
  are adopted, or a root minted when neither is there; a half pair or a
  malformed id is refused with `400` before the handler runs; the handler
  runs inside the trace scope.
- **On the client Claude Code's agent tools prompt through, per prompt:**
  the child thread is minted and the pair put into the envelope, and the
  signed `edge` record is published on `TRACE.edges` before the prompt goes
  out, with the model's tool-call ID, which the plugin takes from its
  `PreToolUse` hook and passes to `execute()`. A delegation Claude Code's
  model makes hangs under its tool call in the console.
- **On the heartbeat:** `records_published` and `records_dropped`, the
  `served` records counted with the edges.

The harness piece is the join of Claude Code's own model calls. Claude Code
sends `X-Claude-Code-Session-ID` on every model request, and the proxy files
the calls as `harness: claude`, the session id their `harness_thread_id`.
The plugin is an MCP server inside the session and cannot touch those
headers, so the add-on publishes the binding:

| Event                                | What the add-on does                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionStarted(session, source)`    | remembers the session Claude Code is in now, as the plugin's `SessionStart` hook reported it (also once at start, for the session recorded before the server came up)                                                                                                                                                                                   |
| `promptAccepted(request)`            | keeps `activeTrace()`, the scope tracing bound for this request, by `request.id`; the session is `request.sessionId`, else the remembered one; when it is a Claude Code session id, `beginTurn(scope, "claude")` and `bind(session)` on the fabric package's served publisher, which publishes `start` stamped with the arrival                         |
| `aroundToolCall(request, tool, run)` | binds the request's scope around `run`, so the edge of a `prompt_agent` Claude Code's model calls is filed under the served thread; the plugin already re-enters the handler's context through a snapshot before it calls this, so it is a no-op rebind                                                                                                 |
| `promptEnded(request, outcome, at)`  | `error` and `timeout`: `settle(outcome, at)` at once. `ok`, which the plugin reports when `reply` completed the request: the turn is not over, since Claude Code makes at least one more model call after the reply to write its closing text, so the pair stays open until a `Stop` after `at`, or for at most `stopWaitMs` (120 s), then ends at `at` |
| `turnStopped(session, at)`           | the `Stop` hook ran: every turn of that session answered before `at` ends with `ok` at `at`, the oldest first. So two prompts answered in one Claude Code turn share its end, and a prompt answered after this stop waits for the next                                                                                                                  |

A prompt that arrives while no session is known gets no pair and one log
line (`NO_SESSION_LINE`); its scope is still kept, so its model's
delegations are still filed under the served thread. The session is bound
at arrival: a `/clear` during a turn does not move the binding.

The pair goes through the fabric package's `servedPublisher()`, made at
`started` from the plugin's client: signed as the plugin's identity with the
record id as the nonce and the `Nats-Msg-Id`, on the edge subject, in the
order the records were due, so a pair's `end` never overtakes its `start`.
`stopping` ends every open turn — an answered one at its reply's time, one
still open now with `error` — and flushes. The plugin calls it before it
fails the requests still open, and no `Stop` comes after it.

**The `409` loop guard.** Claude Code cannot serve a prompt while its model
waits inside a blocking tool call, so a prompt of a tree it is waiting in is
refused at once with `409` instead of waiting behind the wait it is part of.
The guard is the fabric package's `loopGuard()`, two more interceptors after
tracing's; the PI and OpenClaw add-ons return the same.

**What it does not do.** No `toolExtensions`: a harness reads no ScratchPad
reference in the MVP. No header on Claude Code's calls: the plugin cannot
add one, which is why the pair exists. Nothing with the tool-call ID: the
plugin's `PreToolUse` hook gives it to the tools, and tracing writes it.

## Naming it

Installed where Claude Code runs, `npm install @synadia-ai/agent-fabric-claude-code`,
and named to the plugin by absolute path (a package directory with `dist/`
built); a package name resolves from the plugin's own directory upward,
which for a plugin in Claude Code's plugin cache is rarely where the add-on
is:

```sh
SYNADIA_CLAUDE_CODE_EXTENSIONS=/opt/fabric/node_modules/@synadia-ai/agent-fabric-claude-code claude …
```

Claude Code hands its environment to the plugin's MCP server, so the
variable set where `claude` starts reaches the plugin. Or in the channel's
`config.json` (`~/.claude/channels/nats/`, or `NATS_STATE_DIR`), where an
entry may carry options:

```json
{
  "extensions": [
    {
      "module": "/opt/fabric/node_modules/@synadia-ai/agent-fabric-claude-code",
      "options": { "edgeSubject": "TRACE.edges" }
    }
  ]
}
```

`SYNADIA_CLAUDE_CODE_EXTENSIONS` wins over `SYNADIA_AGENT_EXTENSIONS`, which
wins over the config field. The channel's `service registered` log line and
its `request_info` tool list `agent-fabric` when it is loaded.

## The settings

- **The edge subject:** the entry's `options.edgeSubject`, else the variable
  `SYNADIA_FABRIC_EDGE_SUBJECT`, else `TRACE.edges`. The `served` pair goes
  on the same subject. `null` in the options is propagate-only: lineage
  forwarded, no record of either kind published. A subject that can never
  be published to stops the factory; the plugin logs
  `extension "…" not loaded: …` and starts plain.
- **`options.stopWaitMs`:** how long an answered turn waits for the `Stop`
  hook, 120000 by default. A value that is not a number of ms ≥ 0 stops the
  factory the same way.

There is no `tracing` setting: the add-on's presence is the switch.

## Identity

Records are signed, so the plugin needs `senderIdentity: "signed"` with a
NATS context carrying Claude Code's own credentials. With identity off the
add-on warns once at `started`, the served publisher warns once more when
the first record is due, every record owed counts as dropped on the
heartbeat, and Claude Code's calls stand as a harness thread of their own,
unbound.

## What the console shows

The served thread with the session's model calls joined through the pair,
the closing call inside the window, the thread's outcome and its duration
from `start` to `end`; a subagent's calls as children of the session's
thread; a delegation Claude Code's model makes as a child under its tool
call. Everything the session does between the two records is filed under
the prompt: local typing during a NATS-driven turn, and a second NATS prompt
answered in the same turn, share the window.

## Stated honestly

- **Without the plugin's hooks** (`disableAllHooks`, or `bun` not on the
  hooks' `PATH`) there is no `SessionStart`, so the session comes from
  `CLAUDE_CODE_SESSION_ID` in the server's environment if at all, and no
  `Stop`, so `end` carries the reply's time after the bound and the closing
  call falls outside the window.
- **The bound delays `end`**: with no `Stop`, the pair stays open for
  `stopWaitMs` after the reply.
- **A `Stop` names the turn it ended by time only.** Two prompts answered in
  one turn share its end; a prompt answered after a stop that the server's
  poll saw late (250 ms) could take that stop's time. Claude Code gives
  nothing finer.

## Public API

|                                                                                                       |                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `default`, `createFabricExtension(ctx, env?)`                                                         | the factory of the contract; `env` is where the variable is read from, `process.env` by default  |
| `EXTENSION_NAME`, `IDENTITY_OFF_WARNING`, `NO_SESSION_LINE`, `SERVED_HARNESS`, `DEFAULT_STOP_WAIT_MS` | the constants                                                                                    |
| `isClaudeSessionId(v)`                                                                                | the session-id rule the pair is published under, the pre-split plugin's (`fbd16ab`), header-safe |

The contract's types, the setting's precedence (`resolveEdgeSubject`) and
the loop guard (`loopGuard`) are `@synadia-ai/agent-fabric`'s, shared by
every add-on under `plugins/`.

## Development

Built like the fabric package (tsup, ESM and CJS, vitest, eslint,
prettier). It links `@synadia-ai/agent-fabric` at `file:../../typescript`,
built first, and the two protocol SDK packages by the same `file:` links
the fabric package uses; no lockfile is committed while the links point
outside the repo. Nothing of Claude Code is a dependency. The tests: unit, a
fake of the plugin driving the events in the MCP server's order
(`test/support/fake-plugin.ts`: the handler open until the reply, a tool
call re-entered through the handler's snapshot); integration, the factory's
hooks on a real `AgentService` and `Agents` over a local `nats-server` in
operator mode, the pair and the edges on the wire validated against
`test-fixtures/schemas/served.json` and `edge.json`, signed, one id three
ways, `end` at the stop.

```sh
(cd ../../typescript && npm install && npm run build)
npm install
npm run typecheck && npm run lint && npm run format:check
npm test
npm run build
```

## License

Apache-2.0, like the fabric package. See [LICENSE](LICENSE).
