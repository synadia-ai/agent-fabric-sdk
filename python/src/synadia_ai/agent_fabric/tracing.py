"""Tracing on the protocol SDK's hooks.

:func:`fabric_tracing` returns the three things the SDK takes — a prompt
interceptor for ``Agents``, a request interceptor and a heartbeat extras
provider for ``AgentService`` — built from the vocabulary in
:mod:`synadia_ai.agent_fabric.trace`. Mirrors ``typescript/src/tracing.ts``;
the two must stay wire-identical.

The caller side, per prompt:

- phase one (``before_prompt``, in the context ``prompt()`` was called in)
  mints the new thread's ID and inherits root and parent from the ambient
  scope — a root when none is bound — and adds ``thread_id`` and
  ``root_id`` to the envelope. The parent stays in the edge record and
  never transits the child;
- phase two (``before_publish``, after the prompt is signed and its size
  checked, immediately before it is published) builds and publishes the
  signed edge record, so an observer sees the node before it runs and a
  prompt that never goes out owes no record.

The host side, per request: adopt the envelope's pair, mint a root when
there is none, refuse a half pair or a malformed ID with ``400`` before the
handler runs, and run the handler inside the scope — which is what
:func:`~synadia_ai.agent_fabric.trace_headers` reads, and what a traced
client used inside the handler inherits. The host writes no record.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING
from weakref import WeakSet

from synadia_ai.agent_service import CallNext, RequestInterceptorContext, RequestRejectedError
from synadia_ai.agents import PromptExtras, PromptInterceptorContext

from .trace import (
    DEFAULT_EDGE_SUBJECT,
    ROOT_ID_FIELD,
    THREAD_ID_FIELD,
    THREAD_ID_HEX_LEN,
    TraceOptions,
    TraceScope,
    active_trace,
    bind_active_trace,
    build_edge_record,
    count_trace_record_dropped,
    count_trace_record_published,
    is_thread_id,
    random_thread_id,
    trace_record_counts,
    valid_tool_call_id,
)

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient

log = logging.getLogger("synadia_ai.agent_fabric")

#: The key of ``Agent.prompt(context=...)`` the caller interceptor reads the tool call ID from.
TOOL_CALL_ID_CONTEXT_KEY = "tool_call_id"


@dataclass(frozen=True, slots=True)
class _EdgePlan:
    """What phase one decided to record; built into a record in phase two.

    The lineage is fixed when the prompt is planned — that is when the
    ambient trace is still the caller's — but the record's ``ts`` must say
    when the prompt actually went out and its ``agent`` is whoever signs
    it, so the bytes are produced immediately before the publish.
    """

    thread_id: str
    parent_id: str | None
    root_id: str
    tool_call_id: str | None
    turn_count_hint: int


class TracingPromptInterceptor:
    """The caller side: two envelope fields in phase one, the edge record in phase two."""

    def __init__(self, edge_subject: str | None) -> None:
        self._edge_subject = edge_subject

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras:
        # Tracing is best-effort and shouldn't stop an agent from sending
        # out a prompt. Invalid tool call ids are just ignored.
        raw = ctx.context.get(TOOL_CALL_ID_CONTEXT_KEY)
        tool_call_id = raw if isinstance(raw, str) and valid_tool_call_id(raw) else None
        plan = _mint_lineage(tool_call_id)
        # The envelope carries only what the receiver must inherit; the
        # parent stays in the edge record and never transits the child.
        return PromptExtras(
            fields={THREAD_ID_FIELD: plan.thread_id, ROOT_ID_FIELD: plan.root_id},
            state=plan,
        )

    async def before_publish(
        self, ctx: PromptInterceptorContext, extras: PromptExtras | None
    ) -> None:
        subject = self._edge_subject
        if subject is None or extras is None or not isinstance(extras.state, _EdgePlan):
            return
        await _publish_edge(ctx, subject, extras.state)


def _mint_lineage(tool_call_id: str | None) -> _EdgePlan:
    # The thread ID names this prompt's execution. Inside a prompt handler
    # the ambient trace supplies the tree root and this prompt's parent;
    # with none bound, the prompt starts its own tree.
    thread_id = random_thread_id()
    ambient = active_trace()
    if ambient is None:
        return _EdgePlan(thread_id, None, thread_id, tool_call_id, 0)
    return _EdgePlan(
        thread_id,
        ambient.thread_id,
        ambient.root_id,
        tool_call_id,
        ambient.turn_count_hint[0],
    )


# Connections already warned that their edge records go nowhere. One
# warning per connection: a per-prompt log would itself be a way for
# observability to disturb an agent.
_warned_unsigned: WeakSet[NATSClient] = WeakSet()


async def _publish_edge(ctx: PromptInterceptorContext, subject: str, plan: _EdgePlan) -> None:
    """Build and publish one signed edge record.

    The signature covers the short-form subject the record is published
    to: per the identity design a remap that only drops the account token
    is not a rename, so no ``sub`` override is needed. Consumers verify in
    stored mode. The record's ``agent`` is the client's own identity — the
    one that signs it — so body and header agree. Its ``record_id`` is the
    header's nonce and, through the SDK's signed publish, the
    ``Nats-Msg-Id`` as well: one id, so a reader de-duplicating on
    ``(user, record_id)`` and a stream de-duplicating on the message id see
    the same record once.

    Fail-open — tracing never fails a prompt. It is counted: every record
    that goes out or fails to moves the process-wide
    :func:`~synadia_ai.agent_fabric.trace_record_counts`, which the host
    reports on its heartbeat.
    """
    if not ctx.identity.can_sign:
        # Consumers ignore unsigned records, so publishing without a
        # signer would be pure waste: warn once per connection and skip.
        # Minting and envelope lineage need no identity and still happen,
        # so downstream agents that do have one keep tracing. Due now — the
        # prompt is about to go out — and cannot go out: a drop, reported
        # on the heartbeat as a record that was owed and never sent.
        # Counted here rather than when the prompt was planned, so a prompt
        # that is never sent counts nothing.
        _warn_unsigned(ctx.connection)
        count_trace_record_dropped()
        return
    try:
        agent = await ctx.identity.self_id()
        record_id, payload = build_edge_record(
            agent,
            plan.thread_id,
            plan.parent_id,
            plan.root_id,
            plan.tool_call_id,
            plan.turn_count_hint,
        )
        await ctx.identity.publish_signed(subject, payload, nonce=record_id)
        count_trace_record_published()
    except Exception:
        count_trace_record_dropped()
        log.exception("failed to publish edge record on %s", subject)


def _warn_unsigned(nc: NATSClient) -> None:
    if nc in _warned_unsigned:
        return
    _warned_unsigned.add(nc)
    log.warning(
        "tracing is enabled but no identity signer is configured; edge "
        "records are not published (consumers ignore unsigned records). "
        "Pass identity=Identity(signer=...) to sign them."
    )


class TracingRequestInterceptor:
    """The host side: this execution's ``(thread, root)``, bound around the rest of the request.

    Adopted from the envelope or minted; the host writes no trace record.
    """

    async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
        with bind_active_trace(_scope_for(ctx.envelope.extras)):
            await call_next()


def _scope_for(extras: Mapping[str, object]) -> TraceScope:
    """The execution's scope from the envelope's lineage pair.

    Adopted verbatim when both fields are there, a fresh root when neither
    is. A half pair is never completed. The pair travels together: a
    caller that traces sends both, one that does not sends neither.
    Exactly one names a broken or hand-written caller, and adopting the
    lone field would file this execution under a tree the caller never
    named, or root a thread the caller meant as a child — so it is a
    malformed envelope, the same ``400`` as a wrongly shaped id, before the
    handler runs. The TypeScript package reads the wire the same way.
    """
    thread_id = _lineage_field(extras, THREAD_ID_FIELD)
    root_id = _lineage_field(extras, ROOT_ID_FIELD)
    if (thread_id is None) != (root_id is None):
        # The pre-split SDK's decoder said the same.
        raise RequestRejectedError(
            400, "malformed envelope: thread_id and root_id must be given together"
        )
    if thread_id is not None and root_id is not None:
        return TraceScope(thread_id, root_id)
    minted = random_thread_id()
    return TraceScope(minted, minted)


def _lineage_field(extras: Mapping[str, object], wire_name: str) -> str | None:
    """One lineage field, ``None`` when the key is missing or ``null``.

    A present-but-not-a-string value is a malformed envelope (400), the
    same as any other wrongly-typed field — and the same as the TypeScript
    package. Silently dropping it would make the receiver mint a fresh root
    and file the execution under a tree of its own.
    """
    value = extras.get(wire_name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise RequestRejectedError(400, f"malformed envelope: {wire_name} must be a string")
    # An empty id names nothing. Treating it as absent keeps a receiver
    # from adopting "" as a thread and filing every child under it — and
    # keeps both packages reading the same wire the same way.
    if not value:
        return None
    # Untrusted, bounded input: the id is adopted verbatim and later
    # stamped on the agent's model requests as a header value, so anything
    # not shaped like a minted id (a CRLF, a megabyte of garbage) is
    # malformed.
    if not is_thread_id(value):
        raise RequestRejectedError(
            400,
            f"malformed envelope: {wire_name} must be {THREAD_ID_HEX_LEN} lowercase hex characters",
        )
    return value


def _record_counts() -> dict[str, object]:
    counts = trace_record_counts()
    return {"records_published": counts.published, "records_dropped": counts.dropped}


def _no_counts() -> dict[str, object]:
    return {}


@dataclass(frozen=True, slots=True)
class FabricTracing:
    """What :func:`fabric_tracing` returns: the SDK's three hooks, ready to pass in."""

    #: For the caller: ``Agents(..., interceptors=[tracing.prompt_interceptor])``.
    prompt_interceptor: TracingPromptInterceptor
    #: For the host: ``AgentService(..., interceptors=[tracing.request_interceptor])``.
    request_interceptor: TracingRequestInterceptor
    #: For the host: ``AgentService(..., heartbeat_extras=tracing.heartbeat_extras)``.
    #: ``records_published`` and ``records_dropped`` — the process-wide
    #: :func:`~synadia_ai.agent_fabric.trace_record_counts` — read fresh for
    #: every heartbeat and status reply. ``{}`` in propagate-only mode, which
    #: publishes no records and would otherwise report a constant 0/0 that
    #: looks like a healthy zero.
    heartbeat_extras: Callable[[], Mapping[str, object]]


def fabric_tracing(options: TraceOptions | None = None) -> FabricTracing:
    """Tracing for an agent on the fabric, as the protocol SDK's hooks.

    ``options`` defaults to :class:`TraceOptions()`: edge records to
    :data:`~synadia_ai.agent_fabric.DEFAULT_EDGE_SUBJECT`.
    ``TraceOptions(edge_subject=None)`` is propagate-only mode. A subject
    that can never be published to already failed when the options were
    constructed (``ValueError``).
    """
    opts = options if options is not None else TraceOptions()
    if not isinstance(opts, TraceOptions):
        raise TypeError(f"options must be a TraceOptions, got {type(opts).__name__}")
    return FabricTracing(
        prompt_interceptor=TracingPromptInterceptor(opts.edge_subject),
        request_interceptor=TracingRequestInterceptor(),
        heartbeat_extras=_no_counts if opts.edge_subject is None else _record_counts,
    )


__all__ = [
    "DEFAULT_EDGE_SUBJECT",
    "TOOL_CALL_ID_CONTEXT_KEY",
    "FabricTracing",
    "TracingPromptInterceptor",
    "TracingRequestInterceptor",
    "fabric_tracing",
]
