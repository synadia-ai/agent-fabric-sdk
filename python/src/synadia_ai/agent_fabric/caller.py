"""A caller on the fabric: code that prompts agents with a creds file and nothing else.

:func:`fabric_caller` connects with the file, signs every prompt with its key,
traces it (each prompt starts a task of its own), and hands back the task's
root id with the reply. Mirrors ``typescript/src/caller.ts``.

What a caller may do on the wire is narrow: it publishes prompts, status and
discovery requests, its edge records and its own identity lookup, and it
receives only on ``_INBOX.agents.>`` and the heartbeats. So the connection's
inbox prefix is ``_INBOX.agents``: the SDK's own requests already use it, and
the prefix covers the one that takes the connection's default.

The root id: tracing's prompt interceptor mints the thread and its root at
the stream's first iteration. The caller's own interceptor wraps it, reads
the root from the fields it returns, and resolves the prompt's ``root_id``
future with it. The interceptors run in a copy of the caller's context, so
the future travels in the prompt's ``context``, not in a context variable.
Nothing is bound around the prompt, so it is always the root of a task of its
own, never a child.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from nats.aio.client import Client as NATSClient
from synadia_ai.agents import (
    Agent,
    Agents,
    Identity,
    PromptExtras,
    PromptInterceptor,
    PromptInterceptorContext,
    Query,
    ResponseChunk,
    StreamMessage,
    resolve_nats_connection_bundle,
)

from .trace import DEFAULT_EDGE_SUBJECT, ROOT_ID_FIELD, TraceOptions
from .tracing import fabric_tracing

log = logging.getLogger("synadia_ai.agent_fabric")

#: The inbox prefix a caller's permissions allow it to receive on.
CALLER_INBOX_PREFIX = "_INBOX.agents"

#: What :meth:`FabricCaller.ask` replies to a question from the agent when no ``on_query`` is given.
CANNOT_ANSWER = "The caller is a command line and cannot answer; continue with your best judgement."

#: How long :meth:`FabricCaller.list` and :meth:`FabricCaller.find` listen for agents, by default.
DEFAULT_DISCOVER_TIMEOUT_S = 1.0

#: The variables :func:`fabric_caller_from_env` reads.
NATS_URL_VAR = "NATS_URL"
NATS_CREDS_VAR = "NATS_CREDS"

#: Why a caller could not be set up, could not find its agent, or has no root
#: for a prompt: ``config`` (a missing or invalid setting), ``connect`` (no
#: connection), ``identity`` (the server would not say who the creds file is),
#: ``not-found``, ``ambiguous``, ``not-sent`` (the prompt ended before it went
#: out, so it has no root).
FabricCallerErrorReason = Literal[
    "config", "connect", "identity", "not-found", "ambiguous", "not-sent"
]

# The key of the prompt's ``context`` the root's future travels under. It is
# read only by the caller's own interceptor; the SDK never reads the context,
# and tracing reads only its tool call id key.
_ROOT_SINK_KEY = "agent_fabric_caller_root_sink"


class FabricCallerError(Exception):
    """A caller's own error: a missing setting, no connection, no identity, or no such agent."""

    def __init__(self, reason: FabricCallerErrorReason, message: str) -> None:
        super().__init__(message)
        self.reason: FabricCallerErrorReason = reason


def _not_sent(why: str) -> FabricCallerError:
    return FabricCallerError("not-sent", f"the prompt never went out, so it has no root: {why}")


def _fail_root(root: asyncio.Future[str], err: BaseException) -> None:
    """Settle ``root`` with ``err`` unless it is settled; a no-op once the root is known."""
    if root.done():
        return
    if isinstance(err, asyncio.CancelledError):
        root.cancel()
        return
    root.set_exception(err)
    # Retrieved here: a root nobody awaits must not log "never retrieved".
    root.exception()


class CallerStream:
    """The stream ``Agent.prompt`` returns, with the prompt's root settled.

    The messages are the SDK's, unchanged. When iteration ends or fails, or
    :meth:`aclose` is called, before the prompt went out, the root fails
    instead of waiting forever.
    """

    def __init__(self, inner: AsyncIterator[StreamMessage], root: asyncio.Future[str]) -> None:
        self._inner = inner
        self._root = root

    def __aiter__(self) -> CallerStream:
        return self

    async def __anext__(self) -> StreamMessage:
        try:
            return await self._inner.__anext__()
        except StopAsyncIteration:
            _fail_root(self._root, _not_sent("its stream ended first"))
            raise
        except BaseException as err:
            _fail_root(self._root, err)
            raise

    async def aclose(self) -> None:
        """Stop the stream, as closing the SDK's stream does."""
        _fail_root(self._root, _not_sent("it was cancelled"))
        aclose = getattr(self._inner, "aclose", None)
        if aclose is not None:
            await aclose()


@dataclass(frozen=True, slots=True)
class CallerPrompt:
    """A prompt on its way: its stream, and the root of the task it starts.

    ``stream`` passes the SDK's stream through: iterate it for the reply.
    ``root_id`` resolves at the stream's first iteration, before any chunk
    arrives; await it after iteration has begun, never before. It fails with
    a :class:`FabricCallerError` (``not-sent``), or the stream's own error,
    when the prompt ends before it goes out: closed, refused before it was
    sent, or failed.
    """

    stream: CallerStream
    root_id: asyncio.Future[str]


@dataclass(frozen=True, slots=True)
class CallerReply:
    """The whole reply to a prompt, and the root of the task it started."""

    text: str
    root_id: str


OnQuery = Callable[[Query], "str | Awaitable[str]"]


class FabricCaller:
    """A connected caller; build it with :func:`fabric_caller`.

    Use it as an async context manager, or call :meth:`close`.
    """

    def __init__(self, *, agents: Agents, url: str, close: Callable[[], Awaitable[None]]) -> None:
        self._agents = agents
        self._url = url
        self._close = close
        self._closed = False

    @property
    def agents(self) -> Agents:
        """The SDK's client, for anything beyond."""
        return self._agents

    @property
    def url(self) -> str:
        """The URL the caller connected to."""
        return self._url

    async def list(self, *, timeout: float = DEFAULT_DISCOVER_TIMEOUT_S) -> list[Agent]:
        """The agents on the fabric."""
        return await self._agents.discover(timeout=timeout)

    async def find(self, who: str, *, timeout: float = DEFAULT_DISCOVER_TIMEOUT_S) -> Agent:
        """One agent: by its prompt address, else by its kind when exactly one agent has it.

        Raises :class:`FabricCallerError` naming what is there.
        """
        return pick_agent(await self.list(timeout=timeout), who)

    async def prompt(self, who: str | Agent, text: str, **prompt_kwargs: Any) -> CallerPrompt:
        """Prompt an agent: an address, a kind, or an :class:`Agent` from this caller.

        An :class:`Agent` this caller's :meth:`list` or :meth:`find` returned.

        ``prompt_kwargs`` go to ``Agent.prompt`` as they are.
        """
        target = await self.find(who) if isinstance(who, str) else who
        root_id: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        context = {**(prompt_kwargs.pop("context", None) or {}), _ROOT_SINK_KEY: root_id}
        try:
            stream = target.prompt(text, context=context, **prompt_kwargs)
        except BaseException as err:
            _fail_root(root_id, err)
            raise
        return CallerPrompt(stream=CallerStream(stream, root_id), root_id=root_id)

    async def ask(
        self,
        who: str | Agent,
        text: str,
        *,
        on_query: OnQuery | None = None,
        **prompt_kwargs: Any,
    ) -> CallerReply:
        """Prompt an agent and wait for the whole reply.

        ``on_query`` answers a question the agent asks mid-reply. Without it,
        the agent is told the caller cannot answer and goes on.
        """
        started = await self.prompt(who, text, **prompt_kwargs)
        reply: list[str] = []
        async for msg in started.stream:
            if isinstance(msg, ResponseChunk):
                reply.append(msg.text)
            elif isinstance(msg, Query):
                # Every question is answered: an agent left waiting would stall.
                answer = CANNOT_ANSWER
                if on_query is not None:
                    result = on_query(msg)
                    answer = await result if inspect.isawaitable(result) else result
                await msg.reply(answer)
        return CallerReply(text="".join(reply), root_id=await started.root_id)

    async def close(self) -> None:
        """Close the client and the connection, then wipe the credentials."""
        if self._closed:
            return
        self._closed = True
        await self._close()

    async def __aenter__(self) -> FabricCaller:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()


async def fabric_caller(
    *,
    creds: str | os.PathLike[str],
    url: str | None = None,
    name: str | None = None,
    edge_subject: str | None = DEFAULT_EDGE_SUBJECT,
) -> FabricCaller:
    """Connect a caller with a creds file.

    ``url`` is the server's URL, as the console showed it next to the creds
    file; default ``NATS_URL``, with no built-in default. ``name`` is the
    client's name, on the connection and in its identity. ``edge_subject``
    is where the edge records go; ``None`` publishes none.
    """
    creds_path = os.fspath(creds) if creds else ""
    if not creds_path:
        raise FabricCallerError(
            "config",
            f"no creds file: pass creds, or set {NATS_CREDS_VAR} "
            "to the creds file the console gave you",
        )
    server = url if url is not None else os.environ.get(NATS_URL_VAR)
    if not server:
        raise FabricCallerError(
            "config",
            f"no server URL: pass url, or set {NATS_URL_VAR} "
            "to the URL the console showed next to your creds file",
        )
    # Fails here, before anything connects, for an edge subject that can
    # never be published to.
    tracing = fabric_tracing(TraceOptions(edge_subject=edge_subject))

    # A missing or unreadable file, or one without a user seed (signing needs
    # it), is a setting to fix: one line, never a traceback.
    try:
        bundle = resolve_nats_connection_bundle(url=server, creds=creds_path, identity="signed")
    except Exception as err:
        raise FabricCallerError("config", f"creds file {creds_path}: {err}") from err
    # Built before connecting: it refuses a name the identity cannot carry.
    try:
        identity = Identity(signer=bundle.signer, name=name)
    except Exception as err:
        bundle.wipe()
        raise FabricCallerError("config", f"name: {err}") from err
    options: dict[str, Any] = {
        **bundle.connection_options,
        "inbox_prefix": CALLER_INBOX_PREFIX,
        # The first connect fails fast with the server's own error: a refused
        # creds file at once (no reconnect), an unreachable URL after two
        # attempts, instead of minutes of retries reported as "no servers
        # available". Once connected, reconnects never stop.
        "allow_reconnect": False,
        "max_reconnect_attempts": 1,
        "error_cb": _log_connection_error,
    }
    if name is not None:
        options["name"] = name
    nc = NATSClient()
    try:
        await nc.connect(**options)
    except Exception as err:
        bundle.wipe()
        cause = nc.last_error or err
        raise FabricCallerError("connect", f"could not connect to {server}: {cause}") from err
    nc.options["allow_reconnect"] = True
    nc.options["max_reconnect_attempts"] = -1

    try:
        agents = Agents(
            nc=nc,
            identity=identity,
            interceptors=[_RootCapturing(tracing.prompt_interceptor)],
        )
    except BaseException:
        await nc.close()
        bundle.wipe()
        raise
    # Every prompt is signed, and signing needs the creds file's identity,
    # which the server tells. Learnt once here, so a creds file the server
    # will not describe fails now rather than at each prompt.
    try:
        await agents.self_id()
    except Exception as err:
        await agents.close()
        await nc.close()
        bundle.wipe()
        raise FabricCallerError(
            "identity",
            f"the server at {server} would not tell this creds file's identity, "
            f"which signing needs: {err}",
        ) from err

    async def close() -> None:
        try:
            await agents.close()
            await nc.close()
        finally:
            bundle.wipe()

    return FabricCaller(agents=agents, url=server, close=close)


async def fabric_caller_from_env(
    *, name: str | None = None, edge_subject: str | None = DEFAULT_EDGE_SUBJECT
) -> FabricCaller:
    """:func:`fabric_caller` from ``NATS_URL`` and ``NATS_CREDS``."""
    return await fabric_caller(
        creds=os.environ.get(NATS_CREDS_VAR, ""), name=name, edge_subject=edge_subject
    )


async def _log_connection_error(err: Exception) -> None:
    # One line per error, never a traceback: what a person at a terminal reads.
    log.warning("nats: %s", err or type(err).__name__)


def pick_agent(found: Sequence[Agent], who: str) -> Agent:
    """The rule :meth:`FabricCaller.find` applies.

    The agent whose prompt address is ``who``, else the one agent of kind
    ``who``; otherwise a :class:`FabricCallerError` that names what is there.
    """
    for a in found:
        if a.prompt_subject == who:
            return a
    of_kind = _distinct_addresses([a for a in found if a.agent == who])
    if len(of_kind) == 1:
        return of_kind[0]
    if of_kind:
        addresses = ", ".join(a.prompt_subject for a in of_kind)
        raise FabricCallerError(
            "ambiguous",
            f'{len(of_kind)} agents of kind "{who}": {addresses}; name one by its address',
        )
    there = ", ".join(a.prompt_subject for a in _distinct_addresses(found)) or "nobody"
    raise FabricCallerError("not-found", f'no agent "{who}"; there: {there}')


def _distinct_addresses(agents: Sequence[Agent]) -> list[Agent]:
    # One handle per prompt address: two instances of one agent share it.
    seen: dict[str, Agent] = {}
    for a in agents:
        seen.setdefault(a.prompt_subject, a)
    return list(seen.values())


class _RootCapturing:
    """Tracing's prompt interceptor, with the root it mints handed to the prompt's future.

    Both phases are forwarded; the extras go back verbatim, so the SDK hands
    tracing's own extras to its second phase.
    """

    def __init__(self, inner: PromptInterceptor) -> None:
        self._inner = inner

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras | None:
        sink = ctx.context.get(_ROOT_SINK_KEY)
        root_sink = sink if isinstance(sink, asyncio.Future) else None
        try:
            extras = await self._inner.before_prompt(ctx)
        except BaseException as err:
            if root_sink is not None:
                _fail_root(root_sink, err)
            raise
        root = extras.fields.get(ROOT_ID_FIELD) if extras is not None else None
        if root_sink is not None and not root_sink.done():
            if isinstance(root, str):
                root_sink.set_result(root)
            else:
                _fail_root(root_sink, _not_sent("tracing minted no root"))
        return extras

    async def before_publish(
        self, ctx: PromptInterceptorContext, extras: PromptExtras | None
    ) -> None:
        phase_two = getattr(self._inner, "before_publish", None)
        if phase_two is not None:
            await phase_two(ctx, extras)


__all__ = [
    "CALLER_INBOX_PREFIX",
    "CANNOT_ANSWER",
    "DEFAULT_DISCOVER_TIMEOUT_S",
    "NATS_CREDS_VAR",
    "NATS_URL_VAR",
    "CallerPrompt",
    "CallerReply",
    "CallerStream",
    "FabricCaller",
    "FabricCallerError",
    "FabricCallerErrorReason",
    "fabric_caller",
    "fabric_caller_from_env",
    "pick_agent",
]
