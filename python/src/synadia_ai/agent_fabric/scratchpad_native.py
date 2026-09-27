"""Native ScratchPad access through NATS, with no shell or ``sp`` executable.

Native operations require Python 3.12+. The other Fabric SDK features retain
their Python 3.11 requirement. Preserve each writer's private directory across
restarts and close its client before shutdown. The caller owns the connection.
"""

from ._scratchpad_native.client import (
    NativeScratchPad,
    native_scratchpad,
    native_scratchpad_from_env,
)
from ._scratchpad_native.errors import NativeScratchPadError
from ._scratchpad_native.reader import (
    DEFAULT_READ_LIMIT_BYTES,
    ScratchPadReader,
    scratchpad_reader,
)

__all__ = [
    "DEFAULT_READ_LIMIT_BYTES",
    "NativeScratchPad",
    "NativeScratchPadError",
    "ScratchPadReader",
    "native_scratchpad",
    "native_scratchpad_from_env",
    "scratchpad_reader",
]
