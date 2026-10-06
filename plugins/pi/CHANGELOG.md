# Changelog

All notable changes to `@synadia-ai/agent-fabric-pi` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

### Added

- The extension module for the PI channel plugin, named in `SYNADIA_PI_EXTENSIONS`: `fabricTracing()` on the plugin's service and agent-tools client.
- The `X-Synadia-Thread-ID` and `X-Synadia-Root-ID` headers on PI's own model calls, with each served request's scope bound at PI's events.
- The `409` loop guard in front of PI's handler.
- The edge subject setting: `options.edgeSubject`, `SYNADIA_FABRIC_EDGE_SUBJECT`, or `TRACE.edges`.
- ScratchPad: the shared skill with the sp command line for darwin and linux, its variables for `scripts/sp`, references in and out, and grant requests.

[0.1.0]: https://github.com/synadia-ai/agent-fabric-sdk/tree/main/plugins/pi
