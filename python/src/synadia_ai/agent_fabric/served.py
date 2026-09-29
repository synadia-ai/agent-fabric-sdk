"""The ``served`` record — a harness plugin's binding of a thread to the harness's own thread id.

Two per received prompt (the fabric's design, §8.3; the contract is
``docs/schemas/served.json``, vendored under ``test-fixtures/schemas/``).
Mirrors ``typescript/src/served.ts``; the two must stay wire-identical.

An SDK-built agent stamps the thread on every model request it makes
(:func:`~synadia_ai.agent_fabric.trace_headers`), so the proxy files those
calls under the thread the caller minted. A harness makes its own model
calls, and its plugin cannot put a header on them: OpenClaw's carry the
W3C ``traceparent`` of the turn, Claude Code's the session id. The plugin
publishes the binding instead — one record at ``start``, stamped with the
prompt's arrival and naming the thread and the harness's id, bare, under
the harness's name, and one at ``end`` with the outcome. The proxy files
the harness's calls under the same id, so the reader attaches the calls
made between the two records to the thread, and gets the thread's outcome
and duration with them.

Both records are signed with the plugin's own identity, which is also the
record's ``agent``, and carry one id as body ``record_id``, header nonce
and ``Nats-Msg-Id``, like the edge record; they count on the same
process-wide trace record counts the host reports on its heartbeat.
Publishing is asynchronous and fail-open: a prompt is never delayed or
failed by it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import TYPE_CHECKING, Literal, get_args

from synadia_ai.agents import SenderSignatureRequiredError

from .trace import (
    _SUBJECT_FORBIDDEN,
    DEFAULT_EDGE_SUBJECT,
    TraceScope,
    count_trace_record_dropped,
    count_trace_record_published,
    random_thread_id,
)

if TYPE_CHECKING:
    from synadia_ai.agents import AgentId, Agents

log = logging.getLogger("synadia_ai.agent_fabric")

# Bump every time you change the served record schema
# (be sure the TypeScript package is updated in lockstep)
SERVED_RECORD_VERSION = 1

#: The harnesses whose plugins write ``served`` records: the ones that
#: cannot put the fabric's headers on their own model calls. PI can, and
#: writes none. The value is what the proxy files the harness's calls under
#: (the fabric's design, §8.1).
Harness = Literal["claude", "openclaw"]

#: ``start`` when the prompt arrives, ``end`` when the turn is over.
ServedPhase = Literal["start", "end"]

#: How the turn ended: answered, failed, or expired on the request's TTL.
ServedStatus = Literal["ok", "error", "timeout"]

_HARNESSES: frozenset[str] = frozenset(get_args(Harness))
_PHASES: frozenset[str] = frozenset(get_args(ServedPhase))
_STATUSES: frozenset[str] = frozenset(get_args(ServedStatus))

#: Longest accepted harness thread id, in Unicode code points.
HARNESS_THREAD_ID_MAX = 256


def valid_harness_thread_id(value: object) -> bool:
    """``True`` iff ``value`` can be the harness thread id a served record names.

    A non-empty string of at most :data:`HARNESS_THREAD_ID_MAX` code points
    — what ``len()`` counts, and what the TypeScript package counts too
    instead of UTF-16 units — with no whitespace or control character (the
    class the SDK holds a subject token to: the id is matched against a
    header value the proxy saw, and a header value can never hold those)
    and no lone surrogate, which has no UTF-8 form. Claude Code's session
    id and OpenClaw's 32-hex trace id pass; the packages accept exactly the
    same ids.
    """
    if not isinstance(value, str) or not 0 < len(value) <= HARNESS_THREAD_ID_MAX:
        return False
    if _SUBJECT_FORBIDDEN.search(value):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def unix_seconds() -> int:
    """Now, in unix seconds — the served record's ``ts`` resolution."""
    return int(time.time())


def build_served_record(
    agent: AgentId,
    thread_id: str,
    root_id: str,
    harness: Harness,
    harness_thread_id: str,
    phase: ServedPhase,
    status: ServedStatus | None = None,
    ts: int | None = None,
) -> tuple[str, bytes]:
    """One served record, ready to publish: its record id and its wire bytes.

    The publisher signs with the record id as the ``Agent-Sender`` nonce,
    which the SDK's signed publish also stamps as ``Nats-Msg-Id``, so body,
    header and message id carry one id and a stream de-duplicates a record
    it already stored. Its 32 hex characters fit the nonce's
    ``[A-Za-z0-9_-]{1,64}``.

    ``agent`` is the plugin's own identity, the executing agent, in
    canonical ``{account}.{user}`` form — the same identity that signs the
    record. ``thread_id`` and ``root_id`` are the served prompt's, from its
    scope. ``harness_thread_id`` is the harness's own id, bare — never
    prefixed — and must pass :func:`valid_harness_thread_id`. ``status`` is
    required on ``end`` and must be absent on ``start``. ``ts`` is unix
    seconds: when the prompt arrived for ``start``, when the turn ended for
    ``end``; now by default.

    Raises :class:`ValueError` for a record the contract would refuse, so a
    plugin's mistake is its own and never a malformed record on the wire.
    """
    if harness not in _HARNESSES:
        raise ValueError(
            f'build_served_record: harness must be "claude" or "openclaw", got {harness!r}'
        )
    if phase not in _PHASES:
        raise ValueError(f'build_served_record: phase must be "start" or "end", got {phase!r}')
    if phase == "end" and status is None:
        raise ValueError("build_served_record: an end record needs a status")
    if phase == "start" and status is not None:
        raise ValueError("build_served_record: a start record carries no status")
    if status is not None and status not in _STATUSES:
        raise ValueError(
            f'build_served_record: status must be "ok", "error" or "timeout", got {status!r}'
        )
    if not valid_harness_thread_id(harness_thread_id):
        raise ValueError("build_served_record: harness_thread_id is not a usable harness thread id")
    if ts is None:
        ts = unix_seconds()
    elif isinstance(ts, bool) or not isinstance(ts, int) or ts < 0:
        raise ValueError("build_served_record: ts must be a non-negative integer of unix seconds")
    record_id = random_thread_id()
    record: dict[str, object] = {
        "version": SERVED_RECORD_VERSION,
        "kind": "served",
        "record_id": record_id,
        "ts": ts,
        "agent": str(agent),
        "thread_id": thread_id,
        "root_id": root_id,
        "harness": harness,
        "harness_thread_id": harness_thread_id,
        "phase": phase,
    }
    if status is not None:
        record["status"] = status
    # `ensure_ascii=False`: `JSON.stringify` writes non-ASCII text raw, and
    # the two packages must write byte-identical records.
    return record_id, json.dumps(record, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class ServedTurn:
    """One prompt's served pair.

    :meth:`bind` names the harness thread id once and publishes ``start``,
    stamped with the prompt's arrival — the moment
    :meth:`ServedPublisher.begin_turn` was called — however late the id
    becomes known; :meth:`settle` records the outcome when the turn ends
    and publishes ``end`` if the id is known. An id bound after settling is
    refused: the pair is the turn's window, not something to backfill. Both
    are synchronous and return at once; the records go out behind them, on
    the running event loop.
    """

    __slots__ = (
        "_arrived_at",
        "_harness",
        "_harness_thread_id",
        "_publisher",
        "_scope",
        "_settled",
    )

    def __init__(self, publisher: ServedPublisher, scope: TraceScope, harness: Harness) -> None:
        self._publisher = publisher
        self._scope = scope
        self._harness = harness
        self._arrived_at = unix_seconds()
        self._harness_thread_id: str | None = None
        self._settled = False

    def bind(self, harness_thread_id: str) -> None:
        """The harness's own id for this prompt's turn, bare.

        An unusable id (see :func:`valid_harness_thread_id`) is refused
        with a warning and the prompt gets no pair; a second binding is
        ignored, with a warning when it names another id.
        """
        logger = self._publisher.logger
        if self._settled:
            logger.warning("served: harness thread id bound after the turn ended; no served record")
            return
        if self._harness_thread_id is not None:
            if harness_thread_id != self._harness_thread_id:
                logger.warning("served: harness thread id already bound for this prompt; ignored")
            return
        if not valid_harness_thread_id(harness_thread_id):
            logger.warning("served: unusable harness thread id bound; no served record")
            return
        self._harness_thread_id = harness_thread_id
        self._publisher.publish(
            self._scope, self._harness, harness_thread_id, "start", None, self._arrived_at
        )

    def settle(self, status: ServedStatus, at_s: float | None = None) -> None:
        """End the turn.

        ``at_s`` is the turn's end in unix seconds, as :func:`time.time`
        gives it; now by default. A second call does nothing.
        """
        if self._settled:
            return
        self._settled = True
        if self._harness_thread_id is None:
            return
        ts = unix_seconds() if at_s is None else int(at_s)
        self._publisher.publish(
            self._scope, self._harness, self._harness_thread_id, "end", status, ts
        )


class ServedPublisher:
    """Publishes served records through the plugin's client, in the order they were due.

    So a pair's ``end`` never overtakes its ``start`` on the wire and two
    prompts' pairs interleave as they happened. See :func:`served_publisher`.
    """

    def __init__(
        self,
        agents: Agents,
        *,
        subject: str = DEFAULT_EDGE_SUBJECT,
        logger: logging.Logger | None = None,
    ) -> None:
        self._agents = agents
        self._subject = subject
        self._logger = logger if logger is not None else log
        self._unsigned_warned = False
        # Records are built, signed and handed to the connection one after
        # another, in the order they were due. A failed record never breaks
        # the chain: `_send` catches everything.
        self._chain: asyncio.Task[None] | None = None

    @property
    def subject(self) -> str:
        """Where the records go."""
        return self._subject

    @property
    def logger(self) -> logging.Logger:
        """Where a refused binding or a failed publish is reported."""
        return self._logger

    def begin_turn(self, scope: TraceScope, harness: Harness) -> ServedTurn:
        """Start a prompt's pair.

        ``scope`` is the served prompt's trace scope — the one the fabric's
        request interceptor bound around the handler,
        :func:`~synadia_ai.agent_fabric.active_trace` inside it — and
        ``harness`` the one whose id :meth:`ServedTurn.bind` will name. The
        arrival, ``start``'s ``ts``, is now.
        """
        return ServedTurn(self, scope, harness)

    def publish(
        self,
        scope: TraceScope,
        harness: Harness,
        harness_thread_id: str,
        phase: ServedPhase,
        status: ServedStatus | None,
        ts: int,
    ) -> asyncio.Task[None]:
        """Publish one signed record, after every record handed over before it.

        Fail-open and asynchronous: the returned task never raises and
        nothing awaits it on the prompt path. A record that cannot go out —
        no signer, a client already closed, a publish that raised — is
        logged and counts as dropped; one that went out counts as
        published. Every record moves the process-wide
        :func:`~synadia_ai.agent_fabric.trace_record_counts`. Needs a
        running event loop.
        """
        previous = self._chain

        async def run() -> None:
            if previous is not None:
                # Wait for the record before this one, whatever became of
                # it: `wait` reports, it never re-raises.
                await asyncio.wait({previous})
            await self._send(scope, harness, harness_thread_id, phase, status, ts)

        task = asyncio.get_running_loop().create_task(run())
        self._chain = task
        return task

    async def flush(self) -> None:
        """Wait until every record handed to :meth:`publish` so far went out, or was dropped.

        For shutdown and tests.
        """
        if self._chain is not None:
            await asyncio.wait({self._chain})

    async def _send(
        self,
        scope: TraceScope,
        harness: Harness,
        harness_thread_id: str,
        phase: ServedPhase,
        status: ServedStatus | None,
        ts: int,
    ) -> None:
        try:
            agent = await self._agents.self_id()
            record_id, payload = build_served_record(
                agent, scope.thread_id, scope.root_id, harness, harness_thread_id, phase, status, ts
            )
            await self._agents.publish_signed(self._subject, payload, nonce=record_id)
            count_trace_record_published()
        except SenderSignatureRequiredError:
            count_trace_record_dropped()
            # Consumers ignore unsigned records, so publishing without a
            # signer would be pure waste. One warning per publisher: a
            # per-prompt log would itself disturb the agent.
            if self._unsigned_warned:
                return
            self._unsigned_warned = True
            self._logger.warning(
                "served: no identity signer is configured; served records are not "
                "published (consumers ignore unsigned records). "
                "Pass identity=Identity(signer=...) to sign them."
            )
        except Exception:
            count_trace_record_dropped()
            self._logger.exception(
                "served: failed to publish served record on %s (%s)", self._subject, phase
            )


def served_publisher(
    agents: Agents,
    *,
    subject: str = DEFAULT_EDGE_SUBJECT,
    logger: logging.Logger | None = None,
) -> ServedPublisher:
    """The served records' publisher for a harness plugin's add-on, over the plugin's own client.

    ``agents.publish_signed`` with the record id as nonce, on ``subject``
    (:data:`~synadia_ai.agent_fabric.DEFAULT_EDGE_SUBJECT` by default), the
    records in the order they were due, every one counted on the
    process-wide :func:`~synadia_ai.agent_fabric.trace_record_counts`. Per
    served prompt the add-on calls :meth:`ServedPublisher.begin_turn` with
    the prompt's scope, ``bind``\\ s the harness's id once it knows it, and
    ``settle``\\ s with the outcome; :meth:`ServedPublisher.flush` before the
    plugin stops. Without a signer nothing is published — an unsigned
    record cannot be attributed — the publisher warns once and each record
    owed counts as dropped.
    """
    return ServedPublisher(agents, subject=subject, logger=logger)


__all__ = [
    "HARNESS_THREAD_ID_MAX",
    "SERVED_RECORD_VERSION",
    "Harness",
    "ServedPhase",
    "ServedPublisher",
    "ServedStatus",
    "ServedTurn",
    "build_served_record",
    "served_publisher",
    "unix_seconds",
    "valid_harness_thread_id",
]
