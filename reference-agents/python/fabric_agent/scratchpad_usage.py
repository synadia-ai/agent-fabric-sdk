"""Read-only volume diagnostics, offered to the model for native clients."""

from __future__ import annotations

import json
from typing import Any

from synadia_ai.agent_fabric import NativeScratchPadError, ScratchPadClient

from .model import ToolRunner

SCRATCHPAD_USAGE_TOOL = "scratchpad_usage"
USAGE_DESCRIPTION = "Read this agent's ScratchPad volume allowance and current charged usage without changing it. Bytes are encoded chunks and metadata, including retained history and reservations; objects are not files. Ordinary headroom is an observation, not a guarantee that a write fits. Removal reserve is separate. An unbound workspace has unknown usage, not zero usage. No arguments or credentials are accepted."


class ScratchPadUsage:
    """Add a read-only model tool without changing reply delivery policy."""

    def __init__(self, runner: ToolRunner, client: ScratchPadClient | None = None) -> None:
        self._runner = runner
        self._inspect = getattr(client, "diagnostics", None)
        self.definitions = list(runner.definitions)
        if callable(self._inspect):
            self.definitions.append(
                {
                    "type": "function",
                    "function": {
                        "name": SCRATCHPAD_USAGE_TOOL,
                        "description": USAGE_DESCRIPTION,
                        "strict": False,
                        "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
                    },
                }
            )

    async def call(self, name: str, args: Any, tool_call_id: str) -> str:
        if name != SCRATCHPAD_USAGE_TOOL or not callable(self._inspect):
            return await self._runner.call(name, args, tool_call_id)
        try:
            value = ({} if args.strip() == "" else json.loads(args)) if isinstance(args, str) else args
            if not isinstance(value, dict) or value:
                return json.dumps({"status": "invalid", "code": "invalid_arguments"})
        except (ValueError, TypeError):
            return json.dumps({"status": "invalid", "code": "invalid_arguments"})
        try:
            return json.dumps(await self._inspect())
        except Exception as error:
            # Raw transport errors can contain paths or credentials.
            return json.dumps(
                {
                    "status": "error",
                    "code": error.code if isinstance(error, NativeScratchPadError) else "unavailable",
                }
            )
