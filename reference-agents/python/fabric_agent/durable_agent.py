"""durable_agent.py — the durable reference agent: the model loop is the workflow.

``agent.py`` keeps its model loop in memory: a crash of the process loses the
conversation, and the prompt it was serving is gone with every model turn and
tool call it had made. Here the loop runs as a workflow of the durable SDK,
``agent-loop``, journaled by the durable engine:

    llm-N          each model turn, one journaled step through the proxy,
                   with the two trace headers from the run's input
    tool-N-i       each tool call, one journaled step, run in the run's tool
                   scope and inside the trace the input carries
    ask-N-i        a question a prompted agent asks: the run parks on a
                   durable signal; the front door relays it to the caller
    answer-N-i     the caller's answer, carried back with ``answer_agent``

After a crash the run is taken up again by a worker, here or in another
process of the same agent, and the loop replays from its journal: a recorded
model turn returns what it returned, a recorded tool call returns its result,
and execution resumes at the first step not yet journaled.

What is exactly-once and what is at-least-once, plainly:

  - A model turn whose step ended is never made again: it is journaled before
    the next step begins. A model turn in flight when the process died (its
    step began, its answer was not journaled) is made again.
  - A tool call in flight when the process died runs again. ``prompt_agent``
    carries no idempotency key, so the prompted agent may be prompted twice,
    and a second edge is written for it. ``discover_agents`` is a read;
    running it twice is harmless.
  - A call that was waiting on a question when the process died is gone with
    the process's connection: the caller's answer reaches ``answer_agent`` as
    a call it does not know, and the model reads that in words.
  - The reply to the prompt that was being served when the process died is
    not delivered. The run completes in the journal, but the caller's prompt
    stream ended with the process. Delivering it is the job of a durable
    prompt, which the protocol does not have yet; nothing here works around
    that.

The front door is the reference agent's: ``AgentService`` with the fabric's
tracing and the signed identity (behaviour 1, as in ``agent.py``), the model
through the proxy with the trace headers (2), the agent tools (3) and
ScratchPad references (4). The run joins the prompt that started it with the
fabric package's helpers, as in ``durable.py`` (5).

The same agent as ``typescript/src/durable-agent.ts``, in Python.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import time
import uuid
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import nats
from synadia_ai.agent_fabric import (
    READS_REFERENCES_KEY,
    ScratchPadClient,
    TraceIds,
    durable_headers,
    durable_run_id,
    durable_trace,
    fabric_tracing,
    find_references,
    grant_request_endpoint,
    native_scratchpad_from_env,
    scratch_pad_extension,
    with_durable_trace,
)
from synadia_ai.agent_service import AgentService, PromptStream, RequestRejectedError, ServiceIdentity
from synadia_ai.agents import (
    AGENT_TOOLS_QUESTION_REFUSAL,
    Agents,
    AgentSubject,
    AgentTools,
    Envelope,
    Identity,
    format_sender,
    resolve_nats_connection_bundle,
)
from synadia_durable import Ctx, DurableTimeoutError, StartOptions, Workflow, create_client, create_worker, define_workflow

from .agent import MAX_CONCURRENT_PROMPTS, RunningAgent, _line_logger
from .config import AgentConfig
from .durable import _SdkLogger
from .model import ChatMessage, ModelClient
from .reply import delivered_reply
from .tools import chat_tools, offered_tools

#: The workflow's name: a subject token and a consumer name to the engine.
AGENT_LOOP = "agent-loop"

#: What the model is told in place of an empty answer.
NO_REPLY = "Your last answer was empty. Answer the prompt you are serving in words."

# The run's input is ``{"prompt": …, "trace": …, "caller": …}``: the prompt, the
# trace of the prompt being served, and the served prompt's sender ID when its
# signature verified (``prompt_agent`` refuses to prompt it back). Its result is
# ``{"answer": …, "modelTurns": …}``, the keys the TypeScript agent's are.


class _RunScopes:
    """The agent tools' scope of each run in this process, kept open across the run's steps.

    A worker serves no prompt, so the tools' calls need a scope of their own:
    ``AgentTools.prompt_scope`` opens one, with the run's verified caller for
    the loop guard, and cancels the calls still open when it exits. A call
    that asked a question must stay open while the run waits on the answer,
    across steps, so the scope is held open by a task until the run ends, and
    each step runs its tool in a copy of the context taken inside it. The
    scope lives in memory: after a crash, a run is given a new one and the
    calls of the old one are gone.
    """

    def __init__(self, tools: AgentTools) -> None:
        self._tools = tools
        self._open: dict[str, tuple[asyncio.Future[contextvars.Context], asyncio.Event, asyncio.Task[None]]] = {}

    async def run(self, run_id: str, caller: str | None, coro: Coroutine[Any, Any, str]) -> str:
        """Run ``coro`` in the run's scope, opened on first use."""
        entry = self._open.get(run_id)
        if entry is None:
            ready: asyncio.Future[contextvars.Context] = asyncio.get_running_loop().create_future()
            release = asyncio.Event()

            async def hold() -> None:
                try:
                    async with self._tools.prompt_scope(caller=caller):
                        ready.set_result(contextvars.copy_context())
                        await release.wait()
                except BaseException as err:
                    if not ready.done():
                        ready.set_exception(err)
                    raise

            entry = (ready, release, asyncio.create_task(hold()))
            self._open[run_id] = entry
        scope = await asyncio.shield(entry[0])
        return await asyncio.create_task(coro, context=scope.copy())

    def release(self, run_id: str) -> None:
        """Close the run's scope: its open calls are cancelled."""
        entry = self._open.pop(run_id, None)
        if entry is not None:
            entry[1].set()

    async def release_all(self) -> None:
        tasks = [entry[2] for entry in self._open.values()]
        for run_id in list(self._open):
            self.release(run_id)
        await asyncio.gather(*tasks, return_exceptions=True)


class _Questions:
    """Where a question is handed to the front door serving the prompt, if one in this process is."""

    def __init__(self) -> None:
        self._listeners: dict[str, Callable[[dict[str, str]], None]] = {}

    def on(self, run_id: str, listener: Callable[[dict[str, str]], None]) -> None:
        self._listeners[run_id] = listener

    def off(self, run_id: str) -> None:
        self._listeners.pop(run_id, None)

    def emit(self, run_id: str, question: dict[str, str]) -> None:
        listener = self._listeners.get(run_id)
        if listener is not None:
            listener(question)


def agent_loop_workflow(
    *,
    model: ModelClient,
    tools: AgentTools,
    tool_definitions: list[dict[str, Any]],
    scopes: _RunScopes,
    questions: _Questions,
    scratchpad: ScratchPadClient | None,
    system_prompt: str,
    question_timeout_s: float,
    max_tool_rounds: int = 8,
) -> Workflow[dict[str, Any], dict[str, Any]]:
    """The model loop as the workflow ``agent-loop``."""

    async def run(ctx: Ctx, input: dict[str, Any]) -> dict[str, Any]:
        # The run's tool scope is released when the loop returns or fails. A run
        # that parks on a question does neither: the SDK cancels its task,
        # which is not a failure, so the scope, and the call that asked, stay
        # open for the answer.
        try:
            result = await loop(ctx, input)
        except asyncio.CancelledError:
            raise
        except Exception:
            scopes.release(ctx.run_id)
            raise
        scopes.release(ctx.run_id)
        return result

    async def loop(ctx: Ctx, input: dict[str, Any]) -> dict[str, Any]:
        trace = input.get("trace")
        headers = durable_headers(trace)

        # (4) What it was handed: the references in the prompt, read in one step.
        user_content: str = input["prompt"]
        refs = find_references(input["prompt"]) if scratchpad is not None else []
        if refs:
            user_content = await ctx.run("read-references", read_references, input, refs)

        messages: list[ChatMessage] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]
        empty_replies = 0
        turn = 0
        while True:
            offered = tool_definitions if turn < max_tool_rounds else []

            # (2) A model turn: journaled once. On replay this returns the
            # recorded message, and the model is not called again.
            async def model_turn(offered: list[dict[str, Any]] = offered) -> dict[str, Any]:
                completion = await model.complete(messages, offered, headers)
                return dict(completion.message)

            message: dict[str, Any] = await ctx.run(f"llm-{turn}", model_turn)
            messages.append(message)  # type: ignore[arg-type]
            calls = (message.get("tool_calls") or []) if offered else []
            if not calls:
                answer = message.get("content") or ""
                if answer.strip():
                    return {"answer": answer, "modelTurns": turn + 1}
                empty_replies += 1
                if empty_replies > 1:
                    raise RuntimeError(f"the model returned no reply: its answer was empty {empty_replies} times")
                messages.pop()
                messages.append({"role": "user", "content": NO_REPLY})
                turn += 1
                continue
            # (3) Each tool call: one step, in the run's scope and the prompt's
            # trace, with the model turns so far as the trace's turn count, so an
            # edge ``prompt_agent`` writes sits where the handler's would.
            turns = turn + 1
            for i, call in enumerate(calls):
                fn = call["function"]
                content: str = await ctx.run(
                    f"tool-{turn}-{i}", run_tool, ctx.run_id, input, fn["name"], fn["arguments"], call["id"], turns
                )
                # A question from the prompted agent: the run parks on a durable
                # signal, and the front door asks the caller. The model sees the
                # call's result once the caller has answered.
                to = _address_of(fn["name"], fn["arguments"])
                q = 0
                while (asked := _question_of(content, to)) is not None:
                    suffix = f"{turn}-{i}" if q == 0 else f"{turn}-{i}-{q}"
                    await_name = f"ask-{suffix}"

                    # A coroutine, so it runs on the event loop the front door listens on.
                    async def relay(asked: dict[str, str] = asked, await_name: str = await_name) -> str:
                        relayed = {"awaitName": await_name, "question": asked["question"]}
                        if "address" in asked:
                            relayed["address"] = asked["address"]
                        questions.emit(ctx.run_id, relayed)
                        return "relayed"

                    await ctx.run(f"ask-request-{suffix}", relay)
                    try:
                        signalled = await ctx.wait(await_name, timeout_ms=int(question_timeout_s * 1000))
                        answer = str(signalled["answer"])
                    except DurableTimeoutError:
                        answer = AGENT_TOOLS_QUESTION_REFUSAL
                    args = json.dumps({"call_id": asked["callId"], "answer": answer})
                    content = await ctx.run(
                        f"answer-{suffix}", run_tool, ctx.run_id, input, "answer_agent", args, call["id"], turns
                    )
                    q += 1
                messages.append({"role": "tool", "tool_call_id": call["id"], "content": content})
            turn += 1

    async def run_tool(
        run_id: str, input: dict[str, Any], name: str, args: Any, tool_call_id: str, turns: int
    ) -> str:
        async def in_trace() -> str:
            with with_durable_trace(input.get("trace"), turns):
                return json.dumps(await tools.execute(name, args, tool_call_id=tool_call_id))

        return await scopes.run(run_id, input.get("caller"), in_trace())

    async def read_references(input: dict[str, Any], refs: list[str]) -> str:
        assert scratchpad is not None
        content: str = input["prompt"]
        trace = input.get("trace")
        ids = TraceIds(trace["thread_id"], trace["root_id"]) if isinstance(trace, dict) else None
        for ref in refs:
            try:
                text = await scratchpad.read(ref, ids)
                content += f"\n\n--- content handed over as {ref} ---\n{text}"
            except Exception as err:  # noqa: BLE001 — told to the model in words
                content += f"\n\n--- {ref} could not be read: {err} ---"
        return content

    return define_workflow(AGENT_LOOP, run)


def _address_of(tool: str, args: Any) -> str | None:
    """Whom a ``prompt_agent`` call went to, from its arguments."""
    if tool != "prompt_agent":
        return None
    try:
        parsed = json.loads(args) if isinstance(args, str) else args
    except ValueError:
        return None
    address = parsed.get("address") if isinstance(parsed, dict) else None
    return address if isinstance(address, str) else None


def _question_of(content: str, to: str | None) -> dict[str, str] | None:
    """The question in a tool's result, when the call waits on one."""
    try:
        r = json.loads(content)
    except ValueError:
        return None
    if not isinstance(r, dict) or r.get("state") != "input_required":
        return None
    call_id, question = r.get("call_id"), r.get("question")
    if not isinstance(call_id, str) or not isinstance(question, str):
        return None
    address = r.get("address") if isinstance(r.get("address"), str) else to
    return {"callId": call_id, "question": question, **({"address": address} if address else {})}


async def start_durable_agent(
    cfg: AgentConfig,
    log: Callable[[str], None] = print,
    *,
    env: dict[str, str] | None = None,
    scratchpad: ScratchPadClient | None = None,
) -> RunningAgent:
    """Start the durable agent: the worker that runs ``agent-loop``, and the front door."""
    # (1) The connection and the signer from one credentials snapshot.
    bundle = resolve_nats_connection_bundle(
        context=cfg.nats.context, url=cfg.nats.url, creds=cfg.nats.creds, nkey=cfg.nats.nkey, identity="signed"
    )
    nc = await nats.connect(**bundle.connection_options)
    signer = bundle.signer
    model = ModelClient(
        proxy_url=cfg.model.proxy_url,
        virtual_key=cfg.model.virtual_key,
        model=cfg.model.model,
        **({"timeout_s": cfg.model.timeout_s} if cfg.model.timeout_s is not None else {}),
    )
    address = AgentSubject.new(cfg.agent.kind, cfg.agent.owner, cfg.agent.name).prompt

    native_scratchpad = (
        await native_scratchpad_from_env(env, creator=address, nc=nc) if scratchpad is None else None
    )
    scratchpad = native_scratchpad if scratchpad is None else scratchpad

    tracing = fabric_tracing()
    # (3) The caller side and the agent tools, as in ``agent.py``. The tools'
    # request interceptor is not on the service: the calls run on the worker,
    # in the run's scope (``_RunScopes``), not in the handler.
    client = Agents(nc=nc, identity=Identity(signer=signer), interceptors=[tracing.prompt_interceptor])
    references = scratch_pad_extension(scratch_pad=scratchpad, agents=client) if scratchpad is not None else None
    tools = AgentTools(
        client,
        tools=offered_tools(cfg.agent.tools),
        self_address=address,
        max_wait_s=cfg.reply_timeout_s,
        extensions=[references] if references is not None else [],
        logger=_line_logger(log, "[tools]"),
    )
    scopes = _RunScopes(tools)
    questions = _Questions()

    # (5) The loop, on a worker on this connection; the engine holds the
    # journal, and the agent creates nothing.
    agent_loop = agent_loop_workflow(
        model=model,
        tools=tools,
        tool_definitions=[] if cfg.agent.tools == "none" else chat_tools(tools),
        scopes=scopes,
        questions=questions,
        scratchpad=scratchpad,
        system_prompt=cfg.agent.system_prompt,
        question_timeout_s=cfg.reply_timeout_s,
    )
    worker = create_worker(nc, [agent_loop], logger=_SdkLogger(log))
    await worker.start()
    runs = create_client(nc)

    service = AgentService(
        agent=cfg.agent.kind,
        owner=cfg.agent.owner,
        session_name=cfg.agent.name,
        nc=nc,
        description=cfg.agent.description,
        interceptors=[
            tracing.request_interceptor,
            *([references.request_interceptor] if references is not None else []),
        ],
        heartbeat_extras=tracing.heartbeat_extras,
        identity=ServiceIdentity(signer=signer),
        min_sender_trust=cfg.agent.min_sender_trust,
        # The front door awaits the run's result while it serves a prompt, so a
        # host that serves one prompt at a time would queue every other prompt
        # behind it; the Python host does unless told otherwise. Four at once,
        # as the reference agent serves.
        max_concurrent_prompts=MAX_CONCURRENT_PROMPTS,
        extra_metadata={READS_REFERENCES_KEY: "true"} if scratchpad is not None else None,
        extra_endpoints=(
            [grant_request_endpoint(prompt_address=address, scratch_pad=scratchpad, logger=_line_logger(log, "[sp-grant]"))]
            if scratchpad is not None
            else []
        ),
        **({"heartbeat_interval_s": cfg.agent.heartbeat_interval_s} if cfg.agent.heartbeat_interval_s else {}),
    )

    # The front door: a thin relay, not durable itself. It starts the run, asks
    # the caller what the run parks on, and sends the run's answer.
    async def on_prompt(envelope: Envelope, stream: PromptStream) -> None:
        # (5) The run of this prompt: ``<thread_id>-prompt``, joined to the
        # served thread itself rather than to a tool call. The run id is the
        # start's idempotency key: the same prompt again, on the same thread,
        # finds the run it started and waits for that one.
        run_id = durable_run_id("prompt") or f"prompt-{uuid.uuid4()}"
        trace = durable_trace()
        sender = stream.sender
        caller = str(sender.id) if sender is not None and sender.trust == "verified" else None
        tag = f"[{run_id[:8]}]"
        log(f"{tag} prompt from {format_sender(sender)}: {envelope.prompt[:80]}")

        relays: set[asyncio.Task[None]] = set()

        async def ask(q: dict[str, str]) -> None:
            asked = f"{q['address']} asks: {q['question']}" if "address" in q else q["question"]
            try:
                answer = (await stream.ask(asked, timeout=cfg.reply_timeout_s)).prompt
            except Exception:  # noqa: BLE001 — no answer is a refusal
                answer = AGENT_TOOLS_QUESTION_REFUSAL
            try:
                await runs.signal(run_id, q["awaitName"], {"answer": answer})
            except Exception as err:  # noqa: BLE001 — logged; the run waits on
                log(f"{tag} could not signal {q['awaitName']}: {err}")

        def relay(q: dict[str, str]) -> None:
            task = asyncio.create_task(ask(q))
            relays.add(task)
            task.add_done_callback(relays.discard)

        # Listen before the run starts, so a question is never missed.
        questions.on(run_id, relay)
        try:
            run_input: dict[str, Any] = {
                "prompt": envelope.prompt,
                **({"trace": trace} if trace is not None else {}),
                **({"caller": caller} if caller is not None else {}),
            }
            handle = await runs.start(agent_loop, run_input, StartOptions(run_id=run_id))
            log(f"{tag} durable run {run_id}")
            result = await handle.result(timeout_ms=cfg.reply_timeout_s * 1000)
            log(f"{tag} answered after {result['modelTurns']} model turn(s)")
            reply, _history = delivered_reply(result["answer"])
            await stream.send(reply)
        except Exception as err:
            log(f"{tag} failed: {type(err).__name__}: {err}")
            raise RequestRejectedError(500, str(err)) from err
        finally:
            questions.off(run_id)

    service.on_prompt(on_prompt)
    await service.start()

    async def stop() -> None:
        await service.stop()
        await worker.stop()
        await scopes.release_all()
        await tools.aclose()
        await client.close()
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


__all__ = ["AGENT_LOOP", "agent_loop_workflow", "start_durable_agent"]
