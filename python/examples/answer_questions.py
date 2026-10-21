"""An agent may ask a question before it answers; ``on_query`` answers it.

Here from the terminal, one line per question.

    NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds \
      uv run --with synadia-ai-agent-fabric python answer_questions.py writer "Write me a poem."
"""

import asyncio
import sys

from synadia_ai.agents import Query

from synadia_ai.agent_fabric import fabric_caller_from_env


async def from_terminal(query: Query) -> str:
    print(f"{query.prompt}\n> ", end="", file=sys.stderr, flush=True)
    line = await asyncio.get_running_loop().run_in_executor(None, sys.stdin.readline)
    return line.strip()


async def main(who: str, text: str) -> None:
    async with await fabric_caller_from_env() as caller:
        reply = await caller.ask(who, text, on_query=from_terminal)
        print(reply.text)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit('usage: python answer_questions.py <address or kind> "<text>"')
    asyncio.run(main(sys.argv[1], " ".join(sys.argv[2:])))
