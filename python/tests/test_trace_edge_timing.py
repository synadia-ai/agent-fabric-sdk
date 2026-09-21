"""An edge record must only ever describe a prompt that was actually sent.

It is published immediately before the prompt itself — an observer should
see the node before it runs — and not at all for a prompt that never goes
out: one whose stream is never iterated, or that validation rejects
before any wire I/O or at publish time. The prompt interceptor publishes
it in the SDK's second phase, after the prompt is signed and its size
checked. The TypeScript package has the same guarantees.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Any

import pytest
from synadia_ai.agents import (
    Agent,
    Identity,
    PayloadTooLargeError,
    PromptExtras,
    PromptInterceptor,
    PromptInterceptorContext,
    SenderSigner,
    parse_sender_header,
    read_sender_header_value,
    signer_from_seed,
)

from synadia_ai.agent_fabric import fabric_tracing, trace_record_counts
from tests.support import answer_prompts, capture, drain, make_agent_info

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg

    from tests.conftest import ConnectNkeyUser
    from tests.harness.nats_server import RunningServer
    from tests.support import NkeyUser

SUBJECT = "probe2.prompt"


class _FailingFor:
    """alice's signer, failing whenever it is asked to sign for ``subject``."""

    def __init__(self, seed: str, subject: str) -> None:
        self._real = signer_from_seed(seed)
        self._marker = f"\n{subject}\n".encode()

    @property
    def public_key(self) -> str:
        return self._real.public_key

    @property
    def jwt(self) -> str | None:
        return None

    def sign(self, data: bytes) -> bytes:
        if self._marker in data:
            raise RuntimeError("signer unavailable")
        return self._real.sign(data)


class _Bulky:
    """Another interceptor, adding a field far over the endpoint's limit."""

    async def before_prompt(self, ctx: PromptInterceptorContext) -> PromptExtras:
        return PromptExtras(fields={"x_bulk": "b" * 2_000})


def _traced(
    nc: NATSClient,
    signer: SenderSigner | None,
    *,
    info: Any = None,
    extra: tuple[PromptInterceptor, ...] = (),
) -> Agent:
    return Agent(
        nc,
        info or make_agent_info(SUBJECT),
        identity=Identity(signer=signer) if signer is not None else None,
        interceptors=(fabric_tracing().prompt_interceptor, *extra),
    )


async def _alice(
    server: RunningServer, connect: ConnectNkeyUser
) -> NATSClient:  # the prompter and the observer
    return await connect(server, "alice")


async def test_edge_precedes_the_prompt(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    order: list[str] = []

    async def on_edge(_msg: Msg) -> None:
        order.append("edge")

    await nc.subscribe("TRACE.edges", cb=on_edge)
    await answer_prompts(nc, SUBJECT, order)
    await drain(_traced(nc, signer_from_seed(identity_keys["alice"].seed)).prompt("hi"))
    await asyncio.sleep(0.3)
    assert order == ["edge", "prompt"], order


async def test_edge_carries_one_id(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    """A reader de-duplicates on (signing user, record_id); a stream on
    Nats-Msg-Id; the signature binds the nonce. All three must be the same
    value or the record is counted differently by each."""
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    edges = await capture(nc, "TRACE.edges")
    await answer_prompts(nc, SUBJECT)
    await drain(_traced(nc, signer_from_seed(identity_keys["alice"].seed)).prompt("hi"))
    await asyncio.sleep(0.3)

    assert len(edges) == 1, [e.data for e in edges]
    record = json.loads(edges[0].data)
    sender = parse_sender_header(read_sender_header_value(edges[0].headers) or "")
    assert sender is not None
    assert sender.nonce == record["record_id"]
    assert (edges[0].headers or {})["Nats-Msg-Id"] == record["record_id"]


async def test_edge_is_stamped_when_the_prompt_goes_out(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    """``ts`` says when the prompt was sent — not when it was planned."""
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    edges = await capture(nc, "TRACE.edges")
    await answer_prompts(nc, SUBJECT)
    stream = _traced(nc, signer_from_seed(identity_keys["alice"].seed)).prompt("hi")  # planned now
    await asyncio.sleep(1.1)  # … a whole second passes …
    sent_at = int(time.time())
    await drain(stream)  # … sent now
    await asyncio.sleep(0.3)
    assert len(edges) == 1
    assert json.loads(edges[0].data)["ts"] >= sent_at


async def test_no_edge_when_the_stream_is_never_iterated(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    edges = await capture(nc, "TRACE.edges")
    _traced(nc, signer_from_seed(identity_keys["alice"].seed)).prompt("hi")  # never iterated
    await asyncio.sleep(0.3)
    assert edges == []


async def test_no_edge_when_the_prompt_header_cannot_be_signed(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    """The prompt's header is signed at publish time, immediately before
    the request goes out, and signing can fail. Fail it for the prompt
    subject only — the edge record's own header (another subject) is left
    alone, so the edge WOULD go out if it were published first."""
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    edges = await capture(nc, "TRACE.edges")
    order: list[str] = []
    await answer_prompts(nc, SUBJECT, order)
    before = trace_record_counts()
    agent = _traced(nc, _FailingFor(identity_keys["alice"].seed, SUBJECT))
    with pytest.raises(RuntimeError, match="signer unavailable"):
        await drain(agent.prompt("hi"))
    await asyncio.sleep(0.3)
    assert edges == []
    assert order == []
    assert trace_record_counts() == before


async def test_no_edge_when_validation_rejects_the_prompt(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    edges = await capture(nc, "TRACE.edges")
    agent = _traced(nc, signer_from_seed(identity_keys["alice"].seed))
    with pytest.raises(PayloadTooLargeError):
        await drain(agent.prompt("x" * 2_000_000))
    await asyncio.sleep(0.3)
    assert edges == []


async def test_no_edge_when_the_prompt_fails_the_size_check_at_publish_time(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
    identity_keys: dict[str, NkeyUser],
) -> None:
    """1 KB: the prompt alone fits with room for its header; with another
    interceptor's bulky field it no longer does, which only the check the
    SDK makes at publish time — after the first phase, before the second —
    can see. The edge was planned in phase one and is never published."""
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    edges = await capture(nc, "TRACE.edges")
    order: list[str] = []
    await answer_prompts(nc, SUBJECT, order)
    before = trace_record_counts()
    agent = _traced(
        nc,
        signer_from_seed(identity_keys["alice"].seed),
        info=make_agent_info(SUBJECT, max_payload_bytes=1024),
        extra=(_Bulky(),),
    )
    with pytest.raises(PayloadTooLargeError):
        await drain(agent.prompt("hi"))
    await asyncio.sleep(0.3)
    assert edges == []
    assert order == []
    assert trace_record_counts() == before


async def test_nothing_is_owed_when_the_two_fields_push_the_prompt_over(
    nats_server_nkey: RunningServer,
    connect_nkey_user: ConnectNkeyUser,
) -> None:
    """Unsigned, so ``prompt()`` checks the exact size up front: the largest
    prompt it accepts fits without the lineage fields and not with them.
    Phase two never runs, so not even the unsigned drop is counted."""
    nc = await _alice(nats_server_nkey, connect_nkey_user)
    order: list[str] = []
    await answer_prompts(nc, SUBJECT, order)
    agent = _traced(nc, None, info=make_agent_info(SUBJECT, max_payload_bytes=1024))
    size = 1024
    while size > 0:
        try:
            agent.prompt("x" * size)  # never iterated: nothing is sent
            break
        except PayloadTooLargeError:
            size -= 1
    before = trace_record_counts()
    with pytest.raises(PayloadTooLargeError):
        await drain(agent.prompt("x" * size))
    await asyncio.sleep(0.3)
    assert order == []
    assert trace_record_counts() == before
