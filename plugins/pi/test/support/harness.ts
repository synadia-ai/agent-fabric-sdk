// The nats-server harness and the shared fixtures are the fabric package's,
// re-exported: one launcher, one copy of the identity fixtures' paths, one
// schema validator for `edge.json`. The package's own tests resolve the SDK
// through its own node_modules, which is the same checkout this package
// links.

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
  sleep,
} from "../../../../typescript/test/support/fixtures.js";

// The fabric package's stand-in for the sp command line.
export const FAKE_SP = new URL("../../../../typescript/test/harness/fake-sp.mjs", import.meta.url)
  .pathname;
