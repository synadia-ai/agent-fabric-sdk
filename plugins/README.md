# plugins/

The fabric versions of the Claude Code, OpenClaw and PI plugins will live
here: the harness plugins of the Synadia Agent Protocol with the fabric's
tracing switched on — Claude Code's `served` records and session hooks,
OpenClaw's trace scope and `served` pair, PI's `X-Synadia-*` header
stamping — built on `@synadia-ai/agent-fabric`.

The plain plugins stay in the public protocol repo, `synadia-agents`
(`agents/claude-code`, `agents/openclaw`, `agents/pi`), with no fabric in
them. Nothing is here yet.
