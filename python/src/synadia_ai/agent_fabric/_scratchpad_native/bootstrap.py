"""An exact public creation descriptor, separate from the writer workspace."""

from __future__ import annotations

import os
import stat

from . import protocol as p
from .errors import NativeScratchPadError, invalid

MAX_BOOTSTRAP_BYTES = 4096


def decode_scratchpad_bootstrap(data: bytes | str) -> p.Wire:
    """Strictly decode request data; no field supplies authentication authority."""
    value = p.record(
        p.parse_strict_json(data, MAX_BOOTSTRAP_BYTES),
        ("version", "principal", "volume", "admission", "creation"),
    )
    p.check(
        type(value["version"]) is int and value["version"] == 1, "unsupported bootstrap version"
    )
    p.validate_principal(value["principal"])
    p.validate_volume(value["volume"])
    p.validate_admission_binding(value["admission"])
    p.validate_action(value["creation"])
    return value


def read_scratchpad_bootstrap_file(path: str | os.PathLike[str]) -> p.Wire:
    """Read a bounded regular file without blocking on a FIFO or following a symlink."""
    fd: int | None = None
    try:
        p.check(bool(os.fspath(path)), "bootstrap file path is required")
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0))
        status = os.fstat(fd)
        p.check(stat.S_ISREG(status.st_mode), "bootstrap must be a regular file")
        p.check(status.st_size <= MAX_BOOTSTRAP_BYTES, "bootstrap exceeds its byte bound")
        data = bytearray()
        while len(data) <= MAX_BOOTSTRAP_BYTES:
            part = os.read(fd, MAX_BOOTSTRAP_BYTES + 1 - len(data))
            if not part:
                break
            data.extend(part)
        return decode_scratchpad_bootstrap(bytes(data))
    except NativeScratchPadError:
        raise
    except (OSError, TypeError, ValueError) as error:
        raise invalid("cannot read ScratchPad bootstrap file", error) from error
    finally:
        if fd is not None:
            os.close(fd)
