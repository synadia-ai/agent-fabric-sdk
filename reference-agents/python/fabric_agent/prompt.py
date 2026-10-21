"""prompt.py — prompt one agent on the fabric from the command line.

    uv run python -m fabric_agent.prompt <env file> <address or kind> "<the prompt>"
    uv run python -m fabric_agent.prompt .env.caller assistant "say hello"

A caller, not an agent: ``fabric_caller()`` from the fabric package connects
with the creds file the env file names (``NATS_URL`` and ``NATS_CREDS``, as in
``env.example``) and signs the prompt with it, so the agent sees a verified
sender and can grant it read on what it hands back. Tracing is on: the prompt
starts a tree of its own, which the console shows with the agent's model calls
and everything the agent delegated; its root id is printed. The reply is
printed as it streams; a ScratchPad reference at its end is repeated on its
own line, to paste into the next prompt. The same caller as the TypeScript
agent's ``src/prompt.ts``; the package's own command, ``agent-fabric prompt``,
does the same.

    PROMPT_TIMEOUT_MS   how long to wait for the whole reply; default ten
                        minutes, because a chain of agents takes minutes
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

from synadia_ai.agent_fabric import (
    CANNOT_ANSWER,
    FabricCallerError,
    fabric_caller,
    find_references,
)
from synadia_ai.agents import Query, ResponseChunk

from .config import load_env_file


async def main() -> int:
    if len(sys.argv) < 4:
        print('usage: python -m fabric_agent.prompt <env file> <address or agent kind> "<the prompt>"', file=sys.stderr)
        return 2
    env = {**load_env_file(Path(sys.argv[1])), **os.environ}
    who, text = sys.argv[2], " ".join(sys.argv[3:])
    if "NATS_CREDS" not in env:
        print("the env file must name NATS_CREDS (and NATS_URL); see env.example", file=sys.stderr)
        return 2

    try:
        caller = await fabric_caller(creds=env["NATS_CREDS"], url=env.get("NATS_URL", "nats://127.0.0.1:4222"))
    except FabricCallerError as err:
        print(err, file=sys.stderr)
        return 1
    try:
        # By address as discovery reports it, or by kind when there is one such agent.
        target = await caller.find(who)
        verified = ", verified" if target.id_sig_verified else ""
        print(f"→ {target.prompt_subject} ({target.identity or 'no identity'}{verified})", file=sys.stderr)

        started = time.monotonic()
        reply: list[str] = []
        max_wait_s = float(env.get("PROMPT_TIMEOUT_MS", "600000")) / 1000
        prompt = await caller.prompt(target, text, max_wait_s=max_wait_s)
        prompt.root_id.add_done_callback(
            lambda f: print(f"root {f.result()}", file=sys.stderr) if not f.cancelled() and not f.exception() else None
        )
        async for msg in prompt.stream:
            if isinstance(msg, ResponseChunk):
                print(msg.text, end="", flush=True)
                reply.append(msg.text)
            elif isinstance(msg, Query):
                # The agent asked something mid-reply; a command line has no one to ask.
                await msg.reply(CANNOT_ANSWER)
        print(flush=True)
        references = find_references("".join(reply))
        if references:
            print(f"reference: {references[-1]}", file=sys.stderr)
        print(f"{time.monotonic() - started:.1f} s", file=sys.stderr)
        return 0
    except FabricCallerError as err:
        # No such agent, or more than one of that kind: the message names what is there.
        print(err, file=sys.stderr)
        return 1
    except Exception as err:  # noqa: BLE001 — one line for whoever is at the command line
        # The agent refused the prompt or failed while serving it. The protocol
        # carries a code and a few words; the reason is in the agent's own log.
        print(f"\nno reply: {err}; the agent's own output says why", file=sys.stderr)
        return 1
    finally:
        await caller.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
