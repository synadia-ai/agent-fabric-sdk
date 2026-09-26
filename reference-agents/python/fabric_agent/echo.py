"""echo.py — the smallest agent on the fabric: it answers every prompt with
"echo: <the prompt>". No model, no tools, no ScratchPad.

    uv run python -m fabric_agent.echo            # reads .env next to pyproject.toml when present
    uv run python -m fabric_agent.echo path.env   # or a named file

The first step of the getting-started walkthrough
(``docs/getting-started/python.md``). It shows the first of the four
behaviours on its own: the agent receives prompts through the SDK's host side,
with a signed identity. Everything else ``agent.py`` does is this, plus more.
It reads four variables of the agent's ``.env``: NATS_URL, NATS_CREDS,
AGENT_OWNER, AGENT_NAME.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path

import nats
from synadia_ai.agent_fabric import active_trace, fabric_tracing
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Envelope, format_sender, resolve_nats_connection_bundle

from .config import load_env_file


async def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    env_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / ".env"
    env = {**(load_env_file(env_file) if env_file.exists() else {}), **os.environ}
    if "NATS_CREDS" not in env:
        raise SystemExit("NATS_CREDS: the agent's credentials file is required")

    # One credentials file gives both the connection and the signer, so the
    # identity the agent registers is the identity the connection logged in with.
    bundle = resolve_nats_connection_bundle(
        url=env.get("NATS_URL", "nats://127.0.0.1:4222"), creds=env["NATS_CREDS"], identity="signed"
    )
    nc = await nats.connect(**bundle.connection_options)

    # Tracing on, from the fabric package: a prompt from a tracing caller is a
    # thread in the console.
    tracing = fabric_tracing()

    service = AgentService(
        # The three parts of the address: agents.prompt.echo.<owner>.<name>.
        agent="echo",
        owner=env.get("AGENT_OWNER") or env.get("USER") or "anon",
        session_name=env.get("AGENT_NAME", "main"),
        nc=nc,
        description="Answers every prompt with the prompt",
        # Signed: discovery shows this agent's identity as verified, and the
        # console lists the agent under it.
        identity=ServiceIdentity(signer=bundle.signer),
        interceptors=[tracing.request_interceptor],
        heartbeat_extras=tracing.heartbeat_extras,
    )

    # The whole agent. Every prompt runs this handler; what it sends is
    # streamed back to the caller.
    async def on_prompt(envelope: Envelope, stream: PromptStream) -> None:
        scope = active_trace()
        print(f"[{scope.thread_id[:8] if scope else 'untraced'}] prompt from {format_sender(stream.sender)}: {envelope.prompt}")
        await stream.send(f"echo: {envelope.prompt}")

    service.on_prompt(on_prompt)
    await service.start()
    print(f"echo agent listening on {service.subject.prompt}")
    print(f"identity: {service.identity or 'none'}")
    print("press Ctrl+C to stop")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    await service.stop()
    await nc.close()
    bundle.wipe()


if __name__ == "__main__":
    asyncio.run(main())
