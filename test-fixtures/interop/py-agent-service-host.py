"""A minimal ``AgentService`` host for cross-language and cross-version tracing interop tests.

Adapted from the protocol SDK's host of the same name at synadia-agents
c9d7bcb, where tracing still lived in the SDK. Run with the interpreter of
the packages under test: this repo's ``python`` project (``uv run
--project python``) for the fabric and the protocol SDK it builds on, or a
scratch venv holding the last published (pre-tracing) protocol SDK — the
script uses only API that exists in both, and imports the fabric only
when asked to trace.

Environment:
    NATS_URL             server to connect to (required)
    AGENT                ``agent`` token (default ``interop-host``)
    TRACE=1              run the fabric's request interceptor and heartbeat
                         extras (``synadia_ai.agent_fabric``); otherwise the
                         host is the protocol SDK alone
    NATS_NKEY_SEED_FILE  authenticate the connection with this user seed
    NATS_CREDS_FILE      authenticate the connection with this .creds file

Echo: ``echo: <prompt>`` plus `` thread=<id> root=<id>`` when the execution
was traced, so a caller can see what the host adopted or minted.
"""

from __future__ import annotations

import asyncio
import os
import signal
from collections.abc import Callable
from pathlib import Path
from typing import Any

import nats
from synadia_ai.agent_service import AgentService


async def main() -> None:
    url = os.environ["NATS_URL"]
    agent = os.environ.get("AGENT", "interop-host")
    seed_file = os.environ.get("NATS_NKEY_SEED_FILE")
    creds_file = os.environ.get("NATS_CREDS_FILE")
    connect_kwargs: dict[str, Any] = {}
    if seed_file:
        connect_kwargs["nkeys_seed_str"] = Path(seed_file).read_text(encoding="utf-8").strip()
    if creds_file:
        connect_kwargs["user_credentials"] = creds_file
    nc = await nats.connect(url, allow_reconnect=False, **connect_kwargs)

    kwargs: dict[str, Any] = {}
    trace_headers: Callable[[], dict[str, str]] = dict
    if os.environ.get("TRACE") == "1":
        # Imported only here: a host run on a pre-tracing interpreter has no fabric.
        from synadia_ai.agent_fabric import fabric_tracing  # noqa: PLC0415
        from synadia_ai.agent_fabric import trace_headers as fabric_trace_headers  # noqa: PLC0415

        tracing = fabric_tracing()
        kwargs["interceptors"] = [tracing.request_interceptor]
        kwargs["heartbeat_extras"] = tracing.heartbeat_extras
        trace_headers = fabric_trace_headers

    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="interop",
        session_name="host",
        heartbeat_interval_s=5,
        keepalive_interval_s=None,
        **kwargs,
    )

    async def handler(envelope: Any, stream: Any) -> None:
        headers = trace_headers()
        text = f"echo: {envelope.prompt}"
        thread = headers.get("X-Synadia-Thread-ID")
        if thread is not None:
            text += f" thread={thread} root={headers.get('X-Synadia-Root-ID', '')}"
        await stream.send(text)

    svc.on_prompt(handler)
    await svc.start()
    subject = getattr(svc, "subject", None)
    prompt_subject = (
        subject.prompt if subject is not None else f"agents.prompt.{agent}.interop.host"
    )
    print(f"agent service listening on {prompt_subject}", flush=True)

    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        try:
            await svc.stop()
        finally:
            await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
