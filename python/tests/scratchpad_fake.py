"""An in-memory ScratchPad behind the package's port, for the tests.

One volume, tokens in the reference agents' format, a ledger with expiries,
and every grant recorded. ``typescript/test/support/scratchpad.ts`` is its
twin.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any, cast

from synadia_ai.agents import Agent, Agents, AgentToolsPromptContext, AgentToolsReplyContext

from synadia_ai.agent_fabric import Grantee, GrantKind, TraceIds


@dataclass(frozen=True, slots=True)
class RecordedGrant:
    """One grant, as the fake saw it made."""

    reference: str
    grantee: str
    trace: TraceIds | None
    tool_call_id: str | None
    kind: GrantKind


def make_reference(volume_id: str, path: str, creator: str | None = None) -> str:
    """A token in the reference agents' format.

    ``sp-ref:`` + base64url(the ``ref.make`` reply + ``creator``), no padding.
    """
    made: dict[str, Any] = {
        "ref": {
            "type": "handoff",
            "handoff_id": f"h-{volume_id}-{path}",
            "volume_id": volume_id,
            "root": "r1",
            "path": path,
            "expires_at": 4_102_444_800,
        },
        "source_sequence": 1,
    }
    if creator is not None:
        made["creator"] = creator
    raw = json.dumps(made, separators=(",", ":")).encode()
    return "sp-ref:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _decode(reference: str) -> dict[str, Any]:
    body = reference[len("sp-ref:") :]
    return cast(
        "dict[str, Any]", json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    )


class MemoryScratchPad:
    """The fake. ``fail_grants`` makes ``grant_read`` raise; ``now`` moves time."""

    def __init__(self, volume_id: str, creator: str | None = None, ttl_s: int = 600) -> None:
        self.volume_id = volume_id
        self.creator = creator
        self.grants: list[RecordedGrant] = []
        self.fail_grants: str | None = None
        self.now = 1_000_000
        self._ttl_s = ttl_s
        # path → identity → kind → expiry
        self._ledger: dict[str, dict[str, dict[str, int]]] = {}
        self._commits = 0

    def commit(self, path: str | None = None) -> str:
        """ "Commit" something and return its reference."""
        self._commits += 1
        return make_reference(self.volume_id, path or f"/replies/{self._commits}.md", self.creator)

    def owns(self, reference: str) -> bool:
        try:
            return bool(_decode(reference)["ref"]["volume_id"] == self.volume_id)
        except (ValueError, KeyError, TypeError):
            return False

    def grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None,
        tool_call_id: str | None = None,
        kind: GrantKind = "first-hand",
    ) -> None:
        if not self.owns(reference):
            raise PermissionError("not this volume")
        if self.fail_grants is not None:
            raise RuntimeError(self.fail_grants)
        who = f"{grantee.account}.{grantee.user}"
        self.grants.append(RecordedGrant(reference, who, trace, tool_call_id, kind))
        path = _decode(reference)["ref"].get("path") or "/"
        self._ledger.setdefault(path, {}).setdefault(who, {})[kind] = self.now + self._ttl_s

    def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
        if not self.owns(reference):
            return None
        path = _decode(reference)["ref"].get("path") or "/"
        until = self._ledger.get(path, {}).get(f"{grantee.account}.{grantee.user}", {})
        if until.get("first-hand", 0) > self.now:
            return "first-hand"
        if until.get("on-request", 0) > self.now:
            return "on-request"
        return None


@dataclass
class StubAgent:
    """A discovered agent, as far as the extension looks at one."""

    prompt_subject: str
    identity: str | None = None
    verified: bool | None = None
    reads_references: bool = True

    @property
    def id_sig_verified(self) -> bool:
        return self.verified if self.verified is not None else self.identity is not None

    @property
    def metadata(self) -> dict[str, str]:
        return {"scratchpad_refs_ok": "true"} if self.reads_references else {}


@dataclass
class _Msg:
    data: bytes


@dataclass
class StubAgents:
    """An ``Agents`` stand-in: ``discover()`` returns ``discovered``;
    ``request_signed()`` answers ``answer`` (JSON text, or an exception to raise)."""

    discovered: list[Any] = field(default_factory=list)
    answer: str | BaseException = '{"granted":true}'
    requests: list[tuple[str, bytes]] = field(default_factory=list)
    discoveries: int = 0

    async def discover(self, **_kwargs: Any) -> list[Any]:
        self.discoveries += 1
        return list(self.discovered)

    async def request_signed(self, subject: str, payload: bytes, **_kwargs: Any) -> _Msg:
        self.requests.append((subject, payload))
        if isinstance(self.answer, BaseException):
            raise self.answer
        return _Msg(self.answer.encode())

    def as_agents(self) -> Agents:
        return cast("Agents", self)


def as_agent(stub: StubAgent) -> Agent:
    return cast("Agent", stub)


def prompt_context(
    target: StubAgent, prompt: str, tool_call_id: str | None = "toolu_1"
) -> AgentToolsPromptContext:
    """A prompt rewrite's context, as ``AgentTools`` hands it over."""
    return AgentToolsPromptContext(
        address=target.prompt_subject,
        prompt=prompt,
        attachments=(),
        target=as_agent(target),
        call_id="call_000000000000",
        label=None,
        tool_call_id=tool_call_id,
        caller=None,
    )


def reply_context(target: StubAgent, kind: Any, text: str) -> AgentToolsReplyContext:
    """A reply look's context."""
    return AgentToolsReplyContext(
        call_id="call_000000000000",
        address=target.prompt_subject,
        target=as_agent(target),
        kind=kind,
        text=text,
        attachments=(),
    )
