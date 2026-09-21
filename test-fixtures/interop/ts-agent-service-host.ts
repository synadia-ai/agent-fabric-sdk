// A minimal `AgentService` host for cross-language and cross-version
// tracing interop tests. Adapted from the protocol SDK's host of the same
// name at synadia-agents c9d7bcb, where tracing still lived in the SDK.
//
// Fed to `bun run -` on stdin, so `@synadia-ai/*` resolve from the working
// directory: this repo's `typescript/` for the protocol SDK the fabric
// builds on, or a scratch directory holding the last published
// (pre-tracing) release — the script uses only API that exists in both,
// and loads the fabric only when asked to trace.
//
// Environment:
//   NATS_URL             server to connect to (required)
//   AGENT                `agent` token (default `interop-host`)
//   TRACE=1              run the fabric's request interceptor and heartbeat
//                        extras; FABRIC_MODULE names the module to load them
//                        from (this repo's `typescript/src/index.ts`).
//                        Otherwise the host is the protocol SDK alone
//   NATS_NKEY_SEED_FILE  authenticate the connection with this user seed
//   NATS_CREDS_FILE      authenticate the connection with this .creds file
//
// Echo: `echo: <prompt>` plus ` thread=<id> root=<id>` when the execution
// was traced, so a caller can see what the host adopted or minted.

import { readFileSync } from "node:fs";
import {
  connect,
  credsAuthenticator,
  nkeyAuthenticator,
} from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";

interface Fabric {
  fabricTracing(): {
    requestInterceptor: unknown;
    heartbeatExtras: () => Readonly<Record<string, unknown>>;
  };
  traceHeaders(): Record<string, string>;
}

const url = process.env["NATS_URL"];
if (!url) throw new Error("NATS_URL is required");
const agent = process.env["AGENT"] ?? "interop-host";
const seedFile = process.env["NATS_NKEY_SEED_FILE"];
const credsFile = process.env["NATS_CREDS_FILE"];
const traced = process.env["TRACE"] === "1";
const enc = new TextEncoder();

const nc = await connect({
  servers: url,
  reconnect: false,
  ...(seedFile
    ? {
        authenticator: nkeyAuthenticator(
          enc.encode(readFileSync(seedFile, "utf8").trim()),
        ),
      }
    : {}),
  ...(credsFile
    ? {
        authenticator: credsAuthenticator(
          enc.encode(readFileSync(credsFile, "utf8")),
        ),
      }
    : {}),
});

let traceHeaders: () => Record<string, string> = () => ({});
let hooks: Record<string, unknown> = {};
if (traced) {
  const modulePath = process.env["FABRIC_MODULE"];
  if (!modulePath) throw new Error("TRACE=1 needs FABRIC_MODULE");
  const fabric = (await import(modulePath)) as Fabric;
  const tracing = fabric.fabricTracing();
  hooks = {
    interceptors: [tracing.requestInterceptor],
    heartbeatExtras: tracing.heartbeatExtras,
  };
  traceHeaders = fabric.traceHeaders;
}

const svc = new AgentService({
  nc,
  agent,
  owner: "interop",
  name: "host",
  heartbeatIntervalS: 5,
  keepaliveIntervalS: null,
  ...hooks,
} as ConstructorParameters<typeof AgentService>[0]);

svc.onPrompt(async (envelope, response) => {
  const headers = traceHeaders();
  let text = `echo: ${envelope.prompt}`;
  const thread = headers["X-Synadia-Thread-ID"];
  const root = headers["X-Synadia-Root-ID"];
  if (thread !== undefined) text += ` thread=${thread} root=${root ?? ""}`;
  await response.send(text);
});

await svc.start();
console.log(`agent service listening on ${svc.subject.prompt}`);

const shutdown = async (): Promise<void> => {
  try {
    await svc.stop();
  } finally {
    await nc.close();
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await new Promise(() => {});
