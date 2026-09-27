/** Model text above this UTF-8 byte limit must travel by a granted reference. */
export const MAX_INLINE_REPLY_BYTES = 64 * 1024;

/** A reference is supplied only after retained publication and the caller's grant succeed. */
export function deliveredReply(text: string, grantedReference?: string): { reply: string; history: string } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_INLINE_REPLY_BYTES) {
    return { reply: grantedReference === undefined ? text : `${text}\n\n${grantedReference}`, history: text };
  }
  const reply = grantedReference === undefined
    ? `Delivery refused: the ${bytes}-byte result exceeds the ${MAX_INLINE_REPLY_BYTES}-byte inline limit and no retained ScratchPad handoff was granted.`
    : `Result stored in ScratchPad (${bytes} UTF-8 bytes). Read the granted reference to retrieve it.\n\n${grantedReference}`;
  // Do not silently retain the oversized result in the next model request.
  return { reply, history: reply };
}
