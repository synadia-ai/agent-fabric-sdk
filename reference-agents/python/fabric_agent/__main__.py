"""Start one agent from the environment and run until told to stop.

    uv run python -m fabric_agent            # reads .env next to pyproject.toml when present
    uv run python -m fabric_agent path.env   # or a named file

``env.example`` lists every variable. Values already in the process
environment win over the file's.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from pathlib import Path

from .agent import start_agent
from .config import load_config, load_env_file


async def main() -> None:
    # Line-buffered output, so a log file a supervisor redirects to follows
    # the agent live; Python buffers a redirected stdout in blocks otherwise.
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    env_file = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / ".env"
    env = dict(os.environ)
    if env_file.exists():
        env = {**load_env_file(env_file), **env}
    cfg = load_config(env)
    agent = await start_agent(cfg, env=env)
    print(f"{cfg.agent.kind} agent listening on {agent.address}")
    print(f"identity: {agent.identity or 'none'}")
    print(f"model: {cfg.model.model} through {cfg.model.proxy_url}")
    print(f"scratchpad: {env.get('SCRATCHPAD_VOLUME') or 'off'}")
    print("press Ctrl+C to stop (the conversation lives in memory and is gone on restart)")

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    print("\nshutting down…")
    await agent.stop()


if __name__ == "__main__":
    asyncio.run(main())
