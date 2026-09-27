"""Bound inline delivery and the conversational history of large model results."""

MAX_INLINE_REPLY_BYTES = 64 * 1024


def delivered_reply(text: str, granted_reference: str | None = None) -> tuple[str, str]:
    """Accept a reference only after retained publication and the caller's grant succeed."""
    size = len(text.encode("utf-8"))
    if size <= MAX_INLINE_REPLY_BYTES:
        reply = text if granted_reference is None else f"{text}\n\n{granted_reference}"
        return reply, text
    if granted_reference is None:
        reply = (
            f"Delivery refused: the {size}-byte result exceeds the {MAX_INLINE_REPLY_BYTES}-byte inline limit "
            "and no retained ScratchPad handoff was granted."
        )
    else:
        reply = (
            f"Result stored in ScratchPad ({size} UTF-8 bytes). Read the granted reference to retrieve it."
            f"\n\n{granted_reference}"
        )
    # A later model turn must read the reference explicitly to recover this content.
    return reply, reply
