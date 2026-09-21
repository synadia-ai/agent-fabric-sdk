"""Tracing for the Synadia Agent Fabric — the vocabulary shared by the caller and the host.

:mod:`synadia_ai.agent_fabric.tracing` builds the protocol SDK's hooks from
it. Mirrors ``typescript/src/trace.ts``; the two must stay wire-identical.

The ambient binding is what lets a client used as a tool inside a prompt
handler inherit lineage with no plumbing through user code: a
:class:`~contextvars.ContextVar` flows into awaited work and into tasks
created inside the bound scope.

A thread ID names one prompt execution: minted by the caller at
``prompt()`` time, 128-bit random as 32 lowercase hex characters, and
adopted by the receiving service. ``root_id`` has the same shape — it IS a
thread ID, the tree's first execution.
"""

from __future__ import annotations

import json
import re
import secrets
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from synadia_ai.agents import AgentId

# Bump every time you change the trace record schema
# (be sure the TypeScript package is updated in lockstep)
EDGE_RECORD_VERSION = 1

# Default subject edge records are published to — the tenant-side short
# form; the account's import qualifies it.
DEFAULT_EDGE_SUBJECT = "TRACE.edges"

#: The envelope fields that carry the lineage to the receiver.
THREAD_ID_FIELD = "thread_id"
ROOT_ID_FIELD = "root_id"

#: The headers an agent stamps on its model requests (see :func:`trace_headers`).
THREAD_ID_HEADER = "X-Synadia-Thread-ID"
ROOT_ID_HEADER = "X-Synadia-Root-ID"

# Spelled out rather than `\s`, which means different things in the two
# languages: JavaScript's includes U+FEFF and Python's does not, Python's
# includes the C0 separators and JavaScript's does not. An explicit class
# is the only way the two packages reject exactly the same subjects.
_SUBJECT_FORBIDDEN = re.compile(
    "[\x00-\x20\x7f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"
)


@dataclass(frozen=True, slots=True)
class TraceOptions:
    """Tracing configuration for :func:`~synadia_ai.agent_fabric.fabric_tracing`.

    ``edge_subject`` is where edge records are published; ``None`` selects
    propagate-only mode — mint IDs and forward lineage, but publish no
    edge records.
    """

    edge_subject: str | None = DEFAULT_EDGE_SUBJECT

    def __post_init__(self) -> None:
        # Publishing is fail-open, so a subject that can never be published
        # to would only ever show up as a warning on every prompt. Fail at
        # construction instead.
        subject = self.edge_subject
        if subject is None:
            return
        if not isinstance(subject, str) or not subject:
            raise ValueError(f"edge_subject must be a non-empty subject or None (got {subject!r})")
        for token in subject.split("."):
            if not token:
                raise ValueError(f"edge_subject {subject!r} must not contain an empty token")
            if _SUBJECT_FORBIDDEN.search(token):
                raise ValueError(
                    f"edge_subject {subject!r} must not contain whitespace or control characters"
                )
            if "*" in token or ">" in token:
                raise ValueError(f"edge_subject {subject!r} must not contain wildcards")


THREAD_ID_HEX_LEN = 32


@dataclass(frozen=True, slots=True)
class TraceRecordCounts:
    """How many trace records this process has published and dropped.

    ``edge`` records today, counted from process start. Process-wide, not
    per client: the records are written by whichever client a prompt
    handler happens to use, while the ``AgentService`` that owns the
    heartbeat is another object; one counter for the process is the one
    they share. The host reports both numbers as ``records_published`` and
    ``records_dropped`` in its heartbeat (``fabric_tracing().heartbeat_extras``),
    so whoever consumes the heartbeat knows how many records this process
    failed to publish.

    ``published`` counts records handed to the connection — handed, not
    delivered: a record lost after that (a reconnect buffer that
    overflowed, a process that exited before the flush) is not seen
    here. The counts cover what this process could observe; nothing past
    the connection is visible to them. ``dropped`` counts records that were
    due but never went out: no identity to sign them with, or a publish
    that raised. "Due" means the prompt the record describes actually
    went out — a prompt never iterated or rejected by validation owes no
    record and counts nothing. A record in propagate-only mode
    (``edge_subject=None``) is never due either.
    """

    published: int
    dropped: int


@dataclass(slots=True)
class _Counters:
    published: int = 0
    dropped: int = 0


_counters = _Counters()


def count_trace_record_published() -> None:
    """Count one trace record published. Called by the edge publisher."""
    _counters.published += 1


def count_trace_record_dropped() -> None:
    """Count one trace record dropped. Called by the edge publisher."""
    _counters.dropped += 1


def trace_record_counts() -> TraceRecordCounts:
    """A snapshot of the process-wide :class:`TraceRecordCounts`."""
    return TraceRecordCounts(published=_counters.published, dropped=_counters.dropped)


#: Longest accepted tool call id, in Unicode code points.
TOOL_CALL_ID_MAX = 256

_THREAD_ID_RE = re.compile(rf"[0-9a-f]{{{THREAD_ID_HEX_LEN}}}")


def is_thread_id(value: str) -> bool:
    """``True`` iff ``value`` has the shape of a thread ID.

    Exactly :data:`THREAD_ID_HEX_LEN` lowercase hex characters. Ids arriving
    on the wire are untrusted input that ends up in the headers an agent
    stamps on its model requests, so a receiver adopts nothing that is not
    shaped exactly like what the packages mint.
    """
    return _THREAD_ID_RE.fullmatch(value) is not None


@dataclass(frozen=True, slots=True)
class TraceScope:
    """Identity of the prompt execution running in the current context."""

    #: This execution's own thread ID — the parent of any thread it spawns.
    thread_id: str
    #: The tree's root thread ID, inherited unchanged; equals ``thread_id`` on a root.
    root_id: str
    # Where in this execution any thread it spawns next was sent out: how
    # many times it has stamped trace headers on a model request so far.
    # Deliberately a mutable cell inside a frozen scope: a task spawned
    # inside the handler gets a copy of the context but shares this
    # object, so its turns count against the same execution.
    # Excluded from equality and hashing: a frozen dataclass advertises
    # itself as hashable, and a mutable field would make hash() raise. It
    # is running state, not identity — two scopes naming the same
    # execution are the same scope whatever their counters read.
    turn_count_hint: list[int] = field(default_factory=lambda: [0], compare=False)


_active_scope: ContextVar[TraceScope | None] = ContextVar(
    "synadia_ai.agent_fabric.trace_scope", default=None
)


@contextmanager
def bind_active_trace(scope: TraceScope) -> Iterator[None]:
    """Bind ``scope`` as the ambient execution for the block.

    What the host interceptor does around a prompt handler. The previous
    binding is restored on exit, so nothing leaks into the next request.
    """
    token = _active_scope.set(scope)
    try:
        yield
    finally:
        _active_scope.reset(token)


def active_trace() -> TraceScope | None:
    """The ambient :class:`TraceScope`, or ``None`` outside a bound handler."""
    return _active_scope.get()


def trace_headers() -> dict[str, str]:
    """Headers for every model request this execution issues.

    An agent stamps these on each completion request so the model proxy
    files the call under the right thread and tree without seeing any
    NATS traffic. Hierarchy is the edge records' job, so the proxy needs
    no parent or tool-call header.

    ``{}`` outside a traced handler, so harness code needs no plumbing and
    degrades to nothing.

    Each call counts against this execution: the running total is
    recorded on the edge of any thread it spawns afterwards.
    """
    scope = active_trace()
    if scope is None:
        return {}
    scope.turn_count_hint[0] += 1
    return {
        THREAD_ID_HEADER: scope.thread_id,
        ROOT_ID_HEADER: scope.root_id,
    }


def random_thread_id() -> str:
    # Thread IDs don't need to be secure and any random generator will suffice.
    # Still, using secrets.token_hex() doesn't cost us much.
    return secrets.token_hex(THREAD_ID_HEX_LEN // 2)


def valid_tool_call_id(tool_call_id: str) -> bool:
    # This isn't intended as strict validation. It's just a basic
    # pass to avoid obvious garbage gets into the tracing system.
    # `len()` counts code points, which is what the TypeScript package
    # counts too, so the two accept exactly the same ids.
    if not 0 < len(tool_call_id) <= TOOL_CALL_ID_MAX:
        return False
    # A lone surrogate has no UTF-8 form: the record could not be encoded,
    # and TypeScript rejects it for the same reason.
    try:
        tool_call_id.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def build_edge_record(
    agent: AgentId,
    thread_id: str,
    parent_id: str | None,
    root_id: str,
    tool_call_id: str | None,
    turn_count_hint: int,
) -> tuple[str, bytes]:
    """One edge record, ready to publish: its record id and its wire bytes.

    The publisher signs with the record id as the ``Agent-Sender`` nonce,
    which the SDK's signed publish also stamps as ``Nats-Msg-Id``, so body,
    header and message id carry one id and a stream de-duplicates a record
    it already stored. Its 32 hex characters fit the nonce's
    ``[A-Za-z0-9_-]{1,64}``.

    ``agent`` is the writer — the caller that spawned the thread, the
    parent side of the edge — in canonical ``{account}.{user}`` form. It is
    the same identity that signs the record's ``Agent-Sender`` header, so a
    consumer can cross-check the body against the verified header.
    """
    # `turn_count_hint` says where in the spawning thread this subprompt
    # went out: turns completed when it was spawned, 0 on a root (nothing
    # spawned it). A position marker, not a total — turns the parent takes
    # after its last spawn are recorded nowhere.
    record_id = random_thread_id()
    record = {
        "version": EDGE_RECORD_VERSION,
        "kind": "edge",
        "record_id": record_id,
        "ts": int(time.time()),
        "agent": str(agent),
        "thread_id": thread_id,
        "parent_id": parent_id,
        "root_id": root_id,
        "tool_call_id": tool_call_id,
        "turn_count_hint": turn_count_hint,
    }
    # `ensure_ascii=False`: `JSON.stringify` writes non-ASCII text raw, and
    # the two packages must write byte-identical records.
    return record_id, json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
