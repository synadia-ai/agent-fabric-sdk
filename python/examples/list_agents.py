"""The agents your creds file can reach.

Each with its address, its kind, and whether its identity is verified.

    NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds \
      uv run --with synadia-ai-agent-fabric python list_agents.py
"""

import asyncio

from synadia_ai.agent_fabric import fabric_caller_from_env


async def main() -> None:
    async with await fabric_caller_from_env() as caller:
        for agent in await caller.list():
            identity = (
                f"agent {agent.identity}" if agent.identity is not None else "agent identity: none"
            )
            verified = ", verified" if agent.id_sig_verified else ""
            print(f"{agent.prompt_subject}\t{agent.agent}\t{identity}{verified}")


if __name__ == "__main__":
    asyncio.run(main())
