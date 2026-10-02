"""The shared byte boundary and exact text contract for both example languages."""
import json
from pathlib import Path

import pytest

from fabric_agent.reply import delivered_reply

CASES = json.loads((Path(__file__).parents[2] / "test-fixtures/reply-delivery.json").read_text())


@pytest.mark.parametrize("item", CASES, ids=lambda item: item["name"])
def test_bounded_reply_language_contract(item):
    text = item["unit"] * item["repeat"] + item["suffix"]
    reference = "sp-ref:exact" if item["mode"] == "granted" else None
    assert len(text.encode("utf-8")) == item["bytes"]
    if item["large"]:
        if reference is None:
            expected = (
                f"Delivery refused: the {item['bytes']}-byte result exceeds the 65536-byte inline limit "
                "and no retained ScratchPad handoff was granted."
            )
        else:
            expected = (
                f"Result stored in ScratchPad ({item['bytes']} UTF-8 bytes). Read the granted reference to retrieve it."
                f"\n\n{reference}"
            )
    else:
        expected = text + ("" if reference is None else f"\n\n{reference}")
    assert delivered_reply(text, reference) == (expected, expected if item["large"] else text)
    if item["large"]:
        assert len(expected.encode()) < 1024


def test_large_reply_exposes_only_short_handoff_token():
    reference = "sp-r1:" + "A" * 60
    reply, history = delivered_reply("x" * 65537, reference)
    assert reply.endswith(reference) and "sp-ref:" not in reply
    assert history == reply
