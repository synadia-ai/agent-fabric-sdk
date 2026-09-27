"""Request failures with an explicit mutation-outcome boundary."""

from __future__ import annotations


class NativeScratchPadError(RuntimeError):
    """An unknown mutation may have succeeded; preserve its saved intent."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        unknown: bool = False,
        local: bool = False,
        cause: BaseException | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.unknown = unknown
        self.local = local
        if cause is not None:
            self.__cause__ = cause


def invalid(message: str, cause: BaseException | None = None) -> NativeScratchPadError:
    return NativeScratchPadError("invalid", message, local=True, cause=cause)


def failed(
    mutation: bool, message: str, cause: BaseException | None = None
) -> NativeScratchPadError:
    return NativeScratchPadError(
        "unknown" if mutation else "corrupt", message, unknown=mutation, cause=cause
    )
