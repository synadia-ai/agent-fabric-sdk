#!/usr/bin/env python3
"""A stand-in for the sp v2 command line, for the tests.

It answers every command the ScratchPad wrapper uses with a reply of the
CLI's shape, and writes what it was called with to a log the test reads back.
Success is JSON on stdout; a refusal is ``{"error": {"code", "message",
"unknown"}}`` on stderr with a non-zero exit. The same stand-in as the
TypeScript tests' ``fake-sp.mjs``.

    FAKE_SP_LOG     one JSON line per call: {"argv": [...], "stdin": ...}
    FAKE_SP_STATE   a JSON file: each volume's workspace, retention and grant
                    slots, and each root's one file, so a later ``read``
                    returns what was published. One file can serve several
                    agents, each with its own volume
    FAKE_SP_LOCK    a file each mutating command holds while it runs; a second
                    one that finds it held fails with ``busy``, so a test sees
                    two mutations overlap
    FAKE_SP_FAULTS  a JSON file ``{"<command>": [fault, ...]}``; each call of
                    that command takes the first fault off its list. A fault
                    is ``{"code", "unknown"}`` (refuse), with ``"after": true``
                    to take effect first and then report the refusal, or
                    ``{"reply": {...}}`` to replace the reply's fields. A
                    ``maintain`` fault with ``"stage": "closed"`` closes the
                    volume, saves the apply step, and then refuses

The caller is the principal its ``--creds`` file names (the user JWT's subject
and issuing account); a file that does not exist stands for one fixed
principal. As the real CLI does, it reads only a token of its own account,
and grants only to a principal in the token's account; the volume's owner
reads without a grant, anyone else only with a live one on that root and
path. It refuses ``describe`` and ``recover`` before ``init`` with
``workspace``, and ``recover`` with nothing pending returns the last receipt.
As the CLI at ScratchPad ``a28bb49`` does, a definite ``capacity`` refusal of
``publish-file`` leaves its preparation's spool in the workspace, and
``publish-file`` and ``recover`` refuse with ``pending`` until
``spool-remove --apply`` removes it.

Nothing here talks to NATS. The wrapper's job is to call the CLI with the
right commands and flags, one at a time, and to keep its own ledger; that is
what this lets a test see.
"""

from __future__ import annotations

import atexit
import os
import sys

# The lock first, before anything slow, so it covers nearly the whole run:
# two mutations the wrapper let run side by side then collide here.
_LOCK = os.environ.get("FAKE_SP_LOCK")
if (
    _LOCK
    and sys.argv[1:2]
    and sys.argv[1] in ("init", "recover", "publish-file", "maintain", "grant", "spool-remove")
):
    try:
        os.close(os.open(_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        sys.stderr.write(
            '{"error": {"code": "busy", "message": "another mutation is running",'
            ' "unknown": false}}\n'
        )
        sys.exit(1)
    atexit.register(lambda: os.path.exists(_LOCK) and os.remove(_LOCK))

import base64  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import secrets  # noqa: E402
import time  # noqa: E402
from typing import Any, NoReturn  # noqa: E402

OWN = {"account": "A" + "O" * 55, "user": "U" + "O" * 55}
CREATION_ID = "0123456789abcdef0123456789abcdef"


def fail(code: str, message: str, unknown: bool = False) -> NoReturn:
    sys.stderr.write(
        json.dumps({"error": {"code": code, "message": message, "unknown": unknown}}) + "\n"
    )
    sys.exit(1)


def load(name: str) -> dict[str, Any]:
    path = os.environ.get(name)
    try:
        with open(path or "", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def decode(token: str) -> dict[str, Any]:
    try:
        return json.loads(unb64url(token[len("sp-ref:") :]))
    except ValueError:
        fail("invalid", "reference token is invalid")


def principal(creds: str) -> dict[str, str]:
    """Whom the server would authenticate: the user JWT in the credentials file."""
    try:
        with open(creds, encoding="utf-8") as f:
            found = re.search(r"-----BEGIN NATS USER JWT-----\s*(\S+)", f.read())
        assert found is not None
        claims = json.loads(unb64url(found.group(1).split(".")[1]))
        return {
            "account": claims.get("nats", {}).get("issuer_account") or claims["iss"],
            "user": claims["sub"],
        }
    except (OSError, ValueError, AssertionError, IndexError, KeyError):
        return OWN


def main() -> None:  # noqa: PLR0912, PLR0915 — one branch per command, as the CLI has
    command, *rest = sys.argv[1:]
    flags: dict[str, Any] = {}
    i = 0
    while i < len(rest):
        a = rest[i]
        if not a.startswith("--"):
            fail("usage", f"unexpected argument {a}")
        if a == "--apply":
            flags["apply"] = True
        else:
            i += 1
            flags[a[2:]] = rest[i]
        i += 1
    stdin = sys.stdin.read()
    if log := os.environ.get("FAKE_SP_LOG"):
        with open(log, "a", encoding="utf-8") as f:
            f.write(json.dumps({"argv": sys.argv[1:], "stdin": stdin}) + "\n")

    store = load("FAKE_SP_STATE")

    def save() -> None:
        # Whole-file replacement, so a read running beside a mutation never sees half a file.
        if path := os.environ.get("FAKE_SP_STATE"):
            with open(f"{path}.{os.getpid()}", "w", encoding="utf-8") as f:
                json.dump(store, f)
            os.replace(f"{path}.{os.getpid()}", path)

    required = ("url", "creds") if command == "read" else ("url", "creds", "dir", "volume")
    for f in required:
        if not flags.get(f):
            fail("usage", f"--{f} is required")
    caller = principal(flags["creds"])

    faults = load("FAKE_SP_FAULTS")
    fault = faults.get(command, []).pop(0) if faults.get(command) else None
    if fault is not None:
        with open(os.environ["FAKE_SP_FAULTS"], "w", encoding="utf-8") as f:
            json.dump(faults, f)
    # A publication's capacity refusal comes after its preparation, below.
    refused_preparation = (
        command == "publish-file"
        and fault is not None
        and fault.get("code") == "capacity"
        and not fault.get("after")
    )
    if (
        fault is not None
        and "code" in fault
        and not fault.get("after")
        and not fault.get("stage")
        and not refused_preparation
    ):
        fail(fault["code"], "injected", fault.get("unknown", False))

    now = int(time.time())
    store.setdefault("volumes", {})
    store.setdefault("roots", {})
    # The volume this call's workspace names; a read names the reference's.
    name = (
        decode(flags["ref"]).get("target", {}).get("volume")
        if command == "read"
        else flags["volume"]
    )

    def fresh() -> dict[str, Any]:
        # Eight retention and sixteen grant slots, as in the CLI's volume view.
        # A pin stays in its slot past its deadline until ``maintain --apply``
        # releases it; a slot's generation never repeats.
        return {
            "owner": caller,
            "init": False,
            "retention": [{"generation": 1, "pin": None} for _ in range(8)],
            "grants": [{"generation": 0, "grant": None} for _ in range(16)],
            "revision": 1,
            "closed": False,
            "control": None,
        }

    # A read never creates one: a volume nobody initialized has no owner.
    if command == "read":
        state = store["volumes"].get(name) or {**fresh(), "owner": None}
    else:
        state = store["volumes"].setdefault(name, fresh())
    target = {"volume": name, "creation_id": CREATION_ID}
    binding = {"principal": state["owner"], "target": target}

    def need_init() -> None:
        if not state.get("init"):
            fail("workspace", "workspace has no created volume; run init")

    def refuse_capacity(message: str, unknown: bool = False) -> NoReturn:
        # The spool a refused preparation left: nothing publishes past it.
        state["spool"] = {"phase": "preparing", "files": 1, "bytes": len(stdin.encode())}
        save()
        fail("capacity", message, unknown)

    def spool_view(applied: bool) -> dict[str, Any]:
        spool = state.get("spool")
        if spool:
            return {"present": True, **spool, "removable": True, "applied": applied}
        return {"present": False, "files": 0, "bytes": 0, "removable": False, "applied": False}

    def protected(slot: dict[str, Any], i: int) -> bool:
        return any(
            g["grant"]
            and g["grant"]["retention"] == {"slot": i, "generation": slot["generation"]}
            and g["grant"]["until"] > now
            for g in state["grants"]
        )

    def release_expired() -> list[dict[str, int]]:
        # Every expired pin no live grant names, as ``maintain --apply`` releases.
        released = []
        for i, slot in enumerate(state["retention"]):
            pin = slot["pin"]
            if pin and pin["until"] != 0 and pin["until"] <= now and not protected(slot, i):
                released.append({"slot": i, "generation": slot["generation"]})
                slot["pin"] = None
                slot["generation"] += 1
                state["revision"] += 1
        return released

    def reopen() -> None:
        # Collection reopens the volume and settles the saved maintenance interval.
        state["revision"] += 1
        state["closed"] = False
        state["control"] = None

    def view() -> dict[str, Any]:
        owner = state["owner"]
        return {
            "target": target,
            "owner": owner,
            "head": {"generation": state.get("generation", 1), "root": "e" * 43},
            "revision": state["revision"],
            "closed": state["closed"],
            "epoch": state["revision"] if state["closed"] else 0,
            "objects": 0,
            "bytes": 0,
            "writers": [
                {"generation": 1, "number": 0, "principal": owner, "write": i == 0}
                for i in range(8)
            ],
            "retentions": [
                {
                    "generation": s["generation"],
                    "pin": {
                        "root": s["pin"]["root"],
                        "until": s["pin"]["until"],
                        "origin": {"writer": {"slot": 0, "generation": 1}, "number": 1},
                    },
                }
                if s["pin"]
                else {"generation": s["generation"]}
                for s in state["retention"]
            ],
            "grants": [
                {
                    "generation": g["generation"],
                    "grant": {
                        "principal": g["grant"]["principal"],
                        "root": g["grant"]["root"],
                        "path": g["grant"]["path"],
                        "directory": False,
                        "retention": g["grant"]["retention"],
                        "until": g["grant"]["until"],
                    },
                }
                if g["grant"]
                else {"generation": g["generation"]}
                for g in state["grants"]
            ],
        }

    reply: dict[str, Any]
    if command == "init":
        state["init"] = True
        reply = {
            **binding,
            "writer": {"status": "ready", "writer": {"slot": 0, "generation": 1}, "next": 1},
        }
    elif command == "describe":
        need_init()
        reply = {
            **binding,
            "established": True,
            "writer": {
                "status": "pending" if state.get("pending") else "ready",
                "writer": {"slot": 0, "generation": 1},
                "next": 1,
            },
            "pending_command": None,
            "publication": None,
            "control": state["control"],
            "volume": view(),
        }
    elif command == "recover":
        need_init()
        if state.get("spool"):
            fail("pending", "preparation is incomplete; inspect and remove its spool explicitly")
        control = None
        if state.get("pending"):
            state["last"], state["pending"] = state["pending"], None
        if state["control"]:
            # The saved maintenance interval runs to its end: collect and reopen.
            control = {"kind": state["control"]["kind"]}
            reopen()
        # Nothing pending is no error: the last receipt comes back as it was.
        last = state.get("last") or {}
        reply = {
            "writer": {"status": "ready", "writer": {"slot": 0, "generation": 1}, "next": 1},
            "receipt": last.get("receipt"),
            "reference": last.get("reference"),
            "control": control,
        }
    elif command == "publish-file":
        need_init()
        for f in ("path", "operation-id", "creator", "ttl-seconds"):
            if not flags.get(f):
                fail("usage", f"--{f} is required")
        if flags.get("source") != "-":
            fail("usage", "--source - expected")
        pending = state.get("pending")
        if pending and pending["operation_id"] != flags["operation-id"]:
            fail("pending", "a different command is pending; run recover")
        if state.get("spool"):
            fail("pending", "saved spool requires recover or spool-remove --apply")
        if refused_preparation:
            assert fault is not None
            refuse_capacity("injected", fault.get("unknown", False))
        free = next((i for i, s in enumerate(state["retention"]) if s["pin"] is None), None)
        if free is None:
            refuse_capacity("no retention slot is free")
        if state["closed"]:
            fail("closed", "volume: closed for maintenance")
        state["generation"] = state.get("generation", 0) + 1
        root = b64url(secrets.token_bytes(32))
        store["roots"][root] = {"volume": name, "path": flags["path"], "data": stdin}
        slot = state["retention"][free]
        slot["pin"] = {"root": root, "until": now + int(flags["ttl-seconds"])}
        state["revision"] += 1
        ref = {
            "version": 2,
            "creator": flags["creator"],
            "account": state["owner"]["account"],
            "target": target,
            "root": root,
            "generation": state["generation"],
            "path": flags["path"],
            "retention": {"slot": free, "generation": slot["generation"]},
            "expires_at": slot["pin"]["until"],
        }
        reply = {
            "receipt": {
                "volume": flags["volume"],
                "head": {"root": root, "generation": state["generation"]},
            },
            "reference": "sp-ref:" + b64url(json.dumps(ref, separators=(",", ":")).encode()),
            "operation_id": flags["operation-id"],
        }
        state["pending" if fault and fault.get("after") else "last"] = reply
    elif command == "maintain":
        need_init()
        released: list[dict[str, int]] = []
        if flags.get("apply"):
            if (state["control"] or {}).get("kind") != "apply":
                released = release_expired()
                # A successful close moves the saved control straight to apply.
                state["revision"] += 1
                state["closed"] = True
                state["control"] = {
                    "kind": "apply",
                    "maintenance": {"target": target, "revision": state["revision"]},
                }
                if fault is not None and fault.get("stage") == "closed":
                    save()
                    fail(fault["code"], "injected after the close", fault.get("unknown", False))
            reopen()
        reply = {
            "applied": bool(flags.get("apply")),
            "resumed": None,
            "released": released,
            "expired": [],
            "collection": None,
            "volume": view(),
        }
    elif command == "spool-inspect":
        need_init()
        reply = spool_view(False)
    elif command == "spool-remove":
        need_init()
        applied = bool(flags.get("apply")) and bool(state.get("spool"))
        reply = spool_view(applied)
        if applied:
            state["spool"] = None
    elif command == "read":
        ref = decode(flags["ref"])
        if flags.get("volume") and flags["volume"] != ref["target"]["volume"]:
            fail("usage", "--volume differs from the reference volume")
        if ref["expires_at"] <= now:
            fail("expired", "reference has expired")
        if ref["account"] != caller["account"]:
            fail("denied", "reference names another account")
        mine = state["owner"] is not None and state["owner"] == caller
        granted = any(
            g["grant"]
            and g["grant"]["principal"]["user"] == caller["user"]
            and g["grant"]["root"] == ref["root"]
            and g["grant"]["path"] == ref["path"]
            and g["grant"]["until"] > now
            for g in state["grants"]
        )
        if not mine and not granted:
            fail("denied", "scratchpad denied: denied")
        if state["closed"]:
            fail("closed", "volume: closed for maintenance")
        file = store["roots"].get(ref["root"])
        if file is None or file["volume"] != name or file["path"] != ref["path"]:
            fail("not_found", "no such root and path")
        data = file["data"].encode()
        reply = {"data_base64": base64.b64encode(data).decode(), "bytes": len(data)}
    elif command == "grant":
        need_init()
        ref = decode(flags["ref"])
        for f in ("grantee-account", "grantee-user", "operation-id", "ttl-seconds"):
            if not flags.get(f):
                fail("usage", f"--{f} is required")
        if ref["account"] != caller["account"]:
            fail("denied", "reference names another account")
        if ref["target"] != target:
            fail("denied", "reference names another volume incarnation than this workspace")
        if flags["grantee-account"] != ref["account"]:
            fail("denied", "grants are limited to the reference's account")
        if state["control"]:
            fail("pending", f"a {state['control']['kind']} request is unresolved; run recover")
        ttl = int(flags["ttl-seconds"])
        if not 1 <= ttl <= 3600 or now + ttl > ref["expires_at"]:
            fail("usage", "the grant outlives its reference")
        free = next(
            (
                i
                for i, g in enumerate(state["grants"])
                if g["grant"] is None or g["grant"]["until"] <= now
            ),
            None,
        )
        if free is None:
            fail("capacity", "all read-grant slots hold live grants")
        gslot = state["grants"][free]
        gslot["generation"] += 1
        grantee = {"account": flags["grantee-account"], "user": flags["grantee-user"]}
        gslot["grant"] = {
            "principal": grantee,
            "root": ref["root"],
            "path": ref["path"],
            "retention": ref["retention"],
            "until": now + ttl,
        }
        state["revision"] += 1
        reply = {
            "handle": {"slot": free, "generation": gslot["generation"]},
            "expires_at": now + ttl,
        }
    else:
        fail("usage", f"unknown command {command}")
    save()
    if fault is not None and "code" in fault:
        fail(fault["code"], "injected after the effect", fault.get("unknown", False))
    if fault is not None and "reply" in fault:
        reply = {**reply, **fault["reply"]}
    sys.stdout.write(json.dumps(reply) + "\n")


main()
