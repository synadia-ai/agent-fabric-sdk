"""The ready implementation of the ScratchPad port, through the ``sp`` command line.

Mirrors ``typescript/src/scratchpad-cli.ts``.

ScratchPad is the fabric's store for what agents produce: durable,
permissioned, versioned volumes, every commit, grant and read written to the
agent's timeline. There is no ScratchPad client for Python yet, so this drives
the ``sp`` CLI from the ScratchPad repository (``go build ./cmd/sp``), which is
the Go client kit with a command per API verb. The binary must be on the
machine; it connects with the agent's own credentials. Five operations are all
an agent needs:

    commit(text, path)     put the text into this agent's volume, commit it,
                           make a reference to it, and return that reference
                           as one token that fits in a prompt
    read(reference)        resolve the token (which records the read) and
                           fetch the content
    owns(reference)        whether the token points into this agent's own
                           volume, the only one it may grant on
    grant_read(reference,  let one agent read what the reference points at,
               grantee)    for a short while — the last thing done before a
                           reference leaves this agent
    granted(reference,     whom this agent granted read, and how: the ledger
            grantee)       a grant request is decided by

The last three are the :class:`ScratchPad` port the extension and the grant
request run on; the first two are the agent's own. Together they are
:class:`ScratchPadClient`, which a later implementation speaking NATS directly
will satisfy as well, once a Python ScratchPad client exists.

Every call carries the served prompt's thread and root ids, so the commit,
the grant and the read show up on the thread in the console next to the
model calls that produced and consumed the content.

The token: ``sp-ref:`` followed by the ``ref.make`` reply, base64url-encoded,
no padding: the ref record ScratchPad mints for a handoff (the volume, the
immutable root, the path, its expiry) and the source sequence the CLI wants
back when resolving it — plus ``creator``, the prompt address of the agent
that committed the content, so an agent handed the reference knows whom to
ask when it wants to hand it on (:func:`reference_creator`). A model copies
the token from one reply into the next prompt without understanding it; the
receiving agent decodes it. The TypeScript package writes and reads the same
token.

Who may read: nobody but the volume's owner, until the owner grants it. The
token is application data, not a credential (ScratchPad's ADR-0001);
ScratchPad authenticates the reader as the ``(account, user)`` the server
stamped on its connection and checks the grants on the volume. So a
reference is handed over in two moves: a grant to the one agent that is
about to receive it, then the prompt or reply that carries it. Least
authority: one grantee, one path, read only, a short expiry; nothing is
granted when content is committed, and never to everyone discovered.

Being allowed to read is not being allowed to pass on. An agent handed a
reference cannot let a third agent read it: ScratchPad v1 has no delegation,
on purpose. It does not copy the content into its own volume to get around
that either; it asks the creator, and the creator decides
(:mod:`~synadia_ai.agent_fabric.grant_request`). For that decision this keeps
a ledger of whom this agent granted what, and how: first-hand, to an agent it
handed the reference itself, or on request, to an agent someone else wanted
to hand it to. Only the first kind entitles its holder to ask for another
agent.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .scratchpad import REFERENCE_PREFIX, Grantee, GrantKind, ScratchPad, TraceIds
from .trace import active_trace

#: The ``sp`` binary when none is given: the one on PATH.
DEFAULT_SP_BIN = "sp"
#: How long a handoff reference stays resolvable: a week.
REFERENCE_TTL_S = 7 * 24 * 3600
#: How long a write session stays open.
SESSION_LEASE_S = 600
#: How long a read grant lasts: long enough for the receiving agent to read
#: what it was handed when it starts on the prompt, short enough that the
#: access does not outlive the task. The reference itself lasts a week; the
#: grant is what actually opens the door.
DEFAULT_GRANT_TTL_S = 600.0

#: The variables :func:`scratchpad_from_env` reads.
SCRATCHPAD_VOLUME_VAR = "SCRATCHPAD_VOLUME"
SCRATCHPAD_BIN_VAR = "SCRATCHPAD_BIN"
SCRATCHPAD_DIR_VAR = "SCRATCHPAD_DIR"
SCRATCHPAD_GRANT_TTL_S_VAR = "SCRATCHPAD_GRANT_TTL_S"

_DEFAULT_NATS_URL = "nats://127.0.0.1:4222"


class ScratchPadClient(ScratchPad, Protocol):
    """The agent's ScratchPad: the :class:`ScratchPad` port, which the rules for
    references run on, and the commit and read the agent makes itself."""

    async def commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        """Put ``text`` at ``path`` in this agent's volume, commit, and return the reference."""
        ...

    async def read(self, reference: str, trace: TraceIds | None) -> str:
        """Resolve a reference token (recording the read) and return the content."""
        ...


class SpCliConnection(Protocol):
    """How ``sp`` connects: the agent's own connection source.

    A NATS ``context`` by name, or a ``url`` with a ``creds`` file. ``sp`` takes
    no nkey seed alone, so an object with neither is refused.
    """

    @property
    def context(self) -> str | None: ...

    @property
    def url(self) -> str | None: ...

    @property
    def creds(self) -> str | None: ...


@dataclass(frozen=True, slots=True)
class _Connection:
    context: str | None = None
    url: str | None = None
    creds: str | None = None


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _decode_reference(reference: str) -> dict[str, Any]:
    if not reference.startswith(REFERENCE_PREFIX):
        raise ValueError(f"not a ScratchPad reference: {reference[:20]}")
    try:
        made: dict[str, Any] = json.loads(_unb64url(reference[len(REFERENCE_PREFIX) :]))
        made["ref"]["volume_id"]
    except (ValueError, KeyError, TypeError) as err:
        raise ValueError("malformed ScratchPad reference") from err
    return made


def _served_trace() -> TraceIds | None:
    scope = active_trace()
    return TraceIds(scope.thread_id, scope.root_id) if scope is not None else None


class SpCliScratchPad:
    """Commit, read and grant by reference, through one ``sp`` binary and one volume.

    The :class:`ScratchPadClient` an agent hands to :func:`scratch_pad_extension`
    and :func:`grant_request_endpoint` and commits and reads with itself.

    ``volume`` is the volume this agent writes to, by name, created on first
    commit; ``nats`` the agent's own connection source, because ``sp``
    authenticates the same way (:class:`SpCliConnection`). ``bin`` is the ``sp``
    binary, ``sp`` on PATH by default; ``dir`` a private directory for the
    CLI's saved replies, created if missing and used by its real path,
    ``scratchpad-<volume>`` under the temp directory by default.
    ``grant_ttl_s`` is how long a read grant lasts, ten minutes by default.
    ``creator`` is this agent's prompt address, written into every reference
    it makes, so an agent handed one knows whom to ask before passing it on.
    """

    def __init__(
        self,
        *,
        volume: str,
        nats: SpCliConnection,
        bin: str = DEFAULT_SP_BIN,
        dir: str | None = None,
        grant_ttl_s: float = DEFAULT_GRANT_TTL_S,
        creator: str | None = None,
    ) -> None:
        if nats.context is not None:
            self._connection = ["-context", nats.context]
        elif nats.creds is not None and nats.url is not None:
            self._connection = ["-url", nats.url, "-creds", nats.creds]
        else:
            raise ValueError(
                "ScratchPad: the sp CLI needs NATS_CREDS or NATS_CONTEXT to authenticate"
            )
        self._bin = bin
        self._dir = Path(
            dir if dir is not None else os.path.join(tempfile.gettempdir(), f"scratchpad-{volume}")
        )
        self._volume_name = volume
        self._grant_ttl_s = grant_ttl_s
        self._creator = creator
        # The volume's id and current root, learned on first use and advanced
        # by every commit.
        self._volume: dict[str, str] | None = None
        # One commit at a time. Each starts a session on the volume's current
        # root and advances it, and the agent serves several prompts at once,
        # so two commits side by side would both start from the same root.
        self._commits = asyncio.Lock()
        # Whom this agent granted read, by path: identity to the expiry, in
        # unix seconds, of its latest grant of each kind. ScratchPad knows the
        # grants but not how they came about; that is this agent's own
        # knowledge. In memory, so one ledger per process: after a restart, or
        # in another instance behind the same address, the answer is "not
        # granted", which is the safe one.
        self._ledger: dict[str, dict[str, dict[str, int]]] = {}

    def _ensure_dir(self) -> None:
        # Where the CLI's saved replies go, with every symlink resolved: ``sp``
        # refuses to save under a path with a symlink in it, and on macOS both
        # ``/tmp`` and ``$TMPDIR`` are symlinks.
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._dir = self._dir.resolve()

    async def _sp(
        self,
        args: list[str],
        trace: TraceIds | None,
        stdin: bytes | None = None,
        tool_call_id: str | None = None,
    ) -> Any:
        self._ensure_dir()
        trace_flags = ["-thread-id", trace.thread_id, "-root-id", trace.root_id] if trace else []
        if trace and tool_call_id is not None:
            trace_flags += ["-tool-call-id", tool_call_id]
        proc = await asyncio.create_subprocess_exec(
            self._bin,
            *args,
            *self._connection,
            *trace_flags,
            "-json",
            stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate(stdin)
        if proc.returncode != 0:
            # A failure is JSON on stderr (``{"error": {"code": "permission_denied", …}}``)
            # with exit 13; the code is what the log line should say.
            raise RuntimeError(f"sp {' '.join(args[:2])}: {err.decode(errors='replace').strip()}")
        return json.loads(out)

    async def _find_volume(self, trace: TraceIds | None) -> dict[str, str] | None:
        # This agent's volume if it has one already; looking never creates it.
        if self._volume is None:
            listed = await self._sp(["volume", "list"], trace)
            for v in listed.get("volumes") or []:
                if v.get("name") == self._volume_name:
                    self._volume = {"id": v["id"], "root": v["root"]}
        return self._volume

    async def _ensure_volume(self, trace: TraceIds | None) -> dict[str, str]:
        found = await self._find_volume(trace)
        if found is not None:
            return found
        created = await self._sp(
            ["volume", "create", "-name", self._volume_name, "-operation-id", str(uuid.uuid4())],
            trace,
        )
        self._volume = {"id": created["volume"]["id"], "root": created["volume"]["root"]}
        return self._volume

    async def commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        """Put ``text`` at ``path``, commit, and return the reference token."""
        async with self._commits:
            return await self._commit(text, path, trace)

    async def _commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        v = await self._ensure_volume(trace)
        stem = self._dir / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        session, change = f"{stem}.session.json", f"{stem}.change.json"
        # A write session on the current root, one put, one commit: the
        # receipt names the new root, which is what a reference points at.
        await self._sp(
            ["session", "open", "-volume-id", v["id"], "-base-root", v["root"],
             "-write-scope", "/", "-lease-seconds", str(SESSION_LEASE_S), "-save", session],
            trace,
        )  # fmt: skip
        await self._sp(
            ["put", "-session", session, "-path", path, "-source", "-", "-save", change],
            trace,
            text.encode(),
        )
        committed = await self._sp(
            ["commit", "-session", session, "-changes", change,
             "-operation-id", str(uuid.uuid4()), "-apply"],
            trace,
        )  # fmt: skip
        v["root"] = committed["receipt"]["new_root"]
        made = await self._sp(
            ["ref", "make", "-volume-id", v["id"], "-root", v["root"], "-path", path,
             "-expires-at", str(int(time.time()) + REFERENCE_TTL_S), "-save", f"{stem}.ref.json"],
            trace,
        )  # fmt: skip
        if self._creator is not None:
            made = {**made, "creator": self._creator}
        return REFERENCE_PREFIX + _b64url(json.dumps(made, separators=(",", ":")).encode())

    async def read(self, reference: str, trace: TraceIds | None) -> str:
        """Resolve a reference token (recording the read) and return the content."""
        made = _decode_reference(reference)
        ref = made["ref"]
        self._ensure_dir()
        # Resolving records the read on this agent's timeline and checks the
        # handoff is still valid; the content itself comes with ``cat``. The
        # CLI gets back what ``ref.make`` replied, without the token's ``creator``.
        file = self._dir / f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.resolve.json"
        file.write_text(
            json.dumps({"ref": ref, "source_sequence": made.get("source_sequence")}),
            encoding="utf-8",
        )
        await self._sp(["ref", "resolve", "-ref", str(file)], trace)
        got = await self._sp(
            ["cat", "-volume-id", ref["volume_id"], "-root", ref["root"],
             "-path", ref.get("path") or "/"],
            trace,
        )  # fmt: skip
        if "data_base64" in got:
            return base64.b64decode(got["data_base64"]).decode("utf-8")
        if "data" in got:
            return str(got["data"])
        raise RuntimeError("sp cat: reply carries no data")

    async def owns(self, reference: str) -> bool:
        """Whether ``reference`` points into this agent's own volume, where it may grant."""
        # An agent that has committed nothing yet has no volume, and owns
        # nothing. The port passes no thread; inside a served prompt the
        # listing that answers this still goes on that prompt's thread. A
        # token that does not decode points into no volume of this agent's:
        # ``False``, never a raise, since the extension asks this of tokens
        # other agents sent.
        own = await self._find_volume(_served_trace())
        if own is None:
            return False
        try:
            return bool(_decode_reference(reference)["ref"]["volume_id"] == own["id"])
        except ValueError:
            return False

    async def grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None,
        tool_call_id: str | None = None,
        kind: GrantKind = "first-hand",
    ) -> None:
        """Grant ``grantee`` read on what ``reference`` points at, until the grant's expiry.

        Only for a reference into this agent's own volume; anything else is
        refused before ScratchPad is asked. ``tool_call_id``, when the grant is
        made for a ``prompt_agent`` call, puts the grant under that call in the
        console. ``kind`` goes into the ledger: ``first-hand`` unless the grant
        answers another agent's request.
        """
        own = await self._find_volume(trace)
        ref = _decode_reference(reference)["ref"]
        if own is None or ref["volume_id"] != own["id"]:
            # Only a volume's owner grants on it. Reading someone else's content
            # and granting on a copy would pass on a permission this agent was
            # never given; its creator is asked instead.
            raise PermissionError(
                "the reference points into another agent's volume;"
                " only its creator can grant read on it"
            )
        path = ref.get("path") or "/"
        expires_at = int(time.time() + self._grant_ttl_s)
        # The scope is the one path the reference names, not the root: a grant
        # on the root would open every file at that commit, this agent's
        # earlier replies included. ScratchPad takes one scope kind per grant.
        await self._sp(
            ["grant", "issue", "-volume-id", own["id"],
             "-grantee-account", grantee.account, "-grantee-user", grantee.user,
             "-subtree", path, "-actions", "read",
             "-expires-at", str(expires_at), "-operation-id", str(uuid.uuid4())],
            trace,
            tool_call_id=tool_call_id,
        )  # fmt: skip
        # Into the ledger, and expired entries out of it.
        now = int(time.time())
        self._ledger = {
            p: live
            for p, readers in self._ledger.items()
            if (live := {who: until for who, until in readers.items() if max(until.values()) > now})
        }
        who = f"{grantee.account}.{grantee.user}"
        self._ledger.setdefault(path, {}).setdefault(who, {})[kind] = expires_at

    def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
        """The live grant this agent made to ``grantee`` on what ``reference``
        points at, by kind, or ``None`` when there is none or it has expired:
        the question a creator asks before it lets one reader pass the
        reference on. A first-hand grant still running is not hidden by a later
        one made on request."""
        try:
            ref = _decode_reference(reference)["ref"]
        except ValueError:
            return None
        if self._volume is None or ref["volume_id"] != self._volume["id"]:
            return None
        until = self._ledger.get(ref.get("path") or "/", {}).get(
            f"{grantee.account}.{grantee.user}", {}
        )
        now = int(time.time())
        if until.get("first-hand", 0) > now:
            return "first-hand"
        if until.get("on-request", 0) > now:
            return "on-request"
        return None


def scratchpad_from_env(
    env: Mapping[str, str] | None = None,
    *,
    creator: str | None = None,
    nats: SpCliConnection | None = None,
) -> SpCliScratchPad | None:
    """The agent's ScratchPad as the environment configures it (default: the
    process environment), or ``None`` when ``SCRATCHPAD_VOLUME`` is unset:
    ScratchPad off.

    Reads ``SCRATCHPAD_VOLUME``, ``SCRATCHPAD_BIN``, ``SCRATCHPAD_DIR`` and
    ``SCRATCHPAD_GRANT_TTL_S``, and, unless ``nats`` is given, the connection
    the agent's own configuration reads: ``NATS_CONTEXT``, or ``NATS_CREDS``
    with ``NATS_URL`` (default ``nats://127.0.0.1:4222``). An empty variable
    counts as unset. Raises :class:`ValueError` for a grant TTL that is not a
    positive number, and, like :class:`SpCliScratchPad`, for a connection
    ``sp`` cannot use.
    """
    e = os.environ if env is None else env

    def optional(name: str) -> str | None:
        value = e.get(name, "")
        return None if value == "" else value

    volume = optional(SCRATCHPAD_VOLUME_VAR)
    if volume is None:
        return None
    grant_ttl_s = DEFAULT_GRANT_TTL_S
    ttl = optional(SCRATCHPAD_GRANT_TTL_S_VAR)
    if ttl is not None:
        try:
            grant_ttl_s = float(ttl)
        except ValueError:
            grant_ttl_s = -1.0
        if not grant_ttl_s > 0 or grant_ttl_s == float("inf"):
            raise ValueError(f'{SCRATCHPAD_GRANT_TTL_S_VAR} must be a positive number, got "{ttl}"')
    if nats is None:
        context, creds = optional("NATS_CONTEXT"), optional("NATS_CREDS")
        url = optional("NATS_URL") or _DEFAULT_NATS_URL
        nats = (
            _Connection(context=context)
            if context is not None
            else _Connection(url=url, creds=creds)
        )
    return SpCliScratchPad(
        volume=volume,
        nats=nats,
        bin=optional(SCRATCHPAD_BIN_VAR) or DEFAULT_SP_BIN,
        dir=optional(SCRATCHPAD_DIR_VAR),
        grant_ttl_s=grant_ttl_s,
        creator=creator,
    )


__all__ = [
    "DEFAULT_GRANT_TTL_S",
    "DEFAULT_SP_BIN",
    "SCRATCHPAD_BIN_VAR",
    "SCRATCHPAD_DIR_VAR",
    "SCRATCHPAD_GRANT_TTL_S_VAR",
    "SCRATCHPAD_VOLUME_VAR",
    "ScratchPadClient",
    "SpCliConnection",
    "SpCliScratchPad",
    "scratchpad_from_env",
]
