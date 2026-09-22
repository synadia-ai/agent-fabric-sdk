"""Cross-language agreement on the grant request's bytes.

Both packages send the request and answer it. A key reordered, a character
escaped differently, or a refusal worded differently on one side only would
go unnoticed until a mixed-language fleet handed a reference on — so build
the same requests, and answer the same requests by the creator's rule, in
each implementation, and compare the bytes.

Skips cleanly (never fails) when ``bun`` or the TypeScript package's
dependencies are missing.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any

import pytest

from synadia_ai.agent_fabric import (
    Grantee,
    GrantKind,
    TraceIds,
    answer_grant_request,
    encode_grant_reply,
    encode_grant_request,
)
from tests.interop import TS_DIR, interop_prereqs_missing

pytestmark = pytest.mark.skipif(
    interop_prereqs_missing() is not None, reason=str(interop_prereqs_missing())
)

THREAD, ROOT = "a" * 32, "b" * 32
# Non-ASCII, an astral character, a C0 control, DEL and U+2028: the places
# `JSON.stringify` and `json.dumps` could part ways.
ODD = "call_" + "".join(map(chr, (0xE9, 0x1F642, 0x01, 0x7F, 0x2028)))

REQUESTS: list[dict[str, Any]] = [
    {"reference": "sp-ref:abc", "grantee": "ACME.carol"},
    {
        "reference": "sp-ref:abc",
        "grantee": "ACME.carol",
        "trace": {"thread_id": THREAD, "root_id": ROOT},
    },
    {
        "reference": "sp-ref:abc",
        "grantee": "ACME.carol",
        "trace": {"thread_id": THREAD, "root_id": ROOT, "tool_call_id": "toolu_1"},
    },
    {
        "trace": {"tool_call_id": ODD, "root_id": ROOT, "thread_id": THREAD},
        "grantee": ODD,
        "reference": "sp-ref:abc",
    },
]

REQUESTER = "APP.bob"
# The creator's rule, one request per line of it, against the same fake.
ANSWERS: list[tuple[str, str]] = [
    ("granted", json.dumps({"reference": "sp-ref:own", "grantee": "ACME.carol"})),
    ("not a request", "{"),
    ("not an identity", json.dumps({"reference": "sp-ref:own", "grantee": "carol"})),
    ("not its volume", json.dumps({"reference": "sp-ref:else", "grantee": "ACME.carol"})),
    ("no live grant", json.dumps({"reference": "sp-ref:unshared", "grantee": "ACME.carol"})),
    ("on request only", json.dumps({"reference": "sp-ref:relayed", "grantee": "ACME.carol"})),
    ("for itself", json.dumps({"reference": "sp-ref:own", "grantee": REQUESTER})),
    ("grant fails", json.dumps({"reference": "sp-ref:failing", "grantee": "ACME.carol"})),
]

_FAKE_LEDGER = {
    "sp-ref:own": "first-hand",
    "sp-ref:failing": "first-hand",
    "sp-ref:relayed": "on-request",
}


class _Fake:
    def owns(self, reference: str) -> bool:
        return reference != "sp-ref:else"

    def granted(self, reference: str, grantee: Grantee) -> GrantKind | None:
        if f"{grantee.account}.{grantee.user}" != REQUESTER:
            return None
        return _FAKE_LEDGER.get(reference)  # type: ignore[return-value]

    def grant_read(
        self,
        reference: str,
        grantee: Grantee,
        trace: TraceIds | None,
        tool_call_id: str | None = None,
        kind: GrantKind = "first-hand",
    ) -> None:
        if reference == "sp-ref:failing":
            raise RuntimeError("permission_denied")


def _typescript() -> tuple[list[str], list[str]]:
    """The TypeScript package's request bytes and answers, one per line."""
    script = f"""
import {{ answerGrantRequest, encodeGrantReply, encodeGrantRequest }} from "./src/index.ts";
const requests = {json.dumps(REQUESTS)};
const answers = {json.dumps([payload for _, payload in ANSWERS])};
const ledger = {json.dumps(_FAKE_LEDGER)};
const REQUESTER = {json.dumps(REQUESTER)};
const fake = {{
  owns: (r) => r !== "sp-ref:else",
  granted: (r, g) => (`${{g.account}}.${{g.user}}` === REQUESTER ? ledger[r] : undefined),
  grantRead: (r) => {{
    if (r === "sp-ref:failing") throw new Error("permission_denied");
  }},
}};
for (const request of requests) console.log(JSON.stringify(encodeGrantRequest(request)));
for (const payload of answers) {{
  console.log(JSON.stringify(encodeGrantReply(await answerGrantRequest(REQUESTER, payload, fake))));
}}
"""
    out = subprocess.run(
        ["bun", "run", "-"],
        check=False,
        input=script,
        capture_output=True,
        text=True,
        cwd=TS_DIR,
        timeout=60,
    )
    if out.returncode != 0:
        pytest.fail(f"could not run the TypeScript package: {out.stderr.strip()[:400]}")
    # Each line is the bytes as a JSON string, so every character survives
    # stdout; split on newlines only, since `splitlines()` also splits U+2028.
    lines = [json.loads(line) for line in out.stdout.strip().split("\n")]
    return lines[: len(REQUESTS)], lines[len(REQUESTS) :]


def test_requests_are_byte_identical_across_packages() -> None:
    ts_requests, _ = _typescript()
    assert [r.encode() for r in ts_requests] == [encode_grant_request(r) for r in REQUESTS]


async def test_the_creators_answers_are_byte_identical_across_packages() -> None:
    _, ts_answers = _typescript()
    py_answers = [
        encode_grant_reply(await answer_grant_request(REQUESTER, payload, _Fake()))
        for _, payload in ANSWERS
    ]
    for (what, _), ts, py in zip(ANSWERS, ts_answers, py_answers, strict=True):
        assert ts.encode() == py, what
    # And each line of the rule answered in words of its own.
    assert len(set(py_answers)) == len(ANSWERS)
