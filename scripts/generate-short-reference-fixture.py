#!/usr/bin/env python3
"""Write deterministic public short-reference and intent-boundary vectors."""

import base64
import hashlib
import hmac
import json
from pathlib import Path


def go_json(value: object) -> str:
    result = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    for source, escaped in (
        ("<", "\\u003c"),
        (">", "\\u003e"),
        ("&", "\\u0026"),
        ("\u2028", "\\u2028"),
        ("\u2029", "\\u2029"),
    ):
        result = result.replace(source, escaped)
    return result


root = Path(__file__).resolve().parents[1]
full = json.loads((root / "test-fixtures/scratchpad/reference-v2.json").read_text())
reference = full["reference"]
route = hashlib.sha256(
    (
        "scratchpad-reference-volume-v1\0"
        + reference["account"]
        + "\0"
        + reference["target"]["volume"]
    ).encode()
).digest()[:8]
payload = (
    route
    + bytes.fromhex(reference["target"]["creation_id"])
    + reference["retention"]["generation"].to_bytes(8, "big")
    + bytes([reference["retention"]["slot"] << 3])
)
# Throwaway vector key. Production verifier material never leaves the service.
verifier = hmac.new(
    bytes(range(16)), b"scratchpad-short-reference-v1\0" + payload, hashlib.sha256
).digest()[:12]
token = "sp-r1:" + base64.urlsafe_b64encode(payload + verifier).decode().rstrip("=")
value = {
    "source": "durable-reference-v1 deterministic public vector",
    "resolved": {"short": token, "expanded": reference},
    "full_token": full["token"],
    "locator": {
        "route": route.hex(),
        "creation_id": reference["target"]["creation_id"],
        "retention": reference["retention"],
        "path_index": 0,
    },
}
(root / "test-fixtures/scratchpad/reference-short-v1.json").write_text(
    json.dumps(value, ensure_ascii=True, indent=2) + "\n"
)

# One exact-boundary intent includes every C0 control, HTML punctuation, both
# line separators, a quote and a backslash. Paths remain canonical and bounded.
creator = "<" * 450 + "<>&\u2028\u2029" + "".join(chr(i) for i in range(32)) + '"\\'
paths = ["/a<>&\u2028\u2029", "/b"]
intent = {"creator": creator, "paths": paths}
paths[1] += "x" * (3072 - len(go_json(intent).encode()))
assert len(creator.encode()) <= 512
assert all(len(path.encode()) <= 256 for path in paths)
assert len(go_json(intent).encode()) == 3072
(root / "test-fixtures/scratchpad/reference-intent-v1.json").write_text(
    json.dumps(
        {
            "source": "durable-reference-v1 Go JSON byte-bound vector",
            "reference": intent,
            "go_json": go_json(intent),
        },
        ensure_ascii=True,
        indent=2,
    )
    + "\n"
)
