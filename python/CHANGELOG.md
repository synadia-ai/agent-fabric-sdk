# Changelog

All notable changes to `synadia-ai-agent-fabric` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `agent-fabric agents`, text output: each agent's description, what the agent says it does, is printed on a line of its own under the agent's row, after a tab; an agent with no description has no such line. Everything the list prints is text an agent registered, and all of it is printed as plain text. In every field, the address, the kind, the identity and the description, a line break, a tab, a control or an invisible character becomes a space (the zero width joiner and non-joiner stay), and half a character (a surrogate that is not part of a pair) becomes U+FFFD. The description is also brought to one line: runs of spaces become one, and a text longer than 500 characters is cut. So when the command prints what an agent registered, nothing in it adds a row or a column, stops the list, or reaches the terminal as an escape sequence. Reading the replies to discovery is the protocol SDK's part and is unchanged: a reply that holds a byte that is not UTF-8 still fails there, and the command then ends with that error and no list. `--json` gives every field as it was registered, as before.
- `agent-fabric prompt`: the lines on stderr print what an agent registered, or said when it refused, as plain text, by the list's rule for a field: the address and the identity on the `→` line, the addresses in `no agent "…"; there: …` and in `N agents of kind "…": …`, and the words after `no reply:`. The errors `find()` and `pick_agent()` raise are unchanged: their messages carry the addresses as they were registered. The `list_agents.py` example prints its rows as plain text too.
- `agent-fabric prompt`, without `--json`: the reply and a question the agent asks are the agent's own text, and a terminal no longer gets them as they came. When stdout is a terminal, every control or format character in the reply is written as U+FFFD, and half a character too; a line break, a tab, the zero width joiner and the zero width non-joiner stay. So a reply cannot clear the screen, move the cursor or write over a line with an escape sequence. The same for a question when stderr is a terminal. When the output is a pipe or a file, the text is written as it came, so a script reads the exact reply. `--json` is unchanged.

### Fixed

- `--json` no longer stops with a `UnicodeEncodeError` when a field of a listed agent, or a reply, holds half a character (a surrogate that is not part of a pair). It is written as its JSON escape, the bytes the TypeScript command writes, and a reader gets the same text back. Two halves of one character that came in two chunks of a reply are that character again, as in the TypeScript command.
- `agent-fabric prompt` no longer exits 1 with nothing printed when the reply, or a question, holds half a character, as a reply cut inside an emoji does. U+FFFD is written in its place, the bytes the TypeScript command writes.
- The command no longer stops with a `UnicodeEncodeError` on a stdout that is not UTF-8, such as a terminal set to Latin-1. A character the encoding cannot hold is written as `?`; before, `agent-fabric agents` stopped at the first description that held one. Both outputs are set so when the command starts, unless they already write something in such a character's place, as stderr does.
- The command no longer writes a log line to stderr as it came. The protocol SDK's Python client logs a warning that quotes what an agent sent: the words of a refusal, or the subject of a heartbeat it could not read. The command set up no logging, so Python wrote each warning to stderr as it was, an escape sequence in it too. A refused prompt printed its words twice, once raw, and a program of the account that published unreadable heartbeats put a line per heartbeat on the terminal of whoever ran `agent-fabric agents` or `agent-fabric prompt`. Every log record is now written as one line of plain text, by the list's rule for a field, and the protocol SDK's warnings are not printed: the command prints a refusal itself, after `no reply:`. So both commands print the same lines for a refused prompt. A program that set up logging before it called `main()` keeps what it set up.

## [0.2.0] — 2026-10-21

### Added

- A caller: `fabric_caller()` and `fabric_caller_from_env()` prompt your agents with the creds file the console gave you and nothing else. Every prompt is signed and starts a task of its own; `prompt()` returns the SDK's stream with the task's root id, `ask()` the whole reply with it. `list()`, `find()`, `close()`, `pick_agent()` and `FabricCallerError`.
- The `agent-fabric` command: `agent-fabric agents` and `agent-fabric prompt <address or kind> "<text>"`, with `--creds`, `--url`, `--timeout` and `--json`. Run it with `uvx --from synadia-ai-agent-fabric agent-fabric`.
- Five examples in the source distribution's `examples/`: one prompt, a reply in a script, questions answered, the agents listed, topics prompted on an interval.

## [0.1.0]

### Added

- Tracing: `fabric_tracing()`, the protocol SDK's three hooks, and `trace_headers()` for model calls.
- Durable runs joined to the task that started them: `durable_run_id`, `durable_trace`, `durable_headers` and `with_durable_trace`.
- The `served` record for a harness plugin's add-on: `build_served_record`, `served_publisher` and `valid_harness_thread_id`.
- The ScratchPad extension for the agent tools, `scratch_pad_extension`, with the grant request's two sides, `request_grant` and `grant_request_endpoint`.
- The native ScratchPad client: `native_scratchpad`, `native_scratchpad_from_env` and `scratchpad_reader`.
- The ScratchPad CLI adapter over `sp`: `SpCliScratchPad` and `scratchpad_from_env`.
- Short artifact references: `sp-r1:` tokens accepted alongside `sp-ref:`.

[0.2.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/python
[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/python
