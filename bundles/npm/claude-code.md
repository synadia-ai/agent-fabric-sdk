# @synadia-ai/agent-fabric-claude-code

Claude Code on the Synadia Agent Fabric, in one plugin: the NATS channel
plugin for Claude Code (`nats-channel`), the fabric's tracing and
ScratchPad's skill. The Claude Code session becomes an agent on the fabric:
other agents find it and prompt it, its model calls join the prompt's
thread, and its own prompts to other agents hang under the tool call that
sent them. A turn typed at the terminal is traced as a task of its own,
with the agents it prompts beneath it.

## Install

Claude Code installs plugins from a marketplace. This package is the
plugin; a marketplace names it with an npm source:

```json
{
  "name": "agent-fabric",
  "owner": { "name": "Synadia" },
  "plugins": [
    { "name": "nats-channel", "source": { "source": "npm", "package": "@synadia-ai/agent-fabric-claude-code", "version": "^0.2.0" } }
  ]
}
```

Save it as `.claude-plugin/marketplace.json` in a folder of your choosing,
then:

```sh
claude plugin marketplace add <that folder>
claude plugin install nats-channel@agent-fabric
```

The plugin's server and hooks run on [Bun](https://bun.sh), which must be on
`PATH`.

## Connect

The fabric's console creates the agent and hands out its NATS
credentials. Claude Code and the channel read the rest from the
environment:

| Variable | What |
| --- | --- |
| `NATS_URL` | the fabric's NATS server |
| `NATS_CREDS` | the agent's credentials file: its identity |
| `NATS_SENDER_IDENTITY` | `signed`: the agent signs what it sends, which the fabric verifies |
| `SYNADIA_CLAUDE_CODE_NAME` | the agent's name, the last token of its address `agents.prompt.cc.<owner>.<name>` |
| `SYNADIA_OWNER` | the owner, the 4th token |
| `ANTHROPIC_BASE_URL` | the fabric's model proxy |
| `ANTHROPIC_AUTH_TOKEN` | the agent's model key: Claude Code's model calls go through the proxy with it |
| `ANTHROPIC_API_KEY` | your own Anthropic API key: Claude Code turns channels on only with it |
| `SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR` | optional: the agent's ScratchPad volume and its private workspace |

`NATS_CONTEXT`, a NATS CLI context, wins over `NATS_URL` and `NATS_CREDS`.
A context in the plugin's own config file counts only when neither is set.

Start it with the channel, which is not on Claude Code's list of channels,
so it loads as a development channel, with the warning Claude Code shows
for it:

```sh
claude --dangerously-load-development-channels plugin:nats-channel@agent-fabric
```

So that a prompt from the fabric is answered without a question in the
terminal, allow the channel's tools in Claude Code's settings
(`"permissions": { "allow": ["mcp__plugin_nats-channel_nats", "Skill(nats-channel:scratchpad)"] }`),
and send the questions Claude Code asks to the prompt's caller with the
channel's configuration, `{"permissions": {"mode": "query"}}` in
`~/.claude/channels/nats/config.json` (or `/nats-channel:configure permissions query`).

## The fabric add-on

The plugin's `.mcp.json` names the bundled add-on (`runtime/fabric.js`) in
`SYNADIA_CLAUDE_CODE_EXTENSIONS`. The package's main export is the add-on.

`BUILD` names the channel's version and the commits it was built from.
Apache-2.0.
