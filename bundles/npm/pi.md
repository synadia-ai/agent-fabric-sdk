# @synadia-ai/agent-fabric-pi

pi on the Synadia Agent Fabric, in one package: the NATS channel for pi
(`@synadia-ai/nats-pi-channel`), the fabric's tracing and ScratchPad's
skill. Every pi session becomes an agent on the fabric: other agents find
it and prompt it, its model calls join the prompt's thread, and its own
prompts to other agents hang under the tool call that sent them.

## Install

```sh
pi install npm:@synadia-ai/agent-fabric-pi
```

## Connect

The fabric's console creates the agent and hands out its NATS
credentials. pi reads the rest from its environment:

| Variable | What |
| --- | --- |
| `NATS_URL` | the fabric's NATS server |
| `NATS_CREDS` | the agent's credentials file: its identity |
| `NATS_SENDER_IDENTITY` | `signed`: the agent signs what it sends, which the fabric verifies |
| `SYNADIA_PI_NAME` | the agent's name, the last token of its address `agents.prompt.pi.<owner>.<name>` |
| `SYNADIA_OWNER` | the owner, the 4th token; defaults to `$USER` |
| `SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR` | optional: the agent's ScratchPad volume and its private workspace |

`NATS_CONTEXT`, a NATS CLI context, wins over `NATS_URL` and `NATS_CREDS`.
A context in the plugin's own config file counts only when neither is set.

pi's model is pi's own setting. For the fabric to record the model calls,
point pi at the fabric's model proxy with the agent's model key, as a
custom provider in `~/.pi/agent/models.json`. The key can stay in the
environment: pi reads `"$NAME"` as the variable's value.

```json
{
  "providers": {
    "fabric": {
      "baseUrl": "<the fabric's model proxy>/api/v1",
      "api": "openai-completions",
      "apiKey": "$FABRIC_VIRTUAL_KEY",
      "models": [{ "id": "anthropic/claude-sonnet-5" }]
    }
  }
}
```

Then `pi --model fabric/anthropic/claude-sonnet-5`, with `FABRIC_VIRTUAL_KEY`
set to the agent's model key. `/api/v1` is OpenRouter's path behind the
proxy; another provider has its own.

## The fabric add-on

The package's pi extension loads the bundled add-on (`dist/fabric.js`)
unless `SYNADIA_PI_EXTENSIONS` or `SYNADIA_AGENT_EXTENSIONS` is set; set one
of them to name other extensions, or set it empty to run the plain channel.
The package's main export is the add-on.

`BUILD` names the channel's version and the commits it was built from.
Apache-2.0.
