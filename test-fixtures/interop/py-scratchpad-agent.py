"""A Python agent with a ScratchPad, for the cross-language grant request tests.

The fabric's own, not adapted from anywhere. It reads references
(``scratchpad_refs_ok``), answers grant requests on
``agents.sp-grant.<agent>.interop.host`` with the fabric package's endpoint,
and serves prompts: ``commit`` commits a reply to its in-memory ScratchPad and
hands the reference to a verified caller with ``grant_caller``; anything
else is answered ``read``. ``ts-scratchpad-agent.ts`` is its twin.

It prints one JSON line per event, for the test to read::

    {"event": "prompt", "text": ...}
    {"event": "grant", "reference", "grantee", "thread_id", "root_id", "tool_call_id", "kind"}
    {"event": "request", "data": ...}       every grant request, as it arrived

Environment:
    NATS_URL         server to connect to (required)
    NATS_CREDS_FILE  authenticate with this .creds file, and sign as it (required)
    AGENT            ``agent`` token (default ``py-creator``)
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import signal
from typing import Any

import nats
from nats.aio.msg import Msg
from synadia_ai.agent_service import AgentService, PromptStream, ServiceIdentity
from synadia_ai.agents import Agents, Envelope, Identity, signer_from_creds_file

from synadia_ai.agent_fabric import (
    GrantKind,
    Grantee,
    TraceIds,
    fabric_tracing,
    grant_request_endpoint,
    grant_subject,
    scratch_pad_extension,
)


def emit(event: dict[str, Any]) -> None:
    print(json.dumps(event, separators=(",", ":")), flush=True)


def _decode(reference: str) -> dict[str, Any]:
    body = reference[len("sp-ref:") :]
    made: dict[str, Any] = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    return made


class MemoryScratchPad:
    """One volume in memory, tokens in the reference agents' format, a ledger."""

    def __init__(self, volume_id: str, creator: str) -> None:
        self.volume_id = volume_id
        self.creator = creator
        self.commits = 0
        self.ledger: dict[tuple[str, str], set[str]] = {}

    def commit(self) -> str:
        self.commits += 1
        made = {
            "ref": {"volume_id": self.volume_id, "root": "r1", "path": f"/{self.commits}.md"},
            "source_sequence": 1,
            "creator": self.creator,
        }
        raw = json.dumps(made, separators=(",", ":")).encode()
        return "sp-ref:" + base64.urlsafe_b64encode(raw).decode().rstrip("=")

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
        who = f"{grantee.account}.{grantee.user}"
        self.ledger.setdefault((reference, who), set()).add(kind)
        emit(
            {
                "event": "grant",
                "reference": reference,
                "grantee": who,
                "thread_id": trace.thread_id if trace else None,
                "root_id": trace.root_id if trace else None,
                "tool_call_id": tool_call_id,
                "kind": kind,
            }
        )

    def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
        kinds = self.ledger.get((reference, f"{grantee.account}.{grantee.user}"), set())
        if "first-hand" in kinds:
            return "first-hand"
        return "on-request" if "on-request" in kinds else None


async def main() -> None:
    url = os.environ["NATS_URL"]
    creds = os.environ["NATS_CREDS_FILE"]
    agent = os.environ.get("AGENT", "py-creator")
    nc = await nats.connect(url, user_credentials=creds, allow_reconnect=False)
    signer = signer_from_creds_file(creds)
    tracing = fabric_tracing()
    address = f"agents.prompt.{agent}.interop.host"
    pad = MemoryScratchPad(f"vol-{agent}", address)
    agents = Agents(nc=nc, identity=Identity(signer=signer))
    ext = scratch_pad_extension(scratch_pad=pad, agents=agents)
    svc = AgentService(
        nc=nc,
        agent=agent,
        owner="interop",
        session_name="host",
        identity=ServiceIdentity(signer=signer),
        heartbeat_interval_s=5,
        keepalive_interval_s=None,
        interceptors=[tracing.request_interceptor, ext.request_interceptor],
        extra_metadata={"scratchpad_refs_ok": "true"},
    )

    async def handle(envelope: Envelope, stream: PromptStream) -> None:
        emit({"event": "prompt", "text": envelope.prompt})
        if envelope.prompt == "commit":
            ref = pad.commit()
            reply = "committed"
            if await ext.grant_caller(ref, stream.sender):
                reply += f"\n\n{ref}"
            await stream.send(reply)
        else:
            await stream.send("read")

    svc.on_prompt(handle)
    await svc.start()
    endpoint = await grant_request_endpoint(prompt_address=address, scratch_pad=pad).subscribe(nc)

    async def seen(msg: Msg) -> None:
        emit({"event": "request", "data": msg.data.decode()})

    await nc.subscribe(grant_subject(address), cb=seen)
    await nc.flush()
    print(f"agent service listening on {svc.subject.prompt}", flush=True)

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()
    await endpoint.unsubscribe()
    await agents.close()
    await svc.stop()
    await nc.close()


if __name__ == "__main__":
    asyncio.run(main())
