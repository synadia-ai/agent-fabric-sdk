"""The grant request — asking a reference's creator to let one more agent read it.

Mirrors ``typescript/src/grant-request.ts``; the two send and answer the same
bytes.

An agent handed a reference may read it; it may not let a third agent read
it. In ScratchPad only a volume's owner grants, and being allowed to read is
not being allowed to pass on (ScratchPad v1 has no delegation, on purpose).
So before an agent hands on a reference it did not create, it asks the
creator, which the token names, to grant that agent read. The creator
decides, and if it agrees it makes the grant itself, on its own volume.

Code to code: no model sees the request or decides the answer, on either
side. The creator's rule:

- the request is signed and the signature verifies: the requester is an
  identity, not a claim (the SDK's ``SenderGate``, which also refuses a
  replay);
- the reference points into the creator's own volume;
- the creator itself granted that requester read on that reference
  first-hand, and the grant has not expired: only an agent the creator chose
  to hand the content to may ask for it to be handed on, and only while its
  own access lasts;
- a grant made on request confers no right to ask, or access would be
  relayed from agent to agent without end;
- the requester asks for another agent, never for itself: a grant that
  renews itself would never expire.

Then it grants what every grant is — one agent, the one path, read only, its
usual expiry — and records it as made on request. So content travels at most
one hop beyond the agents its creator chose.

The wire: one signed NATS request (the SDK's ``request_signed``) and one JSON
reply, on the creator's prompt address with the verb changed::

    agents.prompt.<agent>.<owner>.<name>      where it takes prompts
    agents.sp-grant.<agent>.<owner>.<name>    where it takes grant requests

The shapes are ``test-fixtures/schemas/scratchpad_grant.{request,reply}.json``.
A stopgap until ScratchPad has delegation of its own; then this goes.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from synadia_ai.agent_service import SenderGate
from synadia_ai.agents import VerifiedSender

from .scratchpad import GrantKind, ScratchPad, TraceIds, _resolve, grantee_from_identity
from .trace import is_thread_id, valid_tool_call_id

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient
    from nats.aio.msg import Msg
    from nats.aio.subscription import Subscription
    from synadia_ai.agents import Agents

log = logging.getLogger("synadia_ai.agent_fabric")

#: The name of the creator's endpoint, and the verb of its subject.
GRANT_REQUEST_ENDPOINT = "sp-grant"

#: How long the requester waits for the creator's answer, in seconds. The
#: creator runs one ScratchPad operation before it answers, so longer than the
#: SDK's two seconds for a signed request.
DEFAULT_GRANT_REQUEST_TIMEOUT_S = 10.0

_PROMPT_PREFIX = "agents.prompt."
_GRANT_PREFIX = f"agents.{GRANT_REQUEST_ENDPOINT}."

#: What the requester sends (``scratchpad_grant.request.json``):
#: ``{"reference", "grantee", "trace"?: {"thread_id", "root_id", "tool_call_id"?}}``.
GrantRequest = Mapping[str, Any]

#: What the creator answers (``scratchpad_grant.reply.json``):
#: ``{"granted": True}`` or ``{"granted": False, "reason": "..."}``.
GrantReply = dict[str, Any]


def grant_subject(prompt_address: str) -> str:
    """Where the agent at ``prompt_address`` takes grant requests.

    The same subject with the verb changed. Derived, never taken from what
    another agent says, so a request only ever goes to the creator's own
    subject. Raises :class:`ValueError` for a subject that is not a prompt
    address.
    """
    if not prompt_address.startswith(_PROMPT_PREFIX) or prompt_address == _PROMPT_PREFIX:
        raise ValueError(f"not a prompt address: {prompt_address}")
    return _GRANT_PREFIX + prompt_address[len(_PROMPT_PREFIX) :]


def _dumps(value: object) -> bytes:
    # `ensure_ascii=False` and no spaces: `JSON.stringify`'s bytes.
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def encode_grant_request(request: GrantRequest) -> bytes:
    """A request's bytes, as both packages write them: the schema's key order."""
    body: dict[str, Any] = {"reference": request["reference"], "grantee": request["grantee"]}
    trace = request.get("trace")
    if trace is not None:
        labels: dict[str, Any] = {"thread_id": trace["thread_id"], "root_id": trace["root_id"]}
        if trace.get("tool_call_id") is not None:
            labels["tool_call_id"] = trace["tool_call_id"]
        body["trace"] = labels
    return _dumps(body)


def encode_grant_reply(reply: GrantReply) -> bytes:
    """A reply's bytes, as both packages write them."""
    if reply.get("granted") is True:
        return _dumps({"granted": True})
    return _dumps({"granted": False, "reason": reply["reason"]})


def _refusal(reason: str) -> GrantReply:
    return {"granted": False, "reason": reason}


async def request_grant(
    agents: Agents,
    creator_address: str,
    request: GrantRequest,
    *,
    timeout_s: float = DEFAULT_GRANT_REQUEST_TIMEOUT_S,
) -> GrantReply:
    """The requester's side: ask the agent at ``creator_address`` to grant what
    ``request`` names, signed as ``agents``' identity.

    Never raises: no answer, or an answer that is not a grant, is a refusal
    with its reason in words.
    """
    try:
        msg = await agents.request_signed(
            grant_subject(creator_address), encode_grant_request(request), timeout_s=timeout_s
        )
        answer = json.loads(msg.data)
    except Exception as err:
        # Nobody listening there (an agent without ScratchPad, a harness, an
        # agent that has left), no answer in time, or no JSON.
        return _refusal(f"no answer from {creator_address}: {_describe(err)}")
    if not isinstance(answer, dict):
        return _refusal("refused without a reason")
    if answer.get("granted") is True:
        return {"granted": True}
    reason = answer.get("reason")
    return _refusal(reason if isinstance(reason, str) else "refused without a reason")


async def answer_grant_request(  # noqa: PLR0911 — one refusal per line of the rule
    requester: str,
    payload: bytes | str,
    scratch_pad: ScratchPad,
    logger: logging.Logger | None = None,
) -> GrantReply:
    """The creator's rule, for a requester whose signature verified.

    ``requester`` is that verified sender ID; ``payload`` the request's body.
    Never raises. :func:`grant_request_endpoint` runs it after the SDK's
    ``SenderGate``; a host that takes grant requests some other way must
    verify the sender first.
    """
    logger = logger if logger is not None else log
    request = _parse_grant_request(payload)
    if request is None:
        return _refusal("not a grant request")
    try:
        from_ = grantee_from_identity(requester)
        to = grantee_from_identity(request["grantee"])
    except ValueError:
        return _refusal("grantee is not an agent identity")
    labels: dict[str, str] | None = request.get("trace")
    trace = TraceIds(labels["thread_id"], labels["root_id"]) if labels is not None else None
    reference: str = request["reference"]

    # The rule. Each refusal says which line refused.
    try:
        own = await _resolve(scratch_pad.owns(reference))
    except Exception:
        own = False  # a token that does not decode is nobody's
    if not own:
        return _refusal("the reference does not point into this agent's volume")
    try:
        held: GrantKind | None = await _resolve(scratch_pad.granted(reference, from_))
    except Exception as err:
        logger.error("grant request: the ledger could not be read: %s", _describe(err))
        return _refusal("the grant could not be made")
    if held is None:
        return _refusal(
            "this agent holds no live read grant it made to the requester on that reference"
        )
    if held != "first-hand":
        return _refusal(
            "the requester's own grant was made at another agent's request; "
            "only an agent this agent handed the reference itself may ask for another"
        )
    if to == from_:
        return _refusal("a grant request is for another agent, not for the requester")
    try:
        await _resolve(
            scratch_pad.grant_read(
                reference,
                to,
                trace,
                labels.get("tool_call_id") if labels is not None else None,
                "on-request",
            )
        )
    except Exception as err:
        logger.error("grant request: the grant failed: %s", _describe(err))
        return _refusal("the grant could not be made")
    logger.info("grant request: granted %s at the request of %s", request["grantee"], requester)
    return {"granted": True}


@dataclass(frozen=True, slots=True)
class GrantRequestEndpoint:
    """The creator's side: a NATS endpoint that answers grant requests.

    The Python ``AgentService`` takes no extra endpoints, so this is a plain
    subscription next to it: :meth:`subscribe` it on the agent's connection,
    and unsubscribe the result to stop. ``name``, ``subject`` and ``queue``
    are what the TypeScript package registers on the service.
    """

    name: str
    subject: str
    queue: str
    #: The message handler, for ``nc.subscribe(subject, queue=queue, cb=handler)``.
    handler: Callable[[Msg], Awaitable[None]]

    async def subscribe(self, nc: NATSClient) -> Subscription:
        """Start answering on ``nc``; unsubscribe the result to stop."""
        return await nc.subscribe(self.subject, queue=self.queue, cb=self.handler)


def grant_request_endpoint(
    *,
    prompt_address: str,
    scratch_pad: ScratchPad,
    logger: logging.Logger | None = None,
) -> GrantRequestEndpoint:
    """The creator's side: answer every grant request by the rule in the module docstring.

    ``prompt_address`` is this agent's own; the endpoint sits next to it.
    ``scratch_pad`` is this agent's: the volume it may grant on, and its
    ledger. Refusals are logged at ``INFO``, failures at ``ERROR``; the
    default logger is ``synadia_ai.agent_fabric``. Several instances of one
    agent share the work, in the ``agents`` queue group.
    """
    logger = logger if logger is not None else log
    # The SDK's admission of a signed message, the one its prompt endpoint
    # runs: parse the `Agent-Sender` header, verify the signature over this
    # subject and payload, check the timestamp, and record the nonce so a
    # captured request cannot be played again.
    gate = SenderGate(min_sender_trust="signed")

    async def decide(msg: Msg) -> GrantReply:
        admission = await gate.admit_prompt(msg)
        if admission.rejection is not None:
            return _refusal(admission.rejection.description)
        sender = admission.sender
        if not isinstance(sender, VerifiedSender):
            return _refusal("a grant request must be signed")
        return await answer_grant_request(str(sender.id), msg.data, scratch_pad, logger)

    async def handler(msg: Msg) -> None:
        try:
            reply = await decide(msg)
        except Exception as err:
            logger.error("grant request failed: %s", _describe(err))
            reply = _refusal("the grant could not be made")
        if not reply["granted"]:
            logger.info("grant request refused: %s", reply["reason"])
        await msg.respond(encode_grant_reply(reply))

    return GrantRequestEndpoint(
        name=GRANT_REQUEST_ENDPOINT,
        subject=grant_subject(prompt_address),
        queue="agents",
        handler=handler,
    )


def _parse_grant_request(payload: bytes | str) -> dict[str, Any] | None:
    # A request is taken only with the two strings; the trace labels only
    # when they look like what the fabric mints, and otherwise left off.
    try:
        value = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(value, dict):
        return None
    reference, grantee, trace = value.get("reference"), value.get("grantee"), value.get("trace")
    if not isinstance(reference, str) or not isinstance(grantee, str):
        return None
    request: dict[str, Any] = {"reference": reference, "grantee": grantee}
    if not isinstance(trace, dict):
        return request
    thread_id, root_id = trace.get("thread_id"), trace.get("root_id")
    tool_call_id = trace.get("tool_call_id")
    if (
        isinstance(thread_id, str)
        and isinstance(root_id, str)
        and is_thread_id(thread_id)
        and is_thread_id(root_id)
    ):
        labels = {"thread_id": thread_id, "root_id": root_id}
        if isinstance(tool_call_id, str) and valid_tool_call_id(tool_call_id):
            labels["tool_call_id"] = tool_call_id
        request["trace"] = labels
    return request


def _describe(err: BaseException) -> str:
    return str(err) or type(err).__name__


__all__ = [
    "DEFAULT_GRANT_REQUEST_TIMEOUT_S",
    "GRANT_REQUEST_ENDPOINT",
    "GrantReply",
    "GrantRequest",
    "GrantRequestEndpoint",
    "answer_grant_request",
    "encode_grant_reply",
    "encode_grant_request",
    "grant_request_endpoint",
    "grant_subject",
    "request_grant",
]
