"""A reply as a string, for a script.

``ask()`` waits for the whole reply and returns it with the task's root id.

    NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds \
      uv run --with synadia-ai-agent-fabric python ask.py writer "Name three rivers."
"""

import asyncio
import json
import sys

from synadia_ai.agent_fabric import fabric_caller_from_env


async def main(who: str, text: str) -> None:
    async with await fabric_caller_from_env() as caller:
        reply = await caller.ask(who, text)
        words = len(reply.text.split())
        print(json.dumps({"root": reply.root_id, "words": words, "text": reply.text}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit('usage: python ask.py <address or kind> "<text>"')
    asyncio.run(main(sys.argv[1], " ".join(sys.argv[2:])))
