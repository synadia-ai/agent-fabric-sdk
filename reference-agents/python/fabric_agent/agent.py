"""agent.py — the Python reference agent of the Synadia Agent Fabric.

An agent on the fabric does four things. Each is marked below where it
happens, so the file can be read as the list:

    (1) it receives prompts through the SDK's host side, with a signed
        identity, so every caller knows who answered;
    (2) it calls its model through the fabric's proxy, with its virtual key
        and the two trace headers on every call, so every call lands on its
        thread in the console;
    (3) it can see who else is on the fabric and prompt them, through the
        SDK's agent tools its model may call; a prompt to another agent
        becomes a child thread under this one;
    (4) it uses ScratchPad: it reads what it was handed by reference, and
        commits what it produced so the next agent can be handed that — with
        a read grant to that one agent, made right before the reference goes
        out, and to nobody else. What it was handed and wants to hand on, it
        asks the creator to grant; and it answers such requests about its
        own content, in code, by a fixed rule. All of it is the fabric
        package's, the rules and the ScratchPad they run on; this agent writes
        no ScratchPad code, it is configured (``SCRATCHPAD_VOLUME``).

The same agent as ``typescript/src/agent.ts``, in Python: the same tool
definitions, the same words to the model, the same reference token. One
history per process, shared by every caller, is a deliberate simplification.
"""

from __future__ import annotations

import json
import logging
import os
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import nats
from synadia_ai.agent_fabric import (
    READS_REFERENCES_KEY,
    ScratchPadClient,
    TraceIds,
    active_trace,
    fabric_tracing,
    find_references,
    grant_request_endpoint,
    native_scratchpad_from_env,
    scratch_pad_extension,
    trace_headers,
)
from synadia_ai.agent_service import AgentService, PromptStream, RequestRejectedError, ServiceIdentity
from synadia_ai.agents import (
    Agents,
    AgentSubject,
    AgentTools,
    Envelope,
    Identity,
    format_sender,
    resolve_nats_connection_bundle,
)

from .config import AgentConfig
from .model import ChatMessage, EmptyReplyError, ModelClient, converse
from .reply import delivered_reply
from .tools import NO_TOOLS, offered_tools, tool_runner

#: How many prompts one agent serves at once. The Python host serves one at a
#: time unless told otherwise, and an agent that prompts another while it
#: serves a prompt is then deaf until its own call ends: a prompt back to it
#: (A to B to A) waits out the caller's timeout, and so does a second caller.
#: Four lets it take the prompts that come back to it while it waits on its
#: own calls, and a few callers at once, without letting one process run an
#: unbounded number of model loops. The TypeScript host has no such limit.
MAX_CONCURRENT_PROMPTS = 4


@dataclass
class RunningAgent:
    #: The prompt address other agents see in discovery.
    address: str
    instance_id: str
    #: ``<account>.<user>``, the identity the agent registered.
    identity: str | None
    _stop: Callable[[], "asyncio.Future[None]"]  # noqa: F821 — typed loosely on purpose

    async def stop(self) -> None:
        await self._stop()


async def start_agent(
    cfg: AgentConfig,
    log: Callable[[str], None] = print,
    *,
    env: Mapping[str, str] | None = None,
    scratchpad: ScratchPadClient | None = None,
) -> RunningAgent:
    """Start one agent.

    ``env`` is where the fabric package reads the ``SCRATCHPAD_*`` variables
    (default: the process environment); ``scratchpad`` replaces the ScratchPad
    they configure (for tests).
    """
    # (1) One credentials snapshot gives both the connection and the signer,
    # so the identity the agent registers is the identity the connection
    # authenticated with; nothing can drift between the two.
    bundle = resolve_nats_connection_bundle(
        context=cfg.nats.context,
        url=cfg.nats.url,
        creds=cfg.nats.creds,
        nkey=cfg.nats.nkey,
        identity="signed",
    )
    nc = await nats.connect(**bundle.connection_options)
    signer = bundle.signer

    # (2) The model, behind the proxy.
    model = ModelClient(
        proxy_url=cfg.model.proxy_url,
        virtual_key=cfg.model.virtual_key,
        model=cfg.model.model,
        **({"timeout_s": cfg.model.timeout_s} if cfg.model.timeout_s is not None else {}),
    )

    # Where this agent takes prompts: ``agents.prompt.<kind>.<owner>.<name>``.
    address = AgentSubject.new(cfg.agent.kind, cfg.agent.owner, cfg.agent.name).prompt

    # (4) ScratchPad borrows this authenticated connection. An unset volume
    # disables it; a configured volume requires a private persistent workspace.
    # Every reference this agent creates names its prompt address as creator.
    native_scratchpad = (
        await native_scratchpad_from_env(env, creator=address, nc=nc) if scratchpad is None else None
    )
    scratchpad = native_scratchpad if scratchpad is None else scratchpad

    # Tracing, from the fabric package: three hooks the SDK takes. The
    # service's two adopt or mint each prompt's thread, run the handler inside
    # it, and count the edge records on the heartbeat; the client's one writes
    # the edge that makes a prompt sent from inside the handler a child thread.
    tracing = fabric_tracing()

    # (3) The caller side, on the same connection and the same identity, so
    # the edges it writes are signed as this agent. It traces only because it
    # is given the prompt interceptor: a client without it, even one used
    # inside the handler, sends prompts that start no child thread.
    client = Agents(nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor])

    # (4) The fabric's rules for ScratchPad references, as an extension of the
    # agent tools, over the ScratchPad above. Before ``prompt_agent``
    # sends a prompt with references in it, the extension checks each one:
    # only a reference this agent was given, exactly as it came; only to an
    # agent whose registration says it reads references (any other gets the
    # text without them); on this agent's own content, a read grant to that one
    # agent's verified identity; on anyone else's, a signed request to the
    # creator the token names, which decides by its own rule. The grant request
    # goes over ``client``, so it is signed as this agent.
    references = (
        scratch_pad_extension(scratch_pad=scratchpad, agents=client) if scratchpad is not None else None
    )

    # (3) The agent tools, the SDK's, over the caller side above: by default
    # ``discover_agents``, ``prompt_agent`` and ``answer_agent``, every prompt
    # waiting for its reply; the six its contract defines with
    # ``AGENT_TOOLS=all`` (``tools.py``). ``self_address`` keeps the agent out
    # of its own discovery and refuses a prompt to itself; the SDK also refuses
    # a prompt back to the agent that sent the prompt being served.
    # ``max_wait_s`` is how long one prompt to another agent may run. No
    # attachment roots are named: the SDK's default is its staging directory
    # alone, which holds only the files other agents sent back, so the model
    # may pass one of those on and never a file of this host's, such as the
    # ``.env`` with the virtual key. These agents hand content over through
    # ScratchPad.
    tools = AgentTools(
        client,
        tools=offered_tools(cfg.agent.tools),
        self_address=address,
        max_wait_s=cfg.reply_timeout_s,
        extensions=[references] if references is not None else [],
        logger=_line_logger(log, "[tools]"),
    )

    service = AgentService(
        agent=cfg.agent.kind,
        owner=cfg.agent.owner,
        session_name=cfg.agent.name,
        nc=nc,
        description=cfg.agent.description,
        # In this order, the first outermost. Tracing binds the served prompt's
        # thread, so everything inside runs on it. The tools open the prompt's
        # scope: the calls the model makes belong to this prompt and end with
        # it, and its verified sender is the caller the tools refuse to prompt
        # back. The extension notes the references the prompt hands over, so
        # the model may hand them on.
        interceptors=[
            tracing.request_interceptor,
            tools.request_interceptor,
            *([references.request_interceptor] if references is not None else []),
        ],
        heartbeat_extras=tracing.heartbeat_extras,
        identity=ServiceIdentity(signer=signer),
        min_sender_trust=cfg.agent.min_sender_trust,
        max_concurrent_prompts=MAX_CONCURRENT_PROMPTS,
        # (4) With ScratchPad, this agent reads the references it is handed, and
        # says so in its registration: callers hand references, and grant read
        # on them, only to agents that do.
        extra_metadata={READS_REFERENCES_KEY: "true"} if scratchpad is not None else None,
        # (4) And it answers grant requests about its own content, next to its
        # prompt address (``agents.sp-grant.<kind>.<owner>.<name>``): an agent it
        # handed a reference asks here before handing it on, and the package's
        # rule decides. No model is involved.
        extra_endpoints=(
            [grant_request_endpoint(prompt_address=address, scratch_pad=scratchpad, logger=_line_logger(log, "[sp-grant]"))]
            if scratchpad is not None
            else []
        ),
        **({"heartbeat_interval_s": cfg.agent.heartbeat_interval_s} if cfg.agent.heartbeat_interval_s else {}),
    )

    history: list[ChatMessage] = []

    # What the model is offered. A role that must answer itself is offered no
    # tools at all (see ``config.py``).
    offered = NO_TOOLS if cfg.agent.tools == "none" else tool_runner(tools)

    async def on_prompt(envelope: Envelope, stream: PromptStream) -> None:
        # The served thread's ids, for log lines and ScratchPad. Read here, not
        # through ``trace_headers()``, which counts a model turn each time.
        scope = active_trace()
        trace = TraceIds(scope.thread_id, scope.root_id) if scope is not None else None
        tag = f"[{scope.thread_id[:8] if scope else 'untraced'}]"
        log(f"{tag} prompt from {format_sender(stream.sender)}: {envelope.prompt[:80]}")
        try:
            await serve(envelope, stream, trace, tag)
        except Exception as err:
            # A model call that failed, a proxy that refused the key: the SDK
            # answers the caller with the protocol's error (500, "handler
            # error"); the reason is here, in the agent's own log.
            log(f"{tag} failed: {type(err).__name__}: {err}")
            raise

    async def serve(envelope: Envelope, stream: PromptStream, trace: TraceIds | None, tag: str) -> None:

        # (4) What it was handed: every ScratchPad reference in the prompt is
        # read, and its content follows the prompt in front of the model. The
        # extension's request interceptor has noted the references as given
        # already, so the model may hand them on exactly as they came, and
        # nothing else.
        # LIMITATION: attachments on the envelope are not read; on the fabric
        # content moves by reference.
        user_content = envelope.prompt
        if scratchpad is not None:
            for ref in find_references(envelope.prompt):
                try:
                    text = await scratchpad.read(ref, trace)
                    log(f"{tag} read {ref[:40]}… ({len(text)} chars)")
                    user_content += f"\n\n--- content handed over as {ref} ---\n{text}"
                except Exception as err:  # noqa: BLE001 — told to the model in words
                    log(f"{tag} could not read {ref[:40]}…: {err}")
                    user_content += f"\n\n--- {ref} could not be read: {err} ---"

        # (2) and (3): the model, with the agent tools, until it answers in
        # words. The tools run in this prompt's scope: a prompt the model starts
        # ends with this one, a question the prompted agent asks comes back to
        # the model, and the agent that sent this prompt is refused as a
        # target, the shortest loop between two agents.
        messages: list[ChatMessage] = [
            {"role": "system", "content": cfg.agent.system_prompt},
            *history,
            {"role": "user", "content": user_content},
        ]
        try:
            result = await converse(
                model=model,
                tools=offered,
                messages=messages,
                trace_headers=trace_headers,
                log=lambda line: log(f"{tag} {line}"),
            )
        except EmptyReplyError as err:
            # The model kept answering with nothing while calls it started were
            # open: the prompt fails with the reason, never succeeds with no reply.
            raise RequestRejectedError(500, str(err)) from err

        # (4) What it produced: committed under this thread's name, and the
        # reference appended to the reply, so whoever asked can hand it on
        # without pasting it. The reference goes to one agent, the caller, so
        # the caller is granted read on it right before the reply is sent,
        # for a short while — and only a caller whose signature verified,
        # because a grant names a principal and an unsigned claim proves
        # none. A caller without one gets small replies or a bounded refusal.
        # ``grant_caller`` makes that decision and the grant, and notes the
        # reference as given.
        granted_reference: str | None = None
        if scratchpad is not None and references is not None and trace is not None:
            try:
                ref = await scratchpad.commit(result.reply, f"/replies/{trace.thread_id}.md", trace)
                log(f"{tag} committed the reply as {ref[:40]}…")
                if await references.grant_caller(ref, stream.sender):
                    log(f"{tag} granted {format_sender(stream.sender)} read on it")
                    granted_reference = ref
                else:
                    log(f"{tag} caller not verified: no ScratchPad handoff granted")
            except Exception as err:  # noqa: BLE001 — small replies can still go out
                log(f"{tag} could not hand the reply over by reference: {err}")
        reply, history_reply = delivered_reply(result.reply, granted_reference)
        await stream.send(reply)

        # The history keeps the exchange as words, not the tool traffic.
        history.append({"role": "user", "content": envelope.prompt})
        history.append({"role": "assistant", "content": history_reply})
        del history[: max(0, len(history) - cfg.agent.max_history_exchanges * 2)]

    service.on_prompt(on_prompt)
    await service.start()

    async def stop() -> None:
        # Open prompts to other agents are cancelled before the connection goes.
        await tools.aclose()
        await client.close()
        await service.stop()
        if native_scratchpad is not None:
            await native_scratchpad.close()
        await nc.close()
        bundle.wipe()

    running = RunningAgent(
        address=service.subject.prompt,
        instance_id=service.instance_id,
        identity=str(service.identity) if service.identity is not None else None,
        _stop=stop,  # type: ignore[arg-type]
    )

    # A line for whoever started the process: a script, a test, a
    # supervisor. The same fields the TypeScript agent writes.
    if cfg.agent.ready_file is not None:
        Path(cfg.agent.ready_file).write_text(
            json.dumps(
                {
                    "name": cfg.agent.name,
                    "agent": cfg.agent.kind,
                    "owner": cfg.agent.owner,
                    "subject": running.address,
                    "instance_id": running.instance_id,
                    "agent_id": running.identity,
                    "pid": os.getpid(),
                    "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
            )
            + "\n",
            encoding="utf-8",
        )
    return running


class _Lines(logging.Handler):
    """Each log record as one line to the agent's ``log``."""

    def __init__(self, log: Callable[[str], None], prefix: str) -> None:
        super().__init__(logging.INFO)
        self._log = log
        self._prefix = prefix

    def emit(self, record: logging.LogRecord) -> None:
        self._log(f"{self._prefix} {record.getMessage()}")


def _line_logger(log: Callable[[str], None], prefix: str) -> logging.Logger:
    """The SDK and the fabric package log through :mod:`logging`; this agent
    logs lines, to wherever ``log`` writes them. One logger per ``log``, so two
    agents in one process (the tests) keep their lines apart."""
    logger = logging.getLogger(f"fabric_agent.{prefix.strip('[]')}.{id(log)}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        logger.addHandler(_Lines(log, prefix))
    return logger
