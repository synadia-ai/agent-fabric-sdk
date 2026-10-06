# Changelog

All notable changes to `@synadia-ai/agent-fabric-openclaw` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

### Added

- The extension module for the OpenClaw channel plugin, named in `SYNADIA_OPENCLAW_EXTENSIONS`: `fabricTracing()` on the plugin's service and agent-tools client.
- A fresh trace id per served prompt, seeded into OpenClaw's trace scope so its model calls carry it in their `traceparent`.
- The signed `served` pair binding each served prompt to that trace id.
- The `409` loop guard in front of the gateway's handler.
- The edge subject setting: `options.edgeSubject`, `SYNADIA_FABRIC_EDGE_SUBJECT`, or `TRACE.edges`.
- ScratchPad: the shared skill with the sp command line for darwin and linux, its variables for `scripts/sp`, references in and out, and grant requests.

[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/plugins/openclaw
