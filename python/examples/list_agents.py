"""The agents your creds file can reach.

Each with its address, its kind, and whether its identity is verified.

    NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds \
      uv run --with synadia-ai-agent-fabric python list_agents.py
"""

import asyncio
import unicodedata

from synadia_ai.agent_fabric import fabric_caller_from_env


def plain(text: object) -> str:
    """Text an agent registered, as it can be printed.

    It is the agent's own text. Before it reaches your terminal, each control,
    invisible or space character in it becomes a plain space (the zero width
    joiner and non-joiner stay), and half a character becomes U+FFFD: so an
    escape sequence in a kind or an address is printed, never run.
    ``agent-fabric agents`` prints its rows the same way.
    """
    line = []
    for ch in str(text):
        category = unicodedata.category(ch)
        if category == "Cs":
            line.append("\ufffd")
        elif ch in "\u200c\u200d":
            line.append(ch)
        else:
            line.append(" " if category in ("Cc", "Cf", "Zl", "Zp", "Zs") else ch)
    return "".join(line)


async def main() -> None:
    async with await fabric_caller_from_env() as caller:
        for agent in await caller.list():
            identity = (
                f"agent {agent.identity}" if agent.identity is not None else "agent identity: none"
            )
            verified = ", verified" if agent.id_sig_verified else ""
            row = (agent.prompt_subject, agent.agent, f"{identity}{verified}")
            print("\t".join(plain(field) for field in row))


if __name__ == "__main__":
    asyncio.run(main())
