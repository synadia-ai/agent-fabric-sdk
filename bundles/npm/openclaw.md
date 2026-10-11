# @synadia-ai/agent-fabric-openclaw

OpenClaw on the Synadia Agent Fabric, in one package: the NATS channel for
OpenClaw (`@synadia-ai/nats-channel`), the fabric's tracing and ScratchPad's
skill. The OpenClaw agent becomes an agent on the fabric: other agents find
it and prompt it, its model calls join the prompt's thread, and its own
prompts to other agents hang under the tool call that sent them.

## Install

```sh
openclaw plugins install @synadia-ai/agent-fabric-openclaw
```

OpenClaw asks you to confirm a plugin from npm and the capabilities it
declares (the agent tools). In a script or a Dockerfile, where nothing can
answer, confirm both on the command line:

```sh
openclaw plugins install --force --accept-capabilities @synadia-ai/agent-fabric-openclaw
```

If your OpenClaw config has a non-empty `plugins.allow` list, add `"nats"`
to it. If it has a non-empty `tools.allow`, name the agent tools there
(`discover_agents`, `prompt_agent`, `answer_agent`) or `group:plugins`.

## Connect

The fabric's console creates the agent and hands out its NATS
credentials. The channel reads the rest from the gateway's environment:

| Variable | What |
| --- | --- |
| `NATS_URL` | the fabric's NATS server |
| `NATS_CREDS` | the agent's credentials file: its identity (`NATS_CREDENTIALS` also works) |
| `NATS_SENDER_IDENTITY` | `signed`: the agent signs what it sends, which the fabric verifies |
| `SYNADIA_OPENCLAW_NAME` | the agent's name, the last token of its address `agents.prompt.oc.<owner>.<name>` |
| `SYNADIA_OWNER` | the owner, the 4th token |
| `SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR` | optional: the agent's ScratchPad volume and its private workspace |

`NATS_CONTEXT`, a NATS CLI context, wins over `NATS_URL` and `NATS_CREDS`.
Then start the gateway: `openclaw gateway run`.

OpenClaw's model is OpenClaw's own setting. For the fabric to record the
model calls, point the model's provider at the fabric's model proxy with
the agent's model key, in `~/.openclaw/openclaw.json`. The key can stay in
the environment: OpenClaw reads `"${NAME}"` as the variable's value.

```json
{
  "models": {
    "providers": {
      "openrouter": { "baseUrl": "<the fabric's model proxy>/api/v1", "apiKey": "${FABRIC_VIRTUAL_KEY}" }
    }
  },
  "agents": { "defaults": { "model": "openrouter/anthropic/claude-sonnet-5" } },
  "tools": { "alsoAllow": ["discover_agents", "prompt_agent", "answer_agent"] }
}
```

`/api/v1` is OpenRouter's path behind the proxy; another provider has its
own.

## The fabric add-on

The plugin's entry loads the bundled add-on (`dist/fabric.js`) unless
`SYNADIA_OPENCLAW_EXTENSIONS` or `SYNADIA_AGENT_EXTENSIONS` is set; set one
of them to name other extensions, or set it empty to run the plain channel.
The package's main export is the add-on.

`BUILD` names the channel's version and the commits it was built from.
Apache-2.0.
