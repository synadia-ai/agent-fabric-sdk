"""prompt.py — prompt one agent on the fabric from the command line.

    uv run python -m fabric_agent.prompt <env file> <address or kind> "<the prompt>"
    uv run python -m fabric_agent.prompt .env.caller assistant "say hello"

A caller, not an agent: it connects with the credentials the env file names
(``NATS_URL`` and ``NATS_CREDS``, as in ``env.example``) and signs the prompt
with them, so the agent sees a verified sender and can grant it read on what
it hands back. Tracing is on: the prompt starts a tree of its own, which the
console shows with the agent's model calls and everything the agent delegated.
The reply is printed as it streams; a ScratchPad reference at its end is
repeated on its own line, to paste into the next prompt. The same caller as the
TypeScript agent's ``src/prompt.ts``.

    PROMPT_TIMEOUT_MS   how long to wait for the whole reply; default ten
                        minutes, because a chain of agents takes minutes
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from pathlib import Path

import nats
from synadia_ai.agent_fabric import fabric_tracing
from synadia_ai.agents import Agents, Identity, Query, ResponseChunk, resolve_nats_connection_bundle

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

    bundle = resolve_nats_connection_bundle(
        url=env.get("NATS_URL", "nats://127.0.0.1:4222"), creds=env["NATS_CREDS"], identity="signed"
    )
    nc = await nats.connect(**bundle.connection_options)
    # Tracing on, from the fabric package: outside any served prompt, the
    # prompt starts a tree of its own.
    agents = Agents(nc=nc, identity=Identity(signer=bundle.signer), interceptors=[fabric_tracing().prompt_interceptor])
    try:
        # By address as discovery reports it, or by kind when there is one such agent.
        found = await agents.discover(timeout=1.0)
        target = next((a for a in found if a.prompt_subject == who), None) or next(
            (a for a in found if a.agent == who), None
        )
        if target is None:
            there = ", ".join(a.prompt_subject for a in found) or "nobody"
            print(f'no agent "{who}" on the fabric; there: {there}', file=sys.stderr)
            return 1
        verified = ", verified" if target.id_sig_verified else ""
        print(f"→ {target.prompt_subject} ({target.identity or 'no identity'}{verified})", file=sys.stderr)

        started = time.monotonic()
        reply: list[str] = []
        max_wait_s = float(env.get("PROMPT_TIMEOUT_MS", "600000")) / 1000
        async for msg in target.prompt(text, max_wait_s=max_wait_s):
            if isinstance(msg, ResponseChunk):
                print(msg.text, end="", flush=True)
                reply.append(msg.text)
            elif isinstance(msg, Query):
                # The agent asked something mid-reply; a command line has no one to ask.
                await msg.reply("The caller is a command line and cannot answer; continue with your best judgement.")
        print(flush=True)
        references = re.findall(r"sp-ref:[A-Za-z0-9_-]+", "".join(reply))
        if references:
            print(f"reference: {references[-1]}", file=sys.stderr)
        print(f"{time.monotonic() - started:.1f} s", file=sys.stderr)
        return 0
    except Exception as err:  # noqa: BLE001 — one line for whoever is at the command line
        # The agent refused the prompt or failed while serving it. The protocol
        # carries a code and a few words; the reason is in the agent's own log.
        print(f"\nno reply: {err}; the agent's own output says why", file=sys.stderr)
        return 1
    finally:
        await agents.close()
        await nc.close()
        bundle.wipe()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
