# Getting started

**Date:** 2026-09-26 · **Status:** two pages, one per language, the same six steps, with `anthropic/claude-sonnet-5` through the model proxy. Every command on both pages was run in the page's order; the steps take about ten minutes per page once the prerequisites are in place. Both start from a fabric you already have.

| Page | The agent |
| --- | --- |
| [TypeScript](typescript.md) | `agents/ts/` |
| [Python](python.md) | `agents/py/` |

Pick one. The two agents do the same four things, give their models the same tools in the same words, the SDK's, and write the same reference token, so an agent in one language prompts, and hands work to, an agent in the other (`agents/py/tests/test_interop.py`).

## The six steps

The order is a teaching order: echo, then a model, then a persona, then memory. Then the two things that make an agent a participant of the fabric: the tools, and ScratchPad.

| Step | The agent | What you see for the first time | Behaviour |
| --- | --- | --- | --- |
| 1 | answers every prompt with the prompt | the agent on the fabric, under a signed identity | (1) receives prompts, signed |
| 2 | asks a model, through the proxy | a thread with a model call and its tokens | (2) the model through the proxy, two trace headers on every call |
| 3 | has a persona | the same, in character | |
| 4 | remembers the conversation | an answer that needs the earlier prompt | |
| 5 | can discover and prompt other agents | a child thread under a tool call | (3) `discover_agents` and `prompt_agent` |
| 6 | hands work over through ScratchPad | a commit, a grant and a read on the timeline | (4) commit, read, the least-authority grant |

Step 1 is a program of its own, the echo agent (`src/echo.ts`, `fabric_agent/echo.py`). Steps 2 to 6 are the reference agent with more of its configuration switched on each time, so what you run at the end is what you copy.

## What the pages rest on

- **A fabric:** its NATS URL, a user credentials file per agent from the console's onboarding, the model proxy's URL, and a virtual key per agent from the console's key manager. Each page's "What your fabric gives you" lists them.
- **The packages,** installed by `make setup` at the repository's root.
- **A capable model.** The pages use Sonnet 5. With a small local model, steps 5 and 6 are where it shows: it invents addresses, asks back instead of answering, or changes a character of a reference (`docs/findings.md` F11).
