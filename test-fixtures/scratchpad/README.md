# ScratchPad protocol vectors

Vector set: `scratchpad-v2-vector-build-2f59c514`.

[`codec/manifest.txt`](codec/manifest.txt) lists 47 JSON vectors for canonical encoding and decoding.
The vectors specify canonical CBOR bytes, content identities, and rejection reasons.
They contain public protocol data and deterministic test inputs.

The TypeScript and Python codec suites verify every file listed in the manifest.
Both suites also check that no extra fixture exists.
The TypeScript encoder uses an unpaired surrogate for fixtures with invalid UTF-8 logical names.
JavaScript strings cannot represent invalid UTF-8 bytes.
The encoded CBOR fixture bytes remain unchanged.

[`reference-v2.json`](reference-v2.json) specifies an exact v2 reference token and its canonical JSON.
It covers HTML punctuation, U+2028, and U+2029.
Its ACME account key comes from this repository's public
identity fixtures. The `source` field identifies this vector build.
The codec suites compare the encoded token and JSON with these values.

[`reference-short-v1.json`](reference-short-v1.json) pairs one fixed 66-character
short token with that same expanded descriptor and full token. It pins the route
digest, complete creation identifier, retention handle and path index.
Both native suites validate the pair and reject malformed or mismatched locators.
Run `python3 scripts/generate-short-reference-fixture.py` from the repository root
to reproduce this deterministic public vector. Its verifier key is a throwaway test input.

[`reference-intent-v1.json`](reference-intent-v1.json) pins an intent whose Go JSON
encoding has exactly 3072 bytes. It contains HTML punctuation, U+2028, U+2029,
every C0 control, a quote and a backslash. Both native suites accept the vector
and its 3071-byte variant, and reject its 3073-byte variant. The same generator
reproduces this vector.
