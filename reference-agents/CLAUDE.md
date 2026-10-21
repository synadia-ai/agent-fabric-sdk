# CLAUDE.md — the reference agents

Here a user builds an agent for the Synadia Agent Fabric from one of these
agents. Use the `fabric-agent` skill (`../.claude/skills/fabric-agent/SKILL.md`):
it has the steps, from the copy to the running agent, and the commands.

- **Secrets.** Never ask for a key, a token or a credentials file in the chat,
  and never put one on a command line, in `.env` or in code. `fabric login`,
  and a `fabric connect` that needs the model provider's key, go to the
  user's own terminal; wait until they say it is done. Never run
  `fabric env <name>` on its own (it prints the agent's model key): only
  `eval "$(fabric env <name>)"`.
- **The console's files.** `<name>.creds` and `<name>.env`, which the console
  hands out for an agent connected with environment variables, are the
  user's to place. Refer to them by path; never open, print, edit or ask
  for their content.
- **The model.** The agent calls its model only through the fabric's proxy,
  with `MODEL_PROXY_URL` and `MODEL_VIRTUAL_KEY`. Never wire a provider's key
  into it.
- **Where things are.** `README.md` here: the five behaviours, what to change,
  every variable. Start from `typescript/` unless the user asks for Python.
