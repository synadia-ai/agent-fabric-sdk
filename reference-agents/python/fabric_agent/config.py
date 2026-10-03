"""config.py — everything the agent is told, from the environment.

One process, one agent, one set of variables; the file that holds them is one
``.env`` per agent (see ``env.example``), read by :func:`load_env_file`, which
does what Node's ``--env-file`` does for the TypeScript agent: ``KEY=VALUE``
lines, ``#`` comments, no interpolation. Nothing here is a secret the
repository tracks: the credentials file and the virtual key are paths and
values in that untracked file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Mapping

#: Which of the agent tools the model is offered (see ``AgentIdentityConfig.tools``).
ToolsSetting = Literal["blocking", "all", "none"]

DEFAULT_NATS_URL = "nats://127.0.0.1:4222"
DEFAULT_KIND = "assistant"
DEFAULT_NAME = "main"
# Plain about the tools without inviting a model to act them out: a small
# model told "use the tools" tends to write tool results as text.
DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful agent on the Synadia Agent Fabric. Answer briefly and clearly, in plain text. "
    "Your tools reach the other agents: discover_agents lists them, prompt_agent asks one of them to do something. "
    "Answer yourself unless the task asks for another agent or clearly needs one; never invent a tool result."
)
DEFAULT_TOOLS = "blocking"
DEFAULT_MAX_HISTORY = 20
DEFAULT_REPLY_TIMEOUT_S = 300.0


@dataclass(frozen=True)
class NatsConfig:
    """Where and as whom to connect; the same credentials sign the agent's identity.

    Exactly one of ``context`` or ``url`` is set; with ``url``, one of
    ``creds`` (a credentials file) or ``nkey`` (a seed file).
    """

    context: str | None = None
    url: str | None = None
    creds: str | None = None
    nkey: str | None = None


@dataclass(frozen=True)
class AgentIdentityConfig:
    kind: str
    owner: str
    name: str
    description: str
    system_prompt: str
    min_sender_trust: Literal["any", "signed"]
    #: Which of the agent tools the model is offered (``AGENT_TOOLS``;
    #: ``tools.py`` has the names):
    #:
    #: - ``blocking``, the default: ``discover_agents``, ``prompt_agent`` and
    #:   ``answer_agent``. Every prompt to another agent waits for its reply.
    #: - ``all``: the six, for a model that runs prompts side by side and
    #:   collects them later.
    #: - ``none``: no tools, for a role that must answer itself (a researcher
    #:   or a writer another agent delegates to) on a model that would rather
    #:   delegate whatever it is asked, even back to its caller. The agent
    #:   still has the capability; the operator has taken it off the table.
    tools: ToolsSetting
    heartbeat_interval_s: int | None
    #: How many user/assistant exchanges the agent remembers for each
    #: verified caller; 0 for none.
    max_history_exchanges: int
    ready_file: str | None


@dataclass(frozen=True)
class ModelConfig:
    proxy_url: str
    virtual_key: str
    model: str
    timeout_s: float | None


@dataclass(frozen=True)
class AgentConfig:
    nats: NatsConfig
    agent: AgentIdentityConfig
    model: ModelConfig
    #: How long one prompt to another agent may run before it is given up (the tools' ``max_wait_s``).
    reply_timeout_s: float
    #: ``AGENT_DURABLE=1``: the agent hosts durable workflows, the demo
    #: ``durable-task``, and offers the model ``start_workflow`` (``durable.py``).
    #: Off by default.
    durable: bool = False


def load_env_file(path: str | Path) -> dict[str, str]:
    """Read ``KEY=VALUE`` lines from a file into a dict; comments and blanks skipped."""
    values: dict[str, str] = {}
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        # An inline comment after the value, as in env.example.
        if "  #" in value:
            value = value.split("  #", 1)[0].rstrip()
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def load_config(env: Mapping[str, str] | None = None) -> AgentConfig:
    """Read the configuration from ``env`` (default: the process environment).

    Raises one error naming every variable that is missing, so a first start
    fails once with the whole list rather than once per variable.
    """
    e = dict(os.environ if env is None else env)
    missing: list[str] = []

    def need(name: str) -> str:
        value = e.get(name, "")
        if value == "":
            missing.append(name)
        return value

    def optional(name: str) -> str | None:
        value = e.get(name, "")
        return None if value == "" else value

    def number(name: str, fallback: float) -> float:
        value = optional(name)
        if value is None:
            return fallback
        try:
            n = float(value)
        except ValueError:
            n = -1.0
        if n <= 0:
            raise ValueError(f'{name} must be a positive number, got "{value}"')
        return n

    def count(name: str, fallback: int) -> int:
        # A count that may be 0.
        value = optional(name)
        if value is None:
            return fallback
        try:
            n = float(value)
        except ValueError:
            n = -1.0
        if not n.is_integer() or n < 0:
            raise ValueError(f'{name} must be a whole number, 0 or more, got "{value}"')
        return int(n)

    proxy_url = need("MODEL_PROXY_URL")
    virtual_key = need("MODEL_VIRTUAL_KEY")
    model = need("MODEL_NAME")

    # Connection: a NATS context by name, or a URL with a credentials file (or
    # an nkey seed file). One of the credential sources is required, because
    # the agent signs its identity with it.
    context, creds, nkey = optional("NATS_CONTEXT"), optional("NATS_CREDS"), optional("NATS_NKEY_SEED_FILE")
    if context is not None:
        nats = NatsConfig(context=context)
    elif creds is not None:
        nats = NatsConfig(url=optional("NATS_URL") or DEFAULT_NATS_URL, creds=creds)
    elif nkey is not None:
        nats = NatsConfig(url=optional("NATS_URL") or DEFAULT_NATS_URL, nkey=nkey)
    else:
        missing.append("NATS_CONTEXT, or NATS_CREDS or NATS_NKEY_SEED_FILE (with NATS_URL)")
        nats = NatsConfig(url=DEFAULT_NATS_URL)

    min_sender_trust = optional("AGENT_MIN_SENDER_TRUST") or "any"
    if min_sender_trust not in ("any", "signed"):
        raise ValueError(f'AGENT_MIN_SENDER_TRUST must be "any" or "signed", got "{min_sender_trust}"')
    durable = optional("AGENT_DURABLE") or "0"
    if durable not in ("0", "1"):
        raise ValueError(f'AGENT_DURABLE must be "0" or "1", got "{durable}"')
    tools_setting = optional("AGENT_TOOLS") or DEFAULT_TOOLS
    if tools_setting not in ("blocking", "all", "none"):
        raise ValueError(f'AGENT_TOOLS must be "blocking", "all" or "none", got "{tools_setting}"')

    if missing:
        raise ValueError(f"missing configuration: {', '.join(missing)} (see env.example)")

    kind = optional("AGENT_KIND") or DEFAULT_KIND
    owner = optional("AGENT_OWNER") or e.get("USER") or "anon"
    name = optional("AGENT_NAME") or DEFAULT_NAME
    heartbeat = optional("AGENT_HEARTBEAT_S")
    timeout = optional("MODEL_TIMEOUT_MS")
    # The persona: one line in the environment, or a file for a longer one (a
    # role worth a page of instructions).
    prompt_file = optional("AGENT_SYSTEM_PROMPT_FILE")
    system_prompt = (
        Path(prompt_file).read_text(encoding="utf-8").strip()
        if prompt_file is not None
        else optional("AGENT_SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT
    )

    return AgentConfig(
        nats=nats,
        agent=AgentIdentityConfig(
            kind=kind,
            owner=owner,
            name=name,
            description=optional("AGENT_DESCRIPTION") or f"{kind} agent ({model})",
            system_prompt=system_prompt,
            min_sender_trust=min_sender_trust,  # type: ignore[arg-type]
            tools=tools_setting,  # type: ignore[arg-type]
            heartbeat_interval_s=int(number("AGENT_HEARTBEAT_S", 30)) if heartbeat is not None else None,
            max_history_exchanges=count("AGENT_MAX_HISTORY", DEFAULT_MAX_HISTORY),
            ready_file=optional("AGENT_READY_FILE"),
        ),
        model=ModelConfig(
            proxy_url=proxy_url,
            virtual_key=virtual_key,
            model=model,
            # In milliseconds, like the TypeScript agent's variable of the same name.
            timeout_s=number("MODEL_TIMEOUT_MS", 120_000) / 1000 if timeout is not None else None,
        ),
        reply_timeout_s=number("AGENT_REPLY_TIMEOUT_MS", DEFAULT_REPLY_TIMEOUT_S * 1000) / 1000,
        durable=durable == "1",
    )
