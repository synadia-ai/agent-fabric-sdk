"""Shared test support: the edge schema, agent records, a raw request, a started host.

Everything here drives the protocol SDK through its public API only.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any

from jsonschema import Draft202012Validator
from synadia_ai.agent_service import AgentService, RequestInterceptor
from synadia_ai.agents import Agent, AgentInfo, Agents, EndpointInfo

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

REPO_ROOT = Path(__file__).resolve().parents[2]
EDGE_SCHEMA = json.loads(
    (REPO_ROOT / "test-fixtures" / "schemas" / "edge.json").read_text(encoding="utf-8")
)
Draft202012Validator.check_schema(EDGE_SCHEMA)
_EDGE_VALIDATOR = Draft202012Validator(EDGE_SCHEMA)


@dataclass(frozen=True, slots=True)
class NkeyUser:
    """One throwaway user from ``test-fixtures/identity/keys.json``."""

    name: str
    public: str
    seed: str


def edge_schema_errors(record: object) -> list[str]:
    """What ``edge.json`` says is wrong with ``record``; ``[]`` when it validates."""
    return [e.message for e in _EDGE_VALIDATOR.iter_errors(record)]


def make_agent_info(prompt_subject: str, *, max_payload_bytes: int | None = None) -> AgentInfo:
    """An :class:`AgentInfo` pointing at a test-controlled subject, no discovery."""
    prompt_endpoint = EndpointInfo(
        name="prompt",
        subject=prompt_subject,
        queue_group="agents",
        metadata=MappingProxyType({}),
        max_payload_bytes=max_payload_bytes,
        attachments_ok=True,
    )
    return AgentInfo(
        instance_id="test-instance",
        agent="test-agent",
        owner="pytest",
        session_name="fabric",
        protocol_version="0.3",
        description="",
        version="0.0.0",
        metadata=MappingProxyType({"agent": "test-agent", "owner": "pytest"}),
        endpoints=(prompt_endpoint,),
        prompt_endpoint=prompt_endpoint,
    )


async def capture(nc: NATSClient, subject: str, out: list[Msg] | None = None) -> list[Msg]:
    """Every message on ``subject``, appended in arrival order."""
    seen: list[Msg] = out if out is not None else []

    async def cb(msg: Msg) -> None:
        seen.append(msg)

    await nc.subscribe(subject, cb=cb)
    await nc.flush()
    return seen


async def answer_prompts(nc: NATSClient, subject: str, seen: list[str] | None = None) -> None:
    """A bare responder on ``subject``: the §6.5 terminator for every prompt."""

    async def cb(msg: Msg) -> None:
        if seen is not None:
            seen.append("prompt")
        if msg.reply:
            await nc.publish(msg.reply, b"")

    await nc.subscribe(subject, cb=cb)
    await nc.flush()


async def replies(nc: NATSClient, subject: str, payload: bytes) -> list[Msg]:
    """Every frame a raw request draws, up to and including the §6.5 terminator."""
    inbox = nc.new_inbox()
    sub = await nc.subscribe(inbox)
    try:
        await nc.publish(subject, payload, reply=inbox)
        collected: list[Msg] = []
        while True:
            msg = await asyncio.wait_for(sub.next_msg(), timeout=5.0)
            collected.append(msg)
            if msg.data == b"" and not msg.headers:
                return collected
    finally:
        await sub.unsubscribe()


def error_code(frames: Sequence[Msg]) -> str | None:
    for m in frames:
        code = (m.headers or {}).get("Nats-Service-Error-Code")
        if code is not None:
            return code
    return None


Handler = Callable[[Any, Any], Awaitable[None]]


async def _ok(_env: Any, stream: Any) -> None:
    await stream.send("ok")


async def start_host(
    nc: NATSClient,
    agent: str,
    *,
    interceptors: Sequence[RequestInterceptor] = (),
    heartbeat_extras: Callable[[], Mapping[str, object]] | None = None,
    handler: Handler = _ok,
    max_payload: str | None = None,
) -> AgentService:
    """A started ``AgentService`` on ``nc``; stop it with ``await svc.stop()``."""
    kwargs: dict[str, Any] = {} if max_payload is None else {"max_payload": max_payload}
    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="fabric",
        session_name="s",
        heartbeat_interval_s=3600,
        keepalive_interval_s=None,
        interceptors=interceptors,
        heartbeat_extras=heartbeat_extras,
        **kwargs,
    )
    svc.on_prompt(handler)
    await svc.start()
    return svc


async def handle_of(agents: Agents, agent: str) -> Agent:
    """The discovered handle of the host registered as ``agent``."""
    found = await agents.discover(timeout=0.5)
    return next(a for a in found if a.agent == agent)


async def drain(stream: Any) -> list[str]:
    """Iterate a prompt stream to its end; the response texts."""
    texts: list[str] = []
    async for chunk in stream:
        text = getattr(chunk, "text", None)
        if isinstance(text, str):
            texts.append(text)
    return texts
