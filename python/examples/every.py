"""A list of topics, prompted one after another on an interval.

Each prompt is a task of its own; its root id is printed with the topic.

    NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds \
      uv run --with synadia-ai-agent-fabric python every.py writer 60 "the sea" "the moon"
"""

import asyncio
import contextlib
import itertools
import sys

from synadia_ai.agent_fabric import fabric_caller_from_env


async def main(who: str, seconds: float, topics: list[str]) -> None:
    async with await fabric_caller_from_env() as caller:
        for topic in itertools.cycle(topics):
            try:
                reply = await caller.ask(who, f"Write two lines about {topic}.")
                print(f"[{topic}] root {reply.root_id}\n{reply.text}\n", flush=True)
            except Exception as err:
                print(f"[{topic}] no reply: {err}", file=sys.stderr)
            await asyncio.sleep(seconds)


if __name__ == "__main__":
    if len(sys.argv) < 4 or not float(sys.argv[2]) > 0:
        sys.exit('usage: python every.py <address or kind> <seconds> "<topic>" ...')
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main(sys.argv[1], float(sys.argv[2]), sys.argv[3:]))
