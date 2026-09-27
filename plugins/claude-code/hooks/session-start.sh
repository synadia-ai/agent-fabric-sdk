#!/bin/sh
# The add-on's one Claude Code hook, at SessionStart: names to the Bash tool
# the file the add-on's module keeps ScratchPad's variables in, as
# SP_ENV_FILE, which the skill's scripts/sp reads on every call
# (`docs/plugins.md` §9.13).
#
# The module runs in the NATS channel plugin's MCP server, a sibling of the
# Bash tool's processes, so it cannot set their environment; it writes the
# variables to `<state dir>/agent-fabric/<CLAUDE_PID>.env` instead: the
# connection, the workspace and the volume at start, the served prompt's
# trace and caller from its arrival to its end. The state directory is the
# plugin's rule, NATS_STATE_DIR or ~/.claude/channels/nats; CLAUDE_PID is the
# Claude Code process, which Claude Code hands its hooks and its MCP servers
# alike. Claude Code keeps what this appends to CLAUDE_ENV_FILE for every
# later Bash command of the session.
#
# Prints nothing and exits 0 whatever happens: a hook must never interrupt a
# session.
[ -n "${CLAUDE_ENV_FILE:-}" ] || exit 0
case ${CLAUDE_PID:-} in
  '' | *[!0-9]*) exit 0 ;;
esac
state=${NATS_STATE_DIR:-${HOME:-}/.claude/channels/nats}
file=$state/agent-fabric/$CLAUDE_PID.env
# Single-quoted for the shell that reads CLAUDE_ENV_FILE.
quoted=$(printf '%s' "$file" | sed "s/'/'\\\\''/g")
printf "export SP_ENV_FILE='%s'\n" "$quoted" >>"$CLAUDE_ENV_FILE" 2>/dev/null
exit 0
