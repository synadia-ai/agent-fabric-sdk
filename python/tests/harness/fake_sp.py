#!/usr/bin/env python3
"""A stand-in for the ``sp`` command line, for the tests.

It answers every verb the ScratchPad wrapper uses with a reply of the real
CLI's shape, and writes what it was called with to a log the test reads back.

    FAKE_SP_LOG          one JSON line per call: {"argv": [...], "stdin": ...}
    FAKE_SP_STATE        a JSON file where ``put`` keeps content by path, so a
                         later ``cat`` returns what was committed
    FAKE_SP_VOLUME       the name ``volume list`` reports for the one volume
                         (default "test-volume")
    FAKE_SP_VOLUME_ID    that volume's id (default "vol-own"); two agents on
                         one ``FAKE_SP_STATE`` each take their own
    FAKE_SP_DENY_VOLUME  a volume id whose ``cat`` is refused the way the real
                         CLI refuses one: JSON on stderr, exit 13

Nothing here talks to NATS. The wrapper's job is to call the CLI with the
right verbs and flags in the right order; that is what this lets a test see.
The same stand-in as the TypeScript tests' ``fake-sp.mjs``.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time


def main() -> None:  # noqa: PLR0912, PLR0915 — one branch per verb, like the real CLI
    argv = sys.argv[1:]
    flags: dict[str, object] = {}
    words: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-"):
            if a in ("-json", "-apply"):
                flags[a[1:]] = True
            else:
                i += 1
                flags[a[1:]] = argv[i]
        else:
            words.append(a)
        i += 1
    verb = " ".join(words)
    stdin = sys.stdin.read() if flags.get("source") == "-" else None

    if os.environ.get("FAKE_SP_LOG"):
        with open(os.environ["FAKE_SP_LOG"], "a", encoding="utf-8") as log:
            log.write(json.dumps({"argv": argv, "stdin": stdin}) + "\n")
    state_file = os.environ.get("FAKE_SP_STATE")
    state: dict[str, str] = {}
    if state_file and os.path.exists(state_file):
        with open(state_file, encoding="utf-8") as f:
            state = json.load(f)

    def refuse(code: str, message: str, exit_code: int) -> None:
        sys.stderr.write(json.dumps({"error": {"code": code, "message": message}}) + "\n")
        sys.exit(exit_code)

    now = int(time.time() * 1000)
    volume_id = os.environ.get("FAKE_SP_VOLUME_ID", "vol-own")
    if verb == "volume list":
        reply: object = {
            "volumes": [
                {
                    "id": volume_id,
                    "name": os.environ.get("FAKE_SP_VOLUME", "test-volume"),
                    "root": "root-0",
                }
            ]
        }
    elif verb == "volume create":
        reply = {"volume": {"id": volume_id, "root": "root-0"}}
    elif verb == "session open":
        reply = {"session": {"id": "sess-1"}}
    elif verb == "put":
        state[str(flags["path"])] = stdin or ""
        if state_file:
            with open(state_file, "w", encoding="utf-8") as f:
                json.dump(state, f)
        reply = {"change": {"path": flags["path"]}}
    elif verb == "commit":
        reply = {"receipt": {"new_root": f"root-{now}"}}
    elif verb == "ref make":
        reply = {
            "ref": {
                "type": "handoff",
                "handoff_id": f"hnd-{now}",
                "volume_id": flags["volume-id"],
                "root": flags["root"],
                "path": flags["path"],
                "expires_at": int(str(flags["expires-at"])),
            },
            "source_sequence": 7,
        }
    elif verb == "ref resolve":
        reply = {"ok": True}
    elif verb == "cat":
        if os.environ.get("FAKE_SP_DENY_VOLUME") == flags["volume-id"]:
            refuse("permission_denied", "no grant covers this read", 13)
        text = state.get(
            str(flags["path"]), f"content of {flags['volume-id']}@{flags['root']}{flags['path']}"
        )
        reply = {"data_base64": base64.b64encode(text.encode()).decode("ascii")}
    elif verb == "grant issue":
        reply = {
            "grant": {
                "id": f"grant-{now}",
                "volume_id": flags["volume-id"],
                "grantee": {"account": flags["grantee-account"], "user": flags["grantee-user"]},
                "scope": {"subtree": flags.get("subtree")},
                "actions": str(flags.get("actions", "")).split(","),
                "expires_at": int(str(flags["expires-at"])),
            },
            "source_sequence": 9,
        }
    else:
        refuse("invalid_request", f"unknown command {verb}", 10)
        return
    sys.stdout.write(json.dumps(reply) + "\n")


if __name__ == "__main__":
    main()
