# Deliver large replies by reference

Both reference agents limit inline model replies to 65,536 UTF-8 bytes.
The boundary counts bytes, including all bytes of multibyte characters.
A reply at the boundary keeps the existing behavior: the original text, with a reference appended when the caller receives a grant.
Small replies without a successful grant still return their original text.

A larger result must have both a retained ScratchPad publication and a successful grant to the verified caller.
The agent then sends a short explanation, the logical UTF-8 byte count, and the exact reference returned by ScratchPad.
The large result stays in ScratchPad; the protocol response does not repeat its content.
The adapter does not return a digest, so this message makes no digest claim.
The recipient reads through its own identity and the existing grant.

If ScratchPad is unavailable or absent, publication fails, or the caller cannot receive a grant, large delivery is refused explicitly.
The refusal is bounded and contains neither the artifact reference nor provider error details.
It does not fall back to sending the oversized result inline.
A successful stored publication can remain retained even if the later grant fails or the caller is unsigned.
Normal retention and explicit recovery rules still apply.

## Conversation history

For a large result, the next model request remembers the actual delivered message: the explanation and reference, or the refusal.
It does not silently keep another copy of the large result in conversational history.
A later task must read a still-valid reference explicitly to obtain that content again.
Small-result history remains the original model text, as before.
This policy bounds retained large replies; it does not bound a model's generated result or an incoming reference read.
The native clients read text through their separate 16 MiB convenience-read limit.

## Check both languages

The shared cases in [reply-delivery.json](../test-fixtures/reply-delivery.json) define byte boundaries and delivery outcomes.
The actual agent tests use local NATS with signed and unsigned callers.
The model and ScratchPad are external test substitutes; these tests do not establish deployed storage capacity.

```sh
cd reference-agents/typescript
npm test -- test/reply.test.ts test/reply-agent.test.ts test/agent.test.ts
npm run typecheck
```

```sh
cd reference-agents/python
uv run --python 3.12 pytest tests/test_reply.py tests/test_reply_agent.py tests/test_agent.py
```

From the repository root, run the mutation controls with the same installed SDK dependencies:

```sh
uv run --script reference-agents/test-fixtures/reply_controls.py --evidence /absolute/private/reply-controls
```

The controls change UTF-8 byte counting, bypass the grant condition, and put the original large text back in history.
Each selected test must fail on its own behavioral assertion.
The control runner preserves source copies and output outside the checkout and does not change the working source.
Run `make test-reply-controls REPLY_EVIDENCE=/absolute/private/reply-controls` from `reference-agents/` to run the same controls.

## Source

This port adapts `agent-fabric-examples-scratchpad` PR #3, commit `4c06bde289c175119a97d09f89c7802d131cd75f`.
The handlers use the current public ScratchPad port and native client defaults.
The handler fixtures use the shared Go-generated v2 reference.
