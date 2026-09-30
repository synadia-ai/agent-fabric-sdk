"""The ScratchPad extension of the agent tools.

The fabric's rules for references, on the three hooks of the protocol SDK's
``AgentTools`` (``docs/agent-tools.md`` §6.3 there; ``agent-fabric``
``docs/agent-tools.md`` §2.2). Mirrors ``typescript/src/scratchpad-extension.ts``.

- **discovery fields:** ``reads_scratchpad_references``, from the agent's
  registration (``scratchpad_refs_ok: "true"``).
- **prompt rewrite:** checks each ``sp-ref:`` token in the prompt and gets the
  target read on it before the prompt goes out. A token this agent was not
  given refuses the prompt; a target that reads no references gets the text
  without them; on this agent's own content it grants read itself,
  first-hand, and a grant that fails refuses the prompt; on another agent's
  content it asks the creator (:mod:`~synadia_ai.agent_fabric.grant_request`),
  and a refusal or no answer takes that reference out. Removals add
  ``references_removed`` and ``note`` to the call's results; a prompt that was
  nothing but removed references is refused.
- **reply look:** remembers the references that arrive in a reply or a
  question, so the agent may hand them on.

Every grant, made here or asked of a creator, carries the served prompt's
thread and root (:func:`~synadia_ai.agent_fabric.active_trace`) and the
model's tool-call ID, so it shows under the tool call that caused it.

What the agent was given is what it may hand on: the references it committed
(:meth:`ScratchPadExtension.remember`, or :meth:`ScratchPadExtension.grant_caller`
on the reply side), the ones in the prompts it serves
(:attr:`ScratchPadExtension.request_interceptor`), and the ones in the replies
and questions its calls bring back (the reply look).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from synadia_ai.agents import (
    AgentToolsExtension,
    AgentToolsPromptContext,
    AgentToolsPromptRewrite,
    AgentToolsReplyContext,
    VerifiedSender,
)

from .grant_request import DEFAULT_GRANT_REQUEST_TIMEOUT_S, GrantReply, request_grant
from .scratchpad import (
    ResolvesReferences,
    ScratchPad,
    TraceIds,
    _resolve,
    find_references,
    grantee_from_identity,
    reads_references,
    reference_creator,
    remove_references,
)
from .trace import active_trace, valid_tool_call_id

if TYPE_CHECKING:
    from synadia_ai.agent_service import CallNext, RequestInterceptorContext
    from synadia_ai.agents import Agent, Agents, SenderInfo

#: The field ``discover_agents`` entries get.
READS_SCRATCHPAD_REFERENCES_FIELD = "reads_scratchpad_references"


class _RememberingInterceptor:
    """A request interceptor that remembers the references in every prompt served."""

    def __init__(self, extension: ScratchPadExtension) -> None:
        self._extension = extension

    async def around_request(self, ctx: RequestInterceptorContext, call_next: CallNext) -> None:
        self._extension.remember(ctx.envelope.prompt)
        await call_next()


class ScratchPadExtension(AgentToolsExtension):
    """The extension; build it with :func:`scratch_pad_extension`."""

    def __init__(
        self,
        *,
        scratch_pad: ScratchPad,
        agents: Agents,
        discover_timeout: float | None = None,
        grant_request_timeout_s: float = DEFAULT_GRANT_REQUEST_TIMEOUT_S,
    ) -> None:
        self._scratch_pad = scratch_pad
        self._agents = agents
        self._discover_timeout = discover_timeout
        self._grant_request_timeout_s = grant_request_timeout_s
        # Every reference this agent was given, exactly as it came.
        self._given: set[str] = set()
        # Live handles by address, from discovery: a creator is asked only
        # when it is on the fabric with a verified identity.
        self._known: dict[str, Agent] = {}
        #: For the agent's ``AgentService`` (``interceptors=[...]``): remembers
        #: the references in every prompt it serves.
        self.request_interceptor = _RememberingInterceptor(self)

    def remember(self, text: str) -> None:
        """Note the references in ``text`` as given to this agent: what it
        committed, or received some way the hooks do not see."""
        self._given.update(find_references(text))

    async def grant_caller(self, reference: str, sender: SenderInfo | None) -> bool:
        """The reply side: before a reply carrying ``reference``, this agent's own,
        goes out, remember it and grant the served prompt's sender read on it,
        first-hand.

        Only a sender whose signature verified, since a grant names a principal
        and an unsigned claim proves none. ``True`` when granted, so the
        reference may go into the reply; ``False`` for a sender that did not
        verify. Raises when the reference is not this agent's own or the grant
        fails. The commit itself stays the agent's.
        """
        self.remember(reference)
        if not isinstance(sender, VerifiedSender):
            return False
        if not await _resolve(self._scratch_pad.owns(reference)):
            raise PermissionError(
                "the reference points into another agent's volume; only its creator grants"
            )
        await _resolve(
            self._scratch_pad.grant_read(
                reference,
                grantee_from_identity(str(sender.id)),
                _served_trace(),
                None,
                "first-hand",
            )
        )
        return True

    async def discovery_fields(self, agent: Agent) -> Mapping[str, Any] | None:
        """The discovery fields hook."""
        self._note(agent)
        return {READS_SCRATCHPAD_REFERENCES_FIELD: reads_references(agent.metadata)}

    async def before_prompt(  # noqa: PLR0911
        self, ctx: AgentToolsPromptContext
    ) -> AgentToolsPromptRewrite | None:
        """The prompt rewrite hook."""
        address, target = ctx.address, ctx.target
        found = find_references(ctx.prompt)
        if not found:
            return None

        # Only to an agent that reads references. Any other gets the text
        # without them, and nothing is asked or granted for it.
        if not reads_references(target.metadata):
            prompt = remove_references(ctx.prompt)
            if not prompt:
                return AgentToolsPromptRewrite(
                    error=f'the prompt was not sent: "{address}" does not read ScratchPad '
                    "references (discover_agents: reads_scratchpad_references is false), and the "
                    "prompt held nothing but references; put the content they point at into the "
                    "prompt itself"
                )
            return AgentToolsPromptRewrite(
                prompt=prompt,
                fields={
                    "references_removed": len(found),
                    "note": f'"{address}" does not read ScratchPad references: {len(found)} '
                    "reference(s) were removed from your prompt, it got only the text, and nothing "
                    "was granted",
                },
            )

        # Only a reference this agent was given, exactly as it came.
        references = list(dict.fromkeys(found))
        unknown = [r for r in references if r not in self._given]
        if unknown:
            return AgentToolsPromptRewrite(
                error=f"the prompt was not sent: {len(unknown)} of its ScratchPad references "
                f"({unknown[0][:24]}…) is not one you were given. Copy each reference exactly as "
                "you received it, the whole token, or leave it out."
            )

        # And be allowed to read: one grant per reference, to this one agent,
        # right before the prompt goes out, and only to an identity discovery
        # verified.
        if target.identity is None or not target.id_sig_verified:
            return AgentToolsPromptRewrite(
                error=f'cannot hand a ScratchPad reference to "{address}": its identity is not '
                "verified, so no read grant can be issued; put the content in the prompt instead"
            )
        identity = str(target.identity)
        grantee = grantee_from_identity(identity)
        trace = _served_trace()
        tool_call_id = (
            ctx.tool_call_id
            if ctx.tool_call_id is not None and valid_tool_call_id(ctx.tool_call_id)
            else None
        )
        refused: list[str] = []
        reason = ""
        for reference in references:
            # On its own content the agent grants itself; a grant that fails
            # means the prompt is not sent.
            try:
                if await _resolve(self._scratch_pad.owns(reference)):
                    await _resolve(
                        self._scratch_pad.grant_read(
                            reference, grantee, trace, tool_call_id, "first-hand"
                        )
                    )
                    continue
            except Exception as err:
                return AgentToolsPromptRewrite(
                    error=f'could not grant "{address}" read on {reference[:32]}…: '
                    f"{_describe(err)}; the prompt was not sent"
                )
            # On anyone else's content only the creator can, so it is asked.
            answer = await self._ask_creator(reference, address, identity, trace, tool_call_id)
            if not answer["granted"]:
                refused.append(reference)
                reason = answer["reason"]
        if not refused:
            return None

        removed = sum(1 for r in found if r in refused)
        prompt = remove_references(ctx.prompt, refused)
        if not prompt:
            return AgentToolsPromptRewrite(
                error="the prompt was not sent: it held nothing but references, and their creator "
                f'did not grant "{address}" read ({reason}); put the content they point at into '
                "the prompt itself"
            )
        return AgentToolsPromptRewrite(
            prompt=prompt,
            fields={
                "references_removed": removed,
                "note": f"{removed} reference(s) were removed from your prompt, and "
                f'"{address}" got only the text: you did not create that content, and its creator '
                f'did not grant "{address}" read ({reason}). If it needs the content, put the '
                "content itself in a prompt",
            },
        )

    async def after_reply(self, ctx: AgentToolsReplyContext) -> Mapping[str, Any] | None:
        """The reply look hook."""
        self.remember(ctx.text)
        return None

    async def _ask_creator(
        self,
        reference: str,
        target_address: str,
        target_identity: str,
        trace: TraceIds | None,
        tool_call_id: str | None,
    ) -> GrantReply:
        # Ask the creator of a reference this agent was handed to grant the
        # target read on it. The creator is the address the token names, and
        # it must be on the fabric with a verified identity: a request to
        # anyone else could not be answered with a grant anyway. A target
        # that is the creator reads its own volume and needs no grant.
        address = reference_creator(reference)
        if address is None and isinstance(self._scratch_pad, ResolvesReferences):
            try:
                address = (await _resolve(self._scratch_pad.resolve_reference(reference, trace)))[
                    "creator"
                ]
            except Exception:
                return {"granted": False, "reason": "the reference could not be resolved"}
        if address is None:
            return {"granted": False, "reason": "the reference does not name its creator"}
        if address == target_address:
            return {"granted": True}
        creator = await self._lookup(address)
        if creator is None or not creator.id_sig_verified:
            return {
                "granted": False,
                "reason": f"its creator, {address}, is not on the fabric with a verified identity",
            }
        request: dict[str, Any] = {"reference": reference, "grantee": target_identity}
        if trace is not None:
            labels = {"thread_id": trace.thread_id, "root_id": trace.root_id}
            if tool_call_id is not None:
                labels["tool_call_id"] = tool_call_id
            request["trace"] = labels
        return await request_grant(
            self._agents, address, request, timeout_s=self._grant_request_timeout_s
        )

    async def _lookup(self, address: str) -> Agent | None:
        # The handle for an address: from discovery so far, else from a fresh one.
        known = self._known.get(address)
        if known is not None:
            return known
        try:
            for handle in await self._agents.discover(timeout=self._discover_timeout):
                self._note(handle)
        except Exception:
            pass  # not found, as far as the caller can tell
        return self._known.get(address)

    def _note(self, handle: Agent) -> None:
        # Remember a handle, preferring one whose identity verifies.
        known = self._known.get(handle.prompt_subject)
        if known is None or handle.id_sig_verified or not known.id_sig_verified:
            self._known[handle.prompt_subject] = handle


def scratch_pad_extension(
    *,
    scratch_pad: ScratchPad,
    agents: Agents,
    discover_timeout: float | None = None,
    grant_request_timeout_s: float = DEFAULT_GRANT_REQUEST_TIMEOUT_S,
) -> ScratchPadExtension:
    """The ScratchPad extension for ``AgentTools`` (``extensions=[...]``).

    - ``scratch_pad``: the agent's own ScratchPad, behind the port.
    - ``agents``: the client grant requests are signed and sent with, and
      creators are looked up through: the one ``AgentTools`` runs on, with the
      agent's signer.
    - ``discover_timeout``: how long a lookup of a creator waits, in seconds;
      ``None`` uses the SDK's discovery default.
    - ``grant_request_timeout_s``: how long a creator's answer is waited for.
    """
    return ScratchPadExtension(
        scratch_pad=scratch_pad,
        agents=agents,
        discover_timeout=discover_timeout,
        grant_request_timeout_s=grant_request_timeout_s,
    )


def _served_trace() -> TraceIds | None:
    scope = active_trace()
    return TraceIds(scope.thread_id, scope.root_id) if scope is not None else None


def _describe(err: BaseException) -> str:
    return str(err) or type(err).__name__


__all__ = [
    "READS_SCRATCHPAD_REFERENCES_FIELD",
    "ScratchPadExtension",
    "scratch_pad_extension",
]
