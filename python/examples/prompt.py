"""One prompt: the reply streamed as it comes, then the root id of the task it started.

The root id is how the console finds that task.

    NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds \
      uv run --with synadia-ai-agent-fabric python prompt.py writer "Say hello."
"""

import asyncio
import sys

from synadia_ai.agents import ResponseChunk

from synadia_ai.agent_fabric import fabric_caller_from_env


async def main(who: str, text: str) -> None:
    async with await fabric_caller_from_env() as caller:
        started = await caller.prompt(who, text)
        async for msg in started.stream:
            if isinstance(msg, ResponseChunk):
                print(msg.text, end="", flush=True)
        print(f"\nroot {await started.root_id}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit('usage: python prompt.py <address or kind> "<text>"')
    asyncio.run(main(sys.argv[1], " ".join(sys.argv[2:])))
