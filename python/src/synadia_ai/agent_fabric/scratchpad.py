"""ScratchPad references — the vocabulary of handing content over by reference.

And the port the agent's own ScratchPad client plugs into. Mirrors
``typescript/src/scratchpad.ts``.

A reference is one opaque token: service-issued ``sp-r1:`` or the existing
expanded ``sp-ref:`` form. Models copy it unchanged; clients resolve metadata.
Neither form grants authority. ScratchPad authenticates every reader and checks
current grants. The creator is a routing claim that discovery verifies.

The rules the fabric keeps around references (the reference agents'
``tools/README.md``, ``agent-fabric`` ``docs/agent-tools.md`` §2.2):

- who reads references says so, with ``scratchpad_refs_ok: "true"`` in its
  service metadata; a reference goes to no other agent;
- an agent hands on only a reference it was given: it committed it, or it
  arrived in a prompt it served or a reply it received;
- least authority: one grantee, one path, read only, a short expiry, granted
  immediately before the reference goes out;
- being allowed to read is not being allowed to pass on: only a volume's
  owner grants, so an agent that wants to hand on another agent's reference
  asks its creator (:mod:`synadia_ai.agent_fabric.grant_request`).

This package holds that policy. It does not talk to ScratchPad: the agent
brings its own client, behind the :class:`ScratchPad` port.
"""

from __future__ import annotations

import base64
import binascii
import inspect
import json
import re
from collections.abc import Awaitable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypeVar, runtime_checkable

#: Prefix of the expanded reference token.
REFERENCE_PREFIX = "sp-ref:"

SHORT_REFERENCE_PREFIX = "sp-r1:"

_REFERENCE_RE = re.compile(r"sp-(?:ref|r1):[A-Za-z0-9_-]+")

#: The service metadata key an agent that reads the references it is handed
#: registers, with the value ``"true"`` (the SDK's ``extra_metadata``). A
#: caller hands a reference, and grants read on it, only to an agent that says
#: so. In the style of the protocol's ``attachments_ok``.
READS_REFERENCES_KEY = "scratchpad_refs_ok"

#: How a grant came about. ``first-hand``: the agent granted an agent it
#: handed the reference itself — the verified caller of its reply, or the
#: agent it prompted with a reference of its own. ``on-request``: the agent
#: granted an agent because another agent asked it to
#: (:mod:`~synadia_ai.agent_fabric.grant_request`). Only a first-hand grant
#: entitles its holder to ask for another agent, or access could be relayed
#: from agent to agent without end.
GrantKind = Literal["first-hand", "on-request"]


@dataclass(frozen=True, slots=True)
class TraceIds:
    """The served prompt's thread and root, as :func:`active_trace` reports them."""

    thread_id: str
    root_id: str


@dataclass(frozen=True, slots=True)
class Grantee:
    """The principal ScratchPad grants to: the two halves of an agent identity.

    ``<account>.<user>``, both public NKEYs on the fabric.
    """

    account: str
    user: str


class ScratchPad(Protocol):
    """What the policy needs of the agent's ScratchPad: its own volume, and a
    ledger of the read grants it made.

    ScratchPad knows the grants but not how they came about; that is the
    agent's own knowledge, so the implementation keeps the ledger. Each
    method may be a coroutine or a plain function.
    """

    def owns(self, reference: str) -> Awaitable[bool] | bool:
        """Whether ``reference`` points into this agent's own volume, where it may grant."""
        ...

    def grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None,
        tool_call_id: str | None = None,
        kind: GrantKind = "first-hand",
    ) -> Awaitable[None] | None:
        """Grant ``grantee`` read on the one path ``reference`` names, until the
        grant's expiry, and note it in the ledger as ``kind``.

        Only for a reference into this agent's own volume. ``trace`` and
        ``tool_call_id`` label the grant, so it shows under the served prompt
        and the tool call that caused it.
        """
        ...

    def granted(
        self, reference: str, grantee: Grantee
    ) -> Awaitable[GrantKind | None] | GrantKind | None:
        """The live grant this agent made to ``grantee`` on what ``reference``
        points at, by kind; ``None`` when there is none or it has expired.

        A first-hand grant still running is not hidden by a later one made on
        request.
        """
        ...


@runtime_checkable
class ResolvesReferences(Protocol):
    """Optional metadata operation on a ScratchPad port; old ports remain valid."""

    def resolve_reference(
        self, reference: str, trace: TraceIds | None = None
    ) -> Awaitable[dict[str, Any]] | dict[str, Any]: ...


def find_references(text: str) -> list[str]:
    """Every reference token in ``text``, in order, repeats included."""
    return _REFERENCE_RE.findall(text)


def remove_references(text: str, only: Sequence[str] | None = None) -> str:
    """``text`` with reference tokens taken out — every one, or only those in
    ``only`` — and the trailing spaces and extra blank lines that leaves
    behind tidied away."""
    text = _REFERENCE_RE.sub(
        lambda m: "" if only is None or m.group(0) in only else m.group(0), text
    )
    text = re.sub(r"[ \t]+$", "", text, flags=re.MULTILINE)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def reference_creator(reference: str) -> str | None:
    """The prompt address of the agent that made ``reference``, as the token says.

    ``None`` for a token that names none or does not decode.
    """
    if not reference.startswith(REFERENCE_PREFIX):
        return None
    body = reference[len(REFERENCE_PREFIX) :]
    try:
        made = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (binascii.Error, ValueError):
        return None
    creator = made.get("creator") if isinstance(made, dict) else None
    return creator if isinstance(creator, str) and creator else None


def reads_references(metadata: Mapping[str, str]) -> bool:
    """Whether an agent's registration metadata says it reads references."""
    return metadata.get(READS_REFERENCES_KEY) == "true"


def grantee_from_identity(identity: str) -> Grantee:
    """The grantee behind an identity as discovery or a verified sender reports it.

    Raises :class:`ValueError` for anything that is not ``<account>.<user>``.
    """
    # The account half never contains a dot (an NKEY, a config-file account
    # name, or `$G`), so the first dot is the split.
    account, dot, user = identity.partition(".")
    if not dot or not account or not user:
        raise ValueError(f"not an agent identity: {identity}")
    return Grantee(account=account, user=user)


_T = TypeVar("_T")


async def _resolve(value: Awaitable[_T] | _T) -> _T:
    """The value of a port method that may or may not be a coroutine."""
    if inspect.isawaitable(value):
        return await value
    return value


__all__ = [
    "READS_REFERENCES_KEY",
    "REFERENCE_PREFIX",
    "SHORT_REFERENCE_PREFIX",
    "GrantKind",
    "Grantee",
    "ResolvesReferences",
    "ScratchPad",
    "TraceIds",
    "find_references",
    "grantee_from_identity",
    "reads_references",
    "reference_creator",
    "remove_references",
]
