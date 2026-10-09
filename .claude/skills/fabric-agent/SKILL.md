---
name: fabric-agent
description: Build, connect and run an agent on the Synadia Agent Fabric from this repository's reference agent, with the fabric command-line tool (`fabric`). Use when asked to make an agent for the fabric (a research agent, a writer, a reviewer, …), to connect an agent to the fabric, to start it, or to change its model. Covers which steps need the user's own terminal, because they take secrets.
---

# An agent on the Synadia Agent Fabric

You build the agent from the reference agent in `reference-agents/`, connect it with `fabric`, and run it. The fabric gives the agent a signed identity on NATS, its own model key for the fabric's model proxy, the other agents to find and prompt, and the console, where its owner sees what it did.

## The rule on secrets

Two steps take a secret: `fabric login` (a Synadia Cloud token) and `fabric connect` when it issues a model key (the model provider's API key, for example OpenRouter's). They ask for it in a terminal, and you have none: in your shell, they stop with an error.

- **Never ask the user to paste a key, a token or a credentials file into the chat.** Never put one on a command line you run, in `.env`, or in code.
- **Hand the step to the user instead.** Give the exact command, ask them to run it in their own terminal, where it asks for the secret and does not echo it, and wait until they say it is done. Then carry on.
- **Never print what holds a secret:** `fabric env <name>` on its own (it prints the agent's model key), `~/.fabric/agents/<name>/model-key`, the agent's `.creds` file. Use `fabric env` only inside `eval "$(fabric env <name>)"`.
- **The agent never uses the provider's key.** It calls its model through the proxy with its own model key, `MODEL_PROXY_URL` and `MODEL_VIRTUAL_KEY`, which is how the fabric records its calls. Never wire `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or another provider key into the agent's code or `.env`.

## 1. Check fabric

Run `fabric --version`. If it is missing, the user installs it from their console: **Connect an agent** shows the installer. Ask them for their console's address if you need it.

Run `fabric list --all`, which reads the account. If it says `not logged in`, hand this to the user, for their own terminal:

```sh
fabric login --console <their console's address>
```

It asks for a Synadia Cloud token with the Account Admin role on the account their agents go into.

## 2. Build the agent

Start from `reference-agents/typescript/` (Node 22.13 or later). Read `reference-agents/README.md` first: it says where each behaviour is and what to change. Python is `reference-agents/python/`; it needs this repository's `make setup` and two sibling checkouts, so prefer TypeScript unless asked.

- **A new agent:** copy `reference-agents/typescript/` to a directory of its own, without `node_modules`, and run `npm install` there. It takes its packages from npm.
- **The persona:** `AGENT_SYSTEM_PROMPT` (or `AGENT_SYSTEM_PROMPT_FILE`) and `AGENT_DESCRIPTION` in the agent's `.env`. The description is what other agents' models read to decide whom to ask: say what the agent is for.
- **Its kind:** `AGENT_KIND` in `.env`, for example `researcher`. The agent's address is `agents.prompt.<kind>.<owner>.<name>`.
- **A tool of its own:** `src/tools.ts`, next to the agent tools. The model loop is `src/model.ts`, what one prompt does is `src/agent.ts`, every setting is in `src/config.ts`.
- **Keep** the signer, the trace headers on every model call and the prompt interceptor. Without them the agent is not verified, its calls land on no thread, and the work it delegates is not shown under it.

`.env` holds only what `fabric env` does not export: the persona, the kind, the description, the tools. `fabric env` supplies the NATS URL, the credentials, the agent's name, the proxy, the model key and the model. Run `npm run typecheck` and `npm test` after a change to the code.

## 3. Connect it

Pick the agent's name with the user: lowercase letters, digits, `-`, `_`. Then, with the model they want (it must call tools; on OpenRouter `anthropic/claude-sonnet-5` does):

```sh
fabric connect <name> --harness sdk --model <model>
```

`--owner <team>` sets the owner in the address (fabric 0.8.0 or later); without it, the agent takes the login name of whoever starts it. `--provider anthropic` or `--provider openai` when the key is not OpenRouter's.

This command needs the provider's API key, unless the agent already has a live model key. Check whether the key is in your environment without printing it, for example `test -n "$OPENROUTER_API_KEY" && echo set`.

- **It is set:** run the command yourself.
- **It is not:** hand the command to the user for their own terminal. It asks for the key there.
- **The user would rather not hand a key to `fabric` at all:** on the console's **Model keys** page they click **Issue a key** for this agent and paste the provider's key there, in the browser. The console shows the agent's new model key once. They take it in their terminal with `fabric connect <name> --model-key -`, which asks for it and revokes the key it replaces. A model key is never edited: a new one replaces the old.

`fabric connect` creates the agent's user on the account, its credentials, its model key and its settings under `~/.fabric/agents/<name>`. Run it again to finish a setup that stopped half way; what is done is kept.

## 4. Run it

In the agent's directory:

```sh
eval "$(fabric env <name>)" && npm start
```

It runs until stopped: start it in the background and read its output for errors. A first prompt checks it end to end: from the console, on the agent's page, or for the user from their terminal with `npm run prompt -- <kind> "<a prompt>"` in a shell where `fabric env` was evaluated. The console shows the agent online, then its tasks with every model call. Stop only the process you started.

## 5. Change it later

- **Another model:** `fabric connect <name> --model <model>` keeps the user, the credentials and the model key, and needs no key. Restart the agent with step 4. For one run only: `MODEL_NAME=<model> npm start` after the `eval`.
- **An expired model key:** `fabric renew <name>`, in the user's terminal if it asks for the provider's key; then restart.
- **The persona or the tools:** edit, then restart.
