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
channel's handler. With a ScratchPad volume configured it also gives
Claude Code's model ScratchPad, through a skill this package carries as a
Claude Code plugin of its own (see "ScratchPad"). Without it the plugin is
the plain plugin. The contract it fills is the plugin's
`agents/EXTENSIONS.md`; the spec is
[`../../docs/plugins.md`](../../docs/plugins.md) §2, §3.1, §3.4 and §9.13.

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
waits on a call to another agent, so a prompt of a tree it is waiting in is
refused at once with `409` instead of waiting behind the wait it is part of.
It waits from the moment its model sends a prompt until every call the
served request has open has settled: a blocking `prompt_agent` until it
returns, a call started with `wait: false` for as long as it is open. Once
none is open, a prompt of the tree is admitted, though the turn goes on.
The guard is the fabric package's `loopGuard()`, two more interceptors
after tracing's and its `aroundToolCall` inside the add-on's; the PI and
OpenClaw add-ons return the same.

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

## Running Claude Code on the fabric

Measured on Claude Code 2.1.281 (2026-09-24; the reference agents'
findings F24 and F25, kept since 2026-09-26 with the fabric's deployment on
one machine). That deployment's `harnesses/claude-code/` is the worked
version (`run.sh`, `env.example`, its README); what follows is the recipe
it implements.

1. **Claude Code and bun.** `claude` on `PATH`, and `bun`: the plugin's
   server and hooks run on it.
2. **The plugin, from the checkout until it is published.** This loads it
   for the session as `nats-channel@inline`, hooks included; its bundle is
   committed, nothing is built there:

   ```sh
   claude --plugin-dir <synadia-agents>/agents/claude-code \
     --dangerously-load-development-channels plugin:nats-channel@inline
   ```

3. **The add-on, named.** This package with `dist/` built, and
   `SYNADIA_CLAUDE_CODE_EXTENSIONS=<its absolute path>` in the environment
   `claude` starts in (see "Naming it"). Export `PWD` too: the plugin's
   `.mcp.json` hands it to its server.
4. **The identity.** The channel's `config.json` with a NATS context of
   Claude Code's own and `senderIdentity: "signed"` (see "Identity"), and
   `permissions.allow: ["mcp__plugin_nats-channel_nats"]` in Claude Code's
   `settings.json`, so a turn driven from NATS does not stop at an approval
   nobody sees.
5. **A virtual key naming Anthropic as its provider.** Claude Code is
   Anthropic's product, its documented gateway shape is a proxy in front of
   Anthropic, and an Anthropic key means Anthropic bills its owner; the
   fabric adds the trace, the identity and the usage record, and never
   routes Claude Code to another model provider. So the key is issued for
   Claude Code's identity with the proxy's built-in `anthropic` provider
   (on a test rig where that name is taken, a provider of another name at
   `https://api.anthropic.com` on the Anthropic shape), the tenant's
   Anthropic API key as the provider key in the record, and the harness
   `claude`, without which the proxy files each call as a thread of its own.
6. **Two keys and the base URL.** Both are set, and Claude Code sends both:
   - `ANTHROPIC_API_KEY`: an Anthropic API key of the user's own, sent as
     `x-api-key`. Claude Code turns its channel on only when a feature flag
     says so, and it fetches its flags from Anthropic directly, never
     through the base URL, and only with an Anthropic credential; with the
     virtual key alone the channel is ignored. It may be
     the same key as the provider key of step 5, or another of the
     tenant's.
   - `ANTHROPIC_AUTH_TOKEN`: the virtual key, sent as
     `Authorization: Bearer` next to it. The proxy reads the virtual key
     from `Authorization` first and deletes both headers before it sets the
     provider's own, so the Anthropic key reaches no provider.
   - `ANTHROPIC_BASE_URL`: the proxy's bare origin, no `/api`; Claude Code
     appends `/v1/messages` and the proxy forwards it to Anthropic as it is.

   Claude Code warns at start that both keys are set and "auth may not work
   as expected". That is expected: sending both is the point.

7. **No model variables.** Claude Code runs its own default models, the
   main loop and the side calls, every call through the proxy, recorded
   with Anthropic's usage, cache reads and writes included.
8. **A home outside any git repository.** `HOME`, `CLAUDE_CONFIG_DIR` and
   the channel's `NATS_STATE_DIR` in a directory of the instance's own,
   never `~/.claude`, and not inside a git working tree: from inside one,
   Claude Code sends that repository's `CLAUDE.md` files and its git status
   to the model with every call. Outside one it offers the
   model the skills in the `.claude/skills` of every directory above its
   working directory, the user's own included; `--disable-slash-commands`
   removes them, and with them the Skill tool, so not with
   ScratchPad.
9. **A terminal, or a pseudo-terminal.** Interactive only: `claude -p`
   registers on the bus and turns no prompt into a turn.
   Answer the development-channels warning once and the channel is on;
   from a script, `tmux` with one Enter does the same.

## What the console shows

The served thread with the session's model calls joined through the pair,
the closing call inside the window, the thread's outcome and its duration
from `start` to `end`, `harness: claude` at depth `full` with both halves;
a subagent's calls as children of the session's thread. A delegation
Claude Code's model makes: it discovers and prompts another agent, whose
thread sits under its `prompt_agent` tool call with Claude Code its
verified caller. Everything the session
does between the two records is filed under the prompt: local typing
during a NATS-driven turn, and a second NATS prompt answered in the same
turn, share the window.

One call can fall outside the pair. At the end of each turn Claude Code
asks its model what the user might type next; when that call's model
reaches for a tool, Claude Code calls it once more after the turn's `Stop`,
and the add-on's `end`. The console shows that call as a root of its own
on the session id, with no caller. The pair is the turn, and
the reader infers nothing beyond it: a limit, not a bug.

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
- **The two keys are what Claude Code's warning calls unsupported.** Both
  sent together, the virtual key as `Bearer` and the Anthropic key as
  `x-api-key`, was measured on 2.1.281; Claude Code does not
  document it. Re-check it on a release that touches channels or gateways.
- **An Anthropic credential on the machine.** The channel is behind a flag
  only an Anthropic credential fetches, so every Claude Code on the fabric
  carries an Anthropic API key of its own, and could call Anthropic with it
  directly. Its model calls are traced because it is pointed at the proxy,
  by configuration, not by anything the add-on enforces.
- **An interactive session.** No headless mode serves a prompt; a script
  drives a terminal.
- **The context Claude Code sends.** Whatever its working directory
  offers goes to the model with every call: a repository's `CLAUDE.md` and
  git status from inside one, the skills of the directories above it from
  outside one. The home's place decides it.
- **ScratchPad's grant is per turn.** Claude Code applies a skill's
  `allowed-tools` in the turn that loaded the skill, and clears it with the
  next message. A later prompt whose turn runs `scripts/sp` without loading
  the skill again sends the caller a question for each call. The model
  loaded it in every measured turn; Claude Code gives no rule that lasts
  the session short of the operator's own `allow`.
- **ScratchPad without the hook.** With hooks off, the Bash tool gets no
  `SP_ENV_FILE`, and `scripts/sp` refuses to run unconfigured, unless the
  operator sets the variables in the environment `claude` starts in, which
  gives the connection but no served prompt's trace or caller.

## ScratchPad

The package is also a Claude Code plugin, `agent-fabric`
(`.claude-plugin/plugin.json`), with two pieces: ScratchPad's skill, the
one every add-on ships, in `skills/scratchpad/` (`SKILL.md`, `scripts/sp`,
and `bin/` with the sp command line for darwin and linux on arm64 and
amd64, installed from `../scratchpad-skill` by `npm run build:sp`), and a
`SessionStart` hook. Claude Code loads the skill as
`agent-fabric:scratchpad`; the model runs `scripts/sp` through its Bash
tool. Nothing restricts Bash or any other tool.

**The operator's steps.** Besides the steps above:

1. The package loaded as a plugin too, a second `--plugin-dir`:

   ```sh
   claude --plugin-dir <synadia-agents>/agents/claude-code --plugin-dir <add-on> \
     --dangerously-load-development-channels plugin:nats-channel@inline
   ```

2. Permission questions to the caller, and the skill allowed, in the
   channel's `config.json` and Claude Code's `settings.json`:

   ```json
   { "permissions": { "mode": "query" } }
   ```

   ```json
   {
     "permissions": {
       "defaultMode": "default",
       "allow": ["mcp__plugin_nats-channel_nats", "Skill(agent-fabric:scratchpad)"]
     }
   }
   ```

   `defaultMode: "default"` matters: Claude Code 2.1.283 can start in auto
   mode, where its own classifier approves or blocks a tool call, so no
   permission question ever reaches the caller.

3. A volume reserved for Claude Code's identity by the ScratchPad operator,
   in the extension's entry in the channel's `config.json`, or as
   `SCRATCHPAD_VOLUME` in the environment `claude` starts in:

   ```json
   "extensions": [{ "module": "<add-on>", "options": { "scratchpad": { "volume": "CcVol" } } }]
   ```

Keep `Bash` and `Skill` out of the settings' `deny`, and do not start
Claude Code with `--disable-slash-commands`, which removes the Skill tool.

**The first prompt of a session.** Claude Code can serve a session's first
prompt before it lists the session's skills to the model. An instruction
that says "use ScratchPad only when the skill is listed" therefore fails
once: the model answers that it cannot read a reference. Tell the model to
call the skill by name (`agent-fabric:scratchpad`) whenever it holds a
reference, and to ask for the text only if the skill does not exist.

**Permission questions.** The skill's copy here has one line ScratchPad's
own skill has and the shared one does not:
`allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/sp *)`. It restricts
nothing; it lets the model run `scripts/sp` by its absolute path without a
question, in the turn that loaded the skill. Claude Code asks before it
loads a skill that carries such a line, and `Skill(agent-fabric:scratchpad)`
in the settings' `allow` answers that once for all. Every other command
follows the operator's rules: with `permissions.mode: "query"` the plugin
sends each question to the caller of the served prompt, who answers yes
or no. The skill tells the model to run `scripts/sp` as a command of its
own, since a command that wraps it (a shell variable for its path, a pipe
out of it, `;` or `&&`) is a different command, and asks.

**Where the settings come from.** The factory resolves each from the
entry's `options.scratchpad` (`volume`, `dir`, `url`, `creds`), else the
variable (`SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR`, `NATS_URL`, `NATS_CREDS`),
else, for the URL and the credentials file, the plugin's NATS context. The
workspace defaults to `scratchpad/` in the channel's state directory
(`$NATS_STATE_DIR/scratchpad`), created if missing; keep it across
restarts, since it holds the volume's journal. Without a volume ScratchPad
is off.

**How `scripts/sp` gets them.** The add-on runs in the plugin's MCP server,
a sibling of the Bash tool's processes, so it cannot set their
environment. It writes the variables to
`$NATS_STATE_DIR/agent-fabric/<CLAUDE_PID>.env` (mode 600, rewritten whole
on every change, removed when the server stops), and the package's
`SessionStart` hook names that file to the Bash tool as `SP_ENV_FILE`,
through `CLAUDE_ENV_FILE`. `scripts/sp` reads it on every call:

| Variable                              | Written                                        | `scripts/sp` adds                                                          |
| ------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------- |
| `SP_NATS_URL`, `SP_NATS_CREDS`        | at start                                       | `--url`, `--creds`, every call                                             |
| `SCRATCHPAD_DIR`                      | at start                                       | `--dir`, every call                                                        |
| `SCRATCHPAD_VOLUME`                   | at start                                       | `--volume`, on `init` only                                                 |
| `SP_CREATOR`                          | at start: Claude Code's prompt address         | `--creator`, on `publish-file`                                             |
| `SP_THREAD_ID`, `SP_ROOT_ID`          | per served prompt, from its arrival to its end | `--thread-id`, `--root-id`, every call                                     |
| `SP_CALLER_ACCOUNT`, `SP_CALLER_USER` | the same, for a verified caller                | `--grantee-account`, `--grantee-user`, on `grant` and after `publish-file` |
| `SP_GRANTS_FILE`                      | at start: `<workspace>.grants`                 | nothing: it records there each grant sp confirmed, for grant requests      |

A `publish-file` during a served prompt with a verified caller also grants
that caller read on what it published; a `grant` goes to that caller and no
other. When a second prompt arrives in the same turn, the file names it
until it ends, then the first again.

**References in and out.** With ScratchPad on, the add-on registers Claude
Code as reading references (`scratchpad_refs_ok: "true"` through the
extension's `metadata`), and the references its model puts into
`prompt_agent` go through the fabric package's ScratchPad extension, as an
SDK-built agent's do: granted to a receiver that reads references, removed
with a note for any other.

**Grant requests.** A caller Claude Code handed a reference to may hand it on
through its own agent tools; its ScratchPad extension then asks the creator,
Claude Code, to grant the receiver read (the grant request, `grant-request.ts` in
the fabric package). The add-on answers on Claude Code's service, by the rule every
SDK-built agent answers by: the reference must point into Claude Code's volume, the
requester must hold a live read grant Claude Code made it first-hand, the grantee
must be another agent, and the grant is one path, read only, ten minutes at
most, recorded as made on request, which entitles no one to ask again. The
grants Claude Code's model makes go through `scripts/sp`, which the add-on does not
see, so `scripts/sp` records each one sp confirms in `SP_GRANTS_FILE`
(`<workspace>.grants`), and the add-on counts a live one as first-hand: it
went to the agent whose prompt Claude Code was serving.

**Measured** on Claude Code 2.1.283 on 2026-09-27 (`docs/plugins.md`
§9.13): given a reference, the model read it through the skill, published
its own file, which the caller read, and handed that file to another agent
through `prompt_agent`, which read it; no permission question reached the
caller.

## Public API

|                                                                                                                                     |                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`, `fabricExtension(ctx, env?)`                                                                                             | the factory of the contract: resolves ScratchPad, then builds the extension; `env` is where the variables are read, `process.env` by default              |
| `createFabricExtension(ctx, env?, scratchPad?)`                                                                                     | the same, synchronous, from settings already resolved                                                                                                     |
| `SCRATCHPAD_OPTION`, `SP_VARS`, `SP_ENV_FILE_VAR`, `ScratchPadHandOn`, `SpEnvFile`, `spEnvFilePath(stateDir, env)`, `spBinary(env)` | ScratchPad's option key, the variables `scripts/sp` reads, the file they go to and the variable that names it, the tool extension, the packaged sp's path |
| `EXTENSION_NAME`, `IDENTITY_OFF_WARNING`, `NO_SESSION_LINE`, `SERVED_HARNESS`, `DEFAULT_STOP_WAIT_MS`                               | the constants                                                                                                                                             |
| `isClaudeSessionId(v)`                                                                                                              | the session-id rule the pair is published under, the pre-split plugin's (`fbd16ab`), header-safe                                                          |

The contract's types, the setting's precedence (`resolveEdgeSubject`) and
the loop guard (`loopGuard`) are `@synadia-ai/agent-fabric`'s, shared by
every add-on under `plugins/`.

## Development

Built like the fabric package (tsup, ESM and CJS, vitest, eslint,
prettier). It links `@synadia-ai/agent-fabric` at `file:../../typescript`,
built first, and the two protocol SDK packages by the same `file:` links
the fabric package uses; its `package-lock.json` is committed, and a clean clone
installs with `npm ci`. Nothing of Claude Code is a dependency. The tests: unit, a
fake of the plugin driving the events in the MCP server's order
(`test/support/fake-plugin.ts`: the handler open until the reply, a tool
call re-entered through the handler's snapshot); integration, the factory's
hooks on a real `AgentService` and `Agents` over a local `nats-server` in
operator mode, the pair and the edges on the wire validated against
`test-fixtures/schemas/served.json` and `edge.json`, signed, one id three
ways, `end` at the stop; ScratchPad's file, the hook and the plugin's
manifest (unit), and the references handed on (integration).

`npm run build:sp` installs the skill from `../scratchpad-skill` into
`skills/scratchpad`, with the `allowed-tools` line. It downloads the four
published binaries pinned in `../scratchpad-skill/release.json` and verifies
their archive and executable hashes with Node 20+. `npm pack` runs it too.
`skills/` is gitignored. No Go compiler or service checkout is required.
The [binary guide](../../docs/scratchpad-binaries.md) covers authenticated
downloads, offline archives, cache checks, and the included licenses.

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
