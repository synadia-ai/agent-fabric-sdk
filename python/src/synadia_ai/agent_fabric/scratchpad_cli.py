"""The ready implementation of the ScratchPad port, through the ``sp`` command line.

Mirrors ``typescript/src/scratchpad-cli.ts``.

ScratchPad is the fabric's store for what agents produce: durable,
permissioned volumes, every commit, grant and read written to the agent's
timeline. There is no ScratchPad client for Python yet, so this drives the sp
v2 command line from the ScratchPad repository (``go build -o sp ./cmd/sp``).
The binary must be on the machine; it connects with the agent's own
credentials. Five operations are all an agent needs:

    commit(text, path)     publish the text as this agent's reply, retained
                           for ten minutes, and return the reference the CLI
                           made for it: one token that fits in a prompt
    read(reference)        fetch the exact bytes the reference names
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

The CLI keeps a small private workspace in ``dir``: which volume this agent
owns, and the one command it may still have to finish. A command whose
outcome is unknown (the connection dropped after sending) stays pending
there, and the CLI refuses any different command until that one is resolved.
This never resets or replaces it; it only asks the CLI to finish the same
command. Keep the directory across restarts.

Each commit is a new root that holds only that reply, not every earlier one,
and the CLI retains it for ten minutes in the same step. The volume has a
few retention slots and a small content allowance. When they are full, this
asks the CLI to release expired retention and collect content nothing
retains any more, then tries the same commit once more. It first reads the
volume: with every retention slot held by a pin that cannot be released now,
cleanup cannot free one, so the commit fails at once and the volume stays open
for the agents reading earlier replies. A live handoff is never evicted to
make room: the commit fails, and the agent answers in plain text instead. A
cleanup the CLI cannot finish stays saved in the workspace; the next mutation
asks the CLI to recover it, so an interrupted cleanup never leaves the volume
closed.

The token: ``sp-ref:`` followed by base64url JSON, no padding, made by the
CLI: the account and volume (with the incarnation, ``creation_id``), the
immutable root, the path, the retention slot, the expiry, and ``creator``,
the prompt address of the agent that committed it, so an agent handed the
reference knows whom to ask when it wants to hand it on
(:func:`reference_creator`). This returns the token exactly as the CLI made
it. It checks a token's shape before starting the CLI, so a malformed or
oversized one is refused early; the CLI checks it completely. The TypeScript
package reads and writes the same token.

Who may read: nobody but the volume's owner, until the owner grants it. The
token is application data, not a credential: ScratchPad authenticates the
reader as the ``(account, user)`` the server stamped on its connection and
checks the grants on the volume. So a reference is handed over in two moves:
a grant to the one agent that is about to receive it, then the prompt or
reply that carries it. Least authority: one grantee, one root, one path,
read only, a short expiry; nothing is granted when content is committed, and
never to everyone discovered. A grant goes only to a principal in the
reference's own account; the CLI refuses any other, and refuses to read
another account's token.

Being allowed to read is not being allowed to pass on. An agent handed a
reference cannot let a third agent read it: ScratchPad has no delegation, on
purpose. It does not copy the content into its own volume to get around that
either; it asks the creator, and the creator decides
(:mod:`~synadia_ai.agent_fabric.grant_request`). For that decision this keeps
a ledger of whom this agent granted what, and how: first-hand, to an agent it
handed the reference itself, or on request, to an agent someone else wanted
to hand it to. Only the first kind entitles its holder to ask for another
agent.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
import re
import tempfile
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, TypeGuard

from .scratchpad import REFERENCE_PREFIX, Grantee, GrantKind, ScratchPad, TraceIds
from .trace import active_trace

#: The ``sp`` binary when none is given: the one on PATH.
DEFAULT_SP_BIN = "sp"
#: How long a committed reply stays retained, and its reference valid.
HANDOFF_TTL_S = 600
#: How long a read grant lasts at most: long enough for the receiving agent to
#: read what it was handed when it starts on the prompt, short enough that the
#: access does not outlive the task. A grant also never outlives the
#: reference it is on.
DEFAULT_GRANT_TTL_S = 600.0
#: Seconds a grant stays short of its reference's expiry. The CLI checks the
#: bound on its own clock a moment later, so a grant asked for to the exact
#: second could outlive the reference by the time it arrives.
EXPIRY_MARGIN_S = 5
#: Live entries the grant ledger holds; ScratchPad itself has 16 grant slots.
MAX_LEDGER = 16
#: A reference token's size bound, the CLI's.
MAX_REFERENCE_BYTES = 16 * 1024
#: The token version this reads, and the bounds of its path and creator, the CLI's.
_REFERENCE_VERSION = 2
_MAX_PATH_BYTES = 256
_MAX_CREATOR_BYTES = 512
#: Retention and grant slots in a volume, as the CLI describes it.
RETENTION_SLOTS = 8
GRANT_SLOTS = 16
#: The largest file a read returns: the SDK's logical limit.
MAX_READ_BYTES = 16 * 1024 * 1024
#: A read's stdout: the file in base64, plus room for the JSON around it.
MAX_READ_STDOUT = -(-MAX_READ_BYTES // 3) * 4 + 64 * 1024
#: Every other reply, and every error, is small.
MAX_STDOUT = 256 * 1024
MAX_STDERR = 64 * 1024

_ACCOUNT = re.compile(r"A[A-Z2-7]{55}")
_VOLUME = re.compile(r"[0-9A-Za-z]{1,64}")
_CREATION = re.compile(r"[0-9a-f]{32}")
_ROOT = re.compile(r"[A-Za-z0-9_-]{43}")
_BASE64URL = re.compile(r"[A-Za-z0-9_-]+")
_REFERENCE_FIELDS = {
    "version",
    "creator",
    "account",
    "target",
    "root",
    "generation",
    "path",
    "retention",
    "expires_at",
}


#: The variables :func:`scratchpad_from_env` reads.
SCRATCHPAD_VOLUME_VAR = "SCRATCHPAD_VOLUME"
SCRATCHPAD_BIN_VAR = "SCRATCHPAD_BIN"
SCRATCHPAD_DIR_VAR = "SCRATCHPAD_DIR"
SCRATCHPAD_GRANT_TTL_S_VAR = "SCRATCHPAD_GRANT_TTL_S"

_DEFAULT_NATS_URL = "nats://127.0.0.1:4222"
#: The codes ``describe`` refuses with when the workspace holds no volume yet.
_NO_VOLUME_CODES = ("workspace", "not_found")


class ScratchPadClient(ScratchPad, Protocol):
    """The agent's ScratchPad: the :class:`ScratchPad` port, which the rules for
    references run on, and the commit and read the agent makes itself."""

    async def commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        """Publish ``text`` at ``path`` in this agent's volume, retained for ten
        minutes, and return the reference token the CLI made for it."""
        ...

    async def read(self, reference: str, trace: TraceIds | None) -> str:
        """Fetch the exact content a reference token names, as text."""
        ...


class SpCliConnection(Protocol):
    """How ``sp`` connects: the agent's own connection source.

    A ``url`` with a ``creds`` file. ``sp`` reads no NATS ``context`` and takes
    no nkey seed alone, so an object with a context and no credentials, or with
    neither, is refused.
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


class ScratchPadError(RuntimeError):
    """A refusal or failure from ``sp``: its error code, and whether the
    outcome is unknown — a mutation that may still have taken effect."""

    def __init__(self, message: str, code: str, unknown: bool) -> None:
        super().__init__(message)
        self.code = code
        self.unknown = unknown


@dataclass(frozen=True)
class _Binding:
    """The volume this agent owns: whom the CLI authenticated, and the volume's
    exact incarnation."""

    account: str
    volume: str
    creation_id: str


def _positive(v: Any) -> bool:
    return type(v) is int and v > 0


def _valid_target(v: Any) -> TypeGuard[dict[str, str]]:
    return (
        isinstance(v, dict)
        and set(v) == {"volume", "creation_id"}
        and isinstance(v["volume"], str)
        and _VOLUME.fullmatch(v["volume"]) is not None
        and isinstance(v["creation_id"], str)
        and _CREATION.fullmatch(v["creation_id"]) is not None
    )


def _valid_path(p: Any) -> bool:
    if not isinstance(p, str) or not p.startswith("/") or len(p.encode()) > _MAX_PATH_BYTES:
        return False
    return p == "/" or all(name not in ("", ".", "..") for name in p[1:].split("/"))


def decode_reference(reference: str) -> dict[str, Any]:
    """The token's fields, when its shape is right: the size bound, the
    prefix, unpadded base64url, exactly the nine fields and their kinds. The
    CLI checks the rest (canonical bytes, the path's names, the NKEY
    checksum)."""

    def refuse(why: str) -> ValueError:
        return ValueError(f"malformed ScratchPad reference: {why}")

    if not isinstance(reference, str) or not reference.startswith(REFERENCE_PREFIX):
        raise refuse("no sp-ref: prefix")
    if len(reference) > MAX_REFERENCE_BYTES:
        raise refuse("longer than 16 KiB")
    body = reference[len(REFERENCE_PREFIX) :]
    if _BASE64URL.fullmatch(body) is None or len(body) % 4 == 1:
        raise refuse("not unpadded base64url")
    try:
        v = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, binascii.Error) as err:
        raise refuse("not JSON") from err
    if not isinstance(v, dict) or set(v) != _REFERENCE_FIELDS:
        raise refuse("not the version 2 fields")
    r = v["retention"]
    if not (
        type(v["version"]) is int
        and v["version"] == _REFERENCE_VERSION
        and isinstance(v["creator"], str)
        and 0 < len(v["creator"].encode()) <= _MAX_CREATOR_BYTES
        and isinstance(v["account"], str)
        and _ACCOUNT.fullmatch(v["account"]) is not None
        and _valid_target(v["target"])
        and isinstance(v["root"], str)
        and _ROOT.fullmatch(v["root"]) is not None
        and _positive(v["generation"])
        and _valid_path(v["path"])
        and isinstance(r, dict)
        and set(r) == {"slot", "generation"}
        and type(r["slot"]) is int
        and 0 <= r["slot"] < RETENTION_SLOTS
        and _positive(r["generation"])
        and _positive(v["expires_at"])
    ):
        raise refuse("a field is out of shape")
    return v


_CONTROL_KINDS = ("close", "apply", "release", "grant")


def _count(v: Any) -> bool:
    return type(v) is int and v >= 0


@dataclass(frozen=True)
class VolumeView:
    """The parts of the CLI's ``describe`` reply that decide whether cleanup can make room."""

    closed: bool
    #: The saved request the CLI has not finished, by kind: ``close``,
    #: ``apply``, ``release`` or ``grant``.
    control: str | None
    #: Each retention slot's generation, and its pin's deadline; ``None`` when the slot is free.
    retentions: tuple[tuple[int, int | None], ...]
    #: Each grant still in a slot: the retention slot and generation it names, and its expiry.
    grants: tuple[tuple[int, int, int], ...]


def decode_describe(reply: Any) -> VolumeView:  # noqa: PLR0912 — one check per field
    """The volume view in a ``describe`` reply, checked field by field: exactly
    eight retention slots and sixteen grant slots, each with the kinds the CLI
    writes. Anything else is refused, never guessed at."""

    def refuse(why: str) -> ScratchPadError:
        return ScratchPadError(f"sp describe: {why}", "malformed_reply", False)

    volume = reply.get("volume") if isinstance(reply, dict) else None
    if not isinstance(volume, dict):
        raise refuse("the reply names no volume")
    control = reply.get("control")
    kind: str | None = None
    if control is not None:
        if not isinstance(control, dict) or control.get("kind") not in _CONTROL_KINDS:
            raise refuse("the saved control request is out of shape")
        kind = control["kind"]
    if type(volume.get("closed")) is not bool:
        raise refuse("the volume names no closed state")
    retentions, grants = volume.get("retentions"), volume.get("grants")
    if not isinstance(retentions, list) or len(retentions) != RETENTION_SLOTS:
        raise refuse("not eight retention slots")
    if not isinstance(grants, list) or len(grants) != GRANT_SLOTS:
        raise refuse("not sixteen grant slots")
    pins: list[tuple[int, int | None]] = []
    for slot in retentions:
        if not isinstance(slot, dict) or not _count(slot.get("generation")):
            raise refuse("a retention slot is out of shape")
        pin = slot.get("pin")
        if pin is None:
            pins.append((slot["generation"], None))
            continue
        if (
            not isinstance(pin, dict)
            or not _count(pin.get("until"))
            or not isinstance(pin.get("root"), str)
        ):
            raise refuse("a retention pin is out of shape")
        pins.append((slot["generation"], pin["until"]))
    live: list[tuple[int, int, int]] = []
    for slot in grants:
        if not isinstance(slot, dict) or not _count(slot.get("generation")):
            raise refuse("a grant slot is out of shape")
        grant = slot.get("grant")
        if grant is None:
            continue
        handle = grant.get("retention") if isinstance(grant, dict) else None
        if (
            not isinstance(grant, dict)
            or not _count(grant.get("until"))
            or not isinstance(handle, dict)
            or not _count(handle.get("slot"))
            or handle["slot"] >= RETENTION_SLOTS
            or not _positive(handle.get("generation"))
        ):
            raise refuse("a grant is out of shape")
        live.append((handle["slot"], handle["generation"], grant["until"]))
    return VolumeView(volume["closed"], kind, tuple(pins), tuple(live))


def cleanup_cannot_help(view: VolumeView, at: int | None = None) -> str | None:
    """Why ``maintain --apply`` cannot make room for a retained commit now, or
    ``None`` when it can: a slot is free, or an expired pin no live grant names
    can be released. A closed volume with no saved cleanup of this agent's is
    someone else's maintenance, and never reopened from here."""
    now = int(time.time()) if at is None else at
    maintenance = view.control in ("close", "apply")
    if view.closed and not maintenance:
        return "the volume is closed, and no cleanup of this agent's is saved"
    if maintenance:
        return None  # finish the saved cleanup first
    for slot, (generation, until) in enumerate(view.retentions):
        if until is None:
            return None  # free
        if (
            until != 0
            and until <= now
            and not any(
                g_slot == slot and g_generation == generation and g_until > now
                for g_slot, g_generation, g_until in view.grants
            )
        ):
            return None  # expired, and no live grant names this exact handle
    return "every retention slot holds a live pin"


def _served_trace() -> TraceIds | None:
    scope = active_trace()
    return TraceIds(scope.thread_id, scope.root_id) if scope is not None else None


def _trace_flags(trace: TraceIds | None, tool_call_id: str | None) -> list[str]:
    flags = ["--thread-id", trace.thread_id, "--root-id", trace.root_id] if trace else []
    if trace and tool_call_id is not None:
        flags += ["--tool-call-id", tool_call_id]
    return flags


async def _read_bounded(stream: asyncio.StreamReader, limit: int) -> tuple[bytes, bool]:
    """At most ``limit`` bytes of ``stream``, and whether it held more."""
    out = bytearray()
    while chunk := await stream.read(65536):
        if len(out) + len(chunk) > limit:
            return bytes(out), True
        out += chunk
    return bytes(out), False


class SpCliScratchPad:
    """Commit, read and grant by reference, through one ``sp`` binary and one volume.

    The :class:`ScratchPadClient` an agent hands to :func:`scratch_pad_extension`
    and :func:`grant_request_endpoint` and commits and reads with itself.

    ``volume`` is the volume this agent writes to, by name, letters and digits
    only: the deployment provisions it for the agent's account and user, and
    the first commit creates it. ``nats`` is the agent's own connection source,
    because ``sp`` authenticates the same way (:class:`SpCliConnection`): a URL
    and a credentials file; it reads no NATS context, and an nkey seed alone is
    not a form it accepts. ``bin`` is the ``sp`` binary, ``sp`` on PATH by
    default; ``dir`` a private directory for the CLI's workspace, created if
    missing and used by its real path, ``scratchpad-<volume>`` under the temp
    directory by default; keep it across restarts, as it records the volume
    and any command still to finish. ``grant_ttl_s`` is how long a read grant
    lasts, ten minutes by default and at most. ``creator`` is this agent's
    prompt address, written into every reference it makes, so an agent handed
    one knows whom to ask before passing it on; a commit needs it.
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
        if nats.creds is None or nats.url is None:
            raise ValueError(
                "ScratchPad: the sp CLI needs NATS_URL and NATS_CREDS; "
                "a NATS context or an nkey seed alone is not supported"
            )
        self._connection = ["--url", nats.url, "--creds", nats.creds]
        self._bin = bin
        self._dir = Path(
            dir if dir is not None else os.path.join(tempfile.gettempdir(), f"scratchpad-{volume}")
        )
        self._ready = False
        self._volume_name = volume
        self._grant_ttl_s = min(grant_ttl_s, DEFAULT_GRANT_TTL_S)
        self._creator = creator
        # Which volume this agent owns, once the CLI has said so.
        self._binding: _Binding | None = None
        # One mutation at a time (init, commit, maintenance, grant). The CLI
        # locks its workspace too; this keeps the agent's own calls in order
        # rather than having the CLI refuse the second of two at once.
        self._mutations = asyncio.Lock()
        # Whether the workspace may hold a commit or a cleanup whose outcome is
        # unknown or unfinished: at start (a previous process may have left
        # one), after a commit that ended unknown, and after a cleanup that
        # failed. The next commit or grant first asks the CLI to recover it.
        self._may_have_pending = True
        # A grant whose outcome is unknown: its exact arguments, to finish
        # before any other grant, because the CLI refuses a different one
        # meanwhile.
        self._pending_grant: tuple[list[str], str, GrantKind, dict[str, Any]] | None = None
        # Whom this agent granted read: the account, the volume's incarnation,
        # the root, the path and the grantee, to the expiry of its latest
        # grant of each kind. ScratchPad knows the grants but not how they came
        # about; that is this agent's own knowledge. In memory, so one ledger
        # per process: after a restart, or in another instance behind the same
        # address, the answer is "not granted", which is the safe one.
        self._ledger: dict[str, dict[str, int]] = {}

    def _workspace(self) -> Path:
        # The CLI's workspace, with every symlink resolved, because on macOS
        # both ``/tmp`` and ``$TMPDIR`` are symlinks.
        if not self._ready:
            self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._dir = self._dir.resolve()
            self._ready = True
        return self._dir

    async def _sp(
        self,
        command: str,
        args: list[str],
        trace: TraceIds | None = None,
        *,
        tool_call_id: str | None = None,
        stdin: bytes | None = None,
        max_stdout: int = MAX_STDOUT,
        mutation: bool = False,
    ) -> Any:
        # A read targets the reference's volume, which can belong to another agent.
        volume = [] if command == "read" else ["--volume", self._volume_name]
        argv = [
            command,
            *self._connection,
            "--dir",
            str(self._workspace()),
            *volume,
            *args,
            *_trace_flags(trace, tool_call_id),
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                self._bin,
                *argv,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except OSError as err:
            # Not started: nothing was sent.
            raise ScratchPadError(f"sp {command}: {err}", "spawn_failed", False) from err
        assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
        writer = proc.stdin

        async def feed() -> None:
            try:
                writer.write(stdin or b"")
                await writer.drain()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                writer.close()

        _, (out, too_long), (err_out, _) = await asyncio.gather(
            feed(), _read_bounded(proc.stdout, max_stdout), _read_bounded(proc.stderr, MAX_STDERR)
        )
        if too_long:
            # A reply past its bound is refused unread. This is the child this
            # call started, stopped by its own handle.
            proc.kill()
        code = await proc.wait()
        if code == 0 and not too_long:
            try:
                return json.loads(out)
            except ValueError:
                pass  # a mutation whose reply cannot be read may still have happened
        # A refusal is JSON on stderr: ``{"error": {"code", "message", "unknown"}}``.
        # Anything else from a mutation (a crash, a cut-off reply) proves
        # nothing about whether it took effect, so it counts as unknown.
        text = err_out.decode(errors="replace").strip()
        failure_code, message, unknown = (
            ("malformed_reply" if code == 0 else "failed"),
            text[:512] or f"exit {code}",
            mutation,
        )
        if code != 0:
            try:
                e = json.loads(err_out).get("error")
            except (ValueError, AttributeError):
                e = None
            if isinstance(e, dict) and isinstance(e.get("code"), str):
                failure_code = e["code"]
                given = e.get("message")
                message = given if isinstance(given, str) else ""
                unknown = e.get("unknown") is True or (
                    mutation and not isinstance(e.get("unknown"), bool)
                )
        raise ScratchPadError(
            f"sp {command}: {failure_code}{' (outcome unknown)' if unknown else ''}: {message}",
            failure_code,
            unknown,
        )

    def _bind(self, reply: Any, command: str) -> _Binding:
        principal = reply.get("principal") if isinstance(reply, dict) else None
        account = principal.get("account") if isinstance(principal, dict) else None
        target = reply.get("target") if isinstance(reply, dict) else None
        if (
            not isinstance(account, str)
            or _ACCOUNT.fullmatch(account) is None
            or not _valid_target(target)
        ):
            raise ScratchPadError(
                f"sp {command}: the reply names no principal and target", "malformed_reply", False
            )
        if target["volume"] != self._volume_name:
            raise ScratchPadError(
                f"sp {command}: the workspace is bound to another volume", "invalid", False
            )
        return _Binding(account, target["volume"], target["creation_id"])

    async def _init(self, trace: TraceIds | None) -> _Binding:
        # Create the volume, or resume it: the CLI makes this safe to repeat.
        if self._binding is None:
            self._binding = self._bind(await self._sp("init", [], trace, mutation=True), "init")
        return self._binding

    async def _describe(self, trace: TraceIds | None) -> _Binding | None:
        # The volume this agent owns, without creating it: ``None`` when the
        # workspace was never initialized, which the CLI refuses as
        # ``workspace`` ("run init"). A workspace bound to another volume or
        # principal answers the same, and the next commit's ``init`` reports it.
        if self._binding is None:
            try:
                self._binding = self._bind(await self._sp("describe", [], trace), "describe")
            except ScratchPadError as err:
                if err.code in _NO_VOLUME_CODES:
                    return None
                raise
        return self._binding

    @staticmethod
    def _owned_by(ref: dict[str, Any], binding: _Binding | None) -> bool:
        return (
            binding is not None
            and ref["account"] == binding.account
            and ref["target"]["volume"] == binding.volume
            and ref["target"]["creation_id"] == binding.creation_id
        )

    @staticmethod
    def _ledger_key(ref: dict[str, Any], grantee: Grantee) -> str:
        return json.dumps(
            [
                ref["account"],
                ref["target"]["volume"],
                ref["target"]["creation_id"],
                ref["root"],
                ref["path"],
                grantee.account,
                grantee.user,
            ]
        )

    def _prune(self) -> None:
        now = int(time.time())
        self._ledger = {k: until for k, until in self._ledger.items() if max(until.values()) > now}

    async def _recover(self, trace: TraceIds | None) -> None:
        # Finish what an earlier call may have left unresolved: a commit or a
        # saved cleanup. This repeats that exact request; it never starts
        # another one. A definite refusal (nothing pending, say) lets the new
        # mutation go ahead, and the CLI refuses that one too if something is
        # still pending.
        if not self._may_have_pending:
            return
        try:
            await self._sp("recover", [], trace, mutation=True)
        except ScratchPadError as err:
            if err.unknown:
                raise
        self._may_have_pending = False

    async def _volume_view(self, trace: TraceIds | None) -> VolumeView:
        # The volume's current slots and state, as the CLI describes them.
        return decode_describe(await self._sp("describe", [], trace))

    async def _publish(
        self, text: bytes, path: str, operation_id: str, trace: TraceIds | None
    ) -> Any:
        assert self._creator is not None
        return await self._sp(
            "publish-file",
            [
                "--source",
                "-",
                "--path",
                path,
                "--operation-id",
                operation_id,
                "--creator",
                self._creator,
                "--ttl-seconds",
                str(HANDOFF_TTL_S),
            ],
            trace,
            stdin=text,
            mutation=True,
        )

    async def commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        """Publish ``text`` at ``path``, retained, and return the CLI's reference token."""
        async with self._mutations:
            return await self._commit(text, path, trace)

    async def _commit(self, text: str, path: str, trace: TraceIds | None) -> str:
        if self._creator is None:
            raise ValueError(
                "ScratchPad: a reference names its creator; this ScratchPad was made without one"
            )
        own = await self._init(trace)
        await self._recover(trace)
        data = text.encode()
        operation_id = str(uuid.uuid4())
        try:
            reply = await self._publish(data, path, operation_id, trace)
        except ScratchPadError as err:
            if err.unknown:
                self._may_have_pending = True
            if err.code != "capacity" or err.unknown:
                raise
            # Full: release expired retention and collect what nothing retains,
            # then the same commit once more, but only when cleanup can make
            # room. The CLI releases only expired retention; a live handoff stays.
            try:
                reason = cleanup_cannot_help(await self._volume_view(trace))
            except ScratchPadError as inspect:
                # Unread, nothing is known about the slots: close nothing.
                raise ScratchPadError(
                    f"{err}; cleanup not started: {inspect}", err.code, False
                ) from inspect
            if reason is not None:
                raise ScratchPadError(
                    f"{err}; cleanup not started: {reason}", err.code, False
                ) from err
            try:
                await self._sp("maintain", ["--apply"], trace, mutation=True)
            except ScratchPadError as cleanup:
                # The CLI keeps the unfinished cleanup saved; recover finishes
                # it before the next mutation. An unknown cleanup stays unknown.
                self._may_have_pending = True
                raise ScratchPadError(
                    f"{err}; cleanup: {cleanup}",
                    cleanup.code if cleanup.unknown else err.code,
                    cleanup.unknown,
                ) from cleanup
            except BaseException:
                # Stopped before its outcome was read: recover it all the same.
                self._may_have_pending = True
                raise
            try:
                reply = await self._publish(data, path, operation_id, trace)
            except ScratchPadError as again:
                if again.unknown:
                    self._may_have_pending = True
                raise
        token = reply.get("reference") if isinstance(reply, dict) else None
        if not isinstance(token, str) or not isinstance(reply.get("receipt"), dict):
            self._may_have_pending = True
            raise ScratchPadError(
                "sp publish-file: the reply names no receipt and reference", "malformed_reply", True
            )
        ref = decode_reference(token)
        if not self._owned_by(ref, own) or ref["path"] != path or ref["creator"] != self._creator:
            raise ScratchPadError(
                "sp publish-file: the reference names another volume, path or creator",
                "malformed_reply",
                False,
            )
        return token  # exactly the token the CLI made

    async def read(self, reference: str, trace: TraceIds | None) -> str:
        """Fetch the exact bytes ``reference`` names, as text."""
        ref = decode_reference(reference)
        # An expired reference opens nothing; the CLI would refuse it too.
        if ref["expires_at"] <= int(time.time()):
            raise ValueError("the reference has expired")
        got = await self._sp("read", ["--ref", reference], trace, max_stdout=MAX_READ_STDOUT)
        data = got.get("data_base64") if isinstance(got, dict) else None
        size = got.get("bytes") if isinstance(got, dict) else None
        if not isinstance(data, str) or type(size) is not int or not 0 <= size <= MAX_READ_BYTES:
            raise ScratchPadError("sp read: the reply carries no data", "malformed_reply", False)
        try:
            raw = base64.b64decode(data, validate=True)
        except binascii.Error as err:
            raise ScratchPadError(
                "sp read: the data is not base64", "malformed_reply", False
            ) from err
        if len(raw) != size:
            raise ScratchPadError(
                "sp read: the data does not match its length", "malformed_reply", False
            )
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as err:
            raise ValueError("the referenced file is not UTF-8 text") from err

    async def owns(self, reference: str) -> bool:
        """Whether ``reference`` points into this agent's own volume, where it may grant."""
        # A token that does not decode is nobody's. An agent that has committed
        # nothing yet has no volume, and owns nothing; asking never creates
        # one. The port passes no thread; inside a served prompt the question
        # still goes on that prompt's thread.
        try:
            ref = decode_reference(reference)
        except ValueError:
            return False
        return self._owned_by(ref, await self._describe(_served_trace()))

    async def grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None,
        tool_call_id: str | None = None,
        kind: GrantKind = "first-hand",
    ) -> None:
        """Grant ``grantee`` read on the root and path ``reference`` names, until
        the grant's expiry.

        Only for a reference into this agent's own volume; anything else is
        refused before ScratchPad is asked. ``tool_call_id``, when the grant is
        made for a ``prompt_agent`` call, puts the grant under that call in the
        console. ``kind`` goes into the ledger: ``first-hand`` unless the grant
        answers another agent's request.
        """
        async with self._mutations:
            await self._grant_read(reference, grantee, trace, tool_call_id, kind)

    async def _run_grant(
        self, args: list[str], trace: TraceIds | None, tool_call_id: str | None, ref: dict[str, Any]
    ) -> int:
        reply = await self._sp("grant", args, trace, tool_call_id=tool_call_id, mutation=True)
        if (
            not isinstance(reply, dict)
            or not isinstance(reply.get("handle"), dict)
            or not _positive(reply.get("expires_at"))
        ):
            raise ScratchPadError(
                "sp grant: the reply names no handle and expiry", "malformed_reply", True
            )
        # The expiry the CLI reports, never later than the reference's.
        return int(min(reply["expires_at"], ref["expires_at"]))

    def _record(self, key: str, kind: GrantKind, expires_at: int) -> None:
        self._ledger.setdefault(key, {})[kind] = expires_at

    async def _grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None,
        tool_call_id: str | None,
        kind: GrantKind,
    ) -> None:
        ref = decode_reference(reference)
        if not self._owned_by(ref, await self._describe(trace)):
            # Only a volume's owner grants on it. Reading someone else's content
            # and granting on a copy would pass on a permission this agent was
            # never given; its creator is asked instead.
            raise PermissionError(
                "the reference points into another agent's volume;"
                " only its creator can grant read on it"
            )
        await self._recover(trace)
        if self._pending_grant is not None:
            # Finish the grant that ended unknown, with its exact arguments,
            # before any other: the CLI refuses a different one meanwhile.
            args, key, earlier_kind, earlier_ref = self._pending_grant
            try:
                self._record(
                    key, earlier_kind, await self._run_grant(args, None, None, earlier_ref)
                )
            except ScratchPadError as err:
                if err.unknown:
                    raise
            self._pending_grant = None
        ttl = int(min(self._grant_ttl_s, ref["expires_at"] - time.time() - EXPIRY_MARGIN_S))
        if ttl < 1:
            raise ValueError(
                "the reference has expired, or is about to; there is nothing left to grant on"
            )
        key = self._ledger_key(ref, grantee)
        self._prune()
        if key not in self._ledger and len(self._ledger) >= MAX_LEDGER:
            # The ledger stays finite. ScratchPad has 16 grant slots too.
            raise RuntimeError(
                f"this agent already holds {MAX_LEDGER} live grants; try again when one expires"
            )
        args = [
            "--ref",
            reference,
            "--grantee-account",
            grantee.account,
            "--grantee-user",
            grantee.user,
            "--operation-id",
            str(uuid.uuid4()),
            "--ttl-seconds",
            str(ttl),
        ]
        try:
            self._record(key, kind, await self._run_grant(args, trace, tool_call_id, ref))
        except ScratchPadError as err:
            # Unknown: the grant may exist, but the ledger says nothing until
            # the CLI confirms it. The same arguments, trace labels included, go
            # again before the next grant.
            if err.unknown:
                self._pending_grant = ([*args, *_trace_flags(trace, tool_call_id)], key, kind, ref)
            raise

    def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
        """The live grant this agent made to ``grantee`` on the root and path
        ``reference`` names, by kind, or ``None`` when there is none or it has
        expired: the question a creator asks before it lets one reader pass
        the reference on. A first-hand grant still running is not hidden by a
        later one made on request."""
        try:
            ref = decode_reference(reference)
        except ValueError:
            return None
        if not self._owned_by(ref, self._binding):
            return None
        until = self._ledger.get(self._ledger_key(ref, grantee), {})
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
    the agent's own configuration reads: ``NATS_CREDS`` with ``NATS_URL``
    (default ``nats://127.0.0.1:4222``), or ``NATS_CONTEXT``, which ``sp``
    cannot use. An empty variable counts as unset. Raises :class:`ValueError`
    for a grant TTL that is not a positive number, and, like
    :class:`SpCliScratchPad`, for a connection ``sp`` cannot use: a NATS
    context without credentials, or no credentials at all.
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
        # ``sp`` reads no NATS context: the credentials file, when there is
        # one, even beside a context, and otherwise the context, which is refused.
        if creds is not None:
            nats = _Connection(url=url, creds=creds)
        elif context is not None:
            nats = _Connection(context=context)
        else:
            nats = _Connection(url=url)
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
    "ScratchPadError",
    "SpCliConnection",
    "SpCliScratchPad",
    "scratchpad_from_env",
]
