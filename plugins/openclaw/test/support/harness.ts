// The nats-server harness and the shared fixtures are the fabric package's,
// re-exported: one launcher, one copy of the identity fixtures' paths, one
// schema validator each for `edge.json` and `served.json`. The package's own
// tests resolve the SDK through its own node_modules, which is the same
// checkout this package links.

export {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../../../../typescript/test/harness/nats-server.js";

export {
  capture,
  dec,
  drain,
  edgeSchemaErrors,
  enc,
  handleOf,
  parse,
  servedSchemaErrors,
  sleep,
} from "../../../../typescript/test/support/fixtures.js";
