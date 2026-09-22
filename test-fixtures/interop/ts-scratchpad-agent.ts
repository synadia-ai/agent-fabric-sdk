// A TypeScript agent with a ScratchPad, for the cross-language grant request
// tests. The fabric's own, not adapted from anywhere. It reads references
// (`scratchpad_refs_ok`), answers grant requests on
// `agents.sp-grant.<agent>.interop.host` with the fabric package's endpoint,
// and serves prompts: `commit` commits a reply to its in-memory ScratchPad
// and hands the reference to a verified caller with `grantCaller`; anything
// else is answered `read`. `py-scratchpad-agent.py` is its twin.
//
// Fed to `bun run -` on stdin in this repo's `typescript/`, so
// `@synadia-ai/*` resolve from there; FABRIC_MODULE names the fabric package
// (`typescript/src/index.ts`).
//
// It prints one JSON line per event, for the test to read:
//
//   {"event":"prompt","text":...}
//   {"event":"grant","reference","grantee","thread_id","root_id","tool_call_id","kind"}
//   {"event":"request","data":...}       every grant request, as it arrived
//
// Environment:
//   NATS_URL         server to connect to (required)
//   NATS_CREDS_FILE  authenticate with this .creds file, and sign as it (required)
//   AGENT            `agent` token (default `ts-creator`)
//   FABRIC_MODULE    the fabric package to load (required)

import { readFileSync } from "node:fs";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { AgentService } from "@synadia-ai/agent-service";
import { Agents, signerFromCredsFile } from "@synadia-ai/agents";

type Fabric = typeof import("../../typescript/src/index.ts");
type GrantKind = "first-hand" | "on-request";

const url = process.env["NATS_URL"];
const creds = process.env["NATS_CREDS_FILE"];
const modulePath = process.env["FABRIC_MODULE"];
if (!url || !creds || !modulePath) throw new Error("NATS_URL, NATS_CREDS_FILE and FABRIC_MODULE are required");
const agent = process.env["AGENT"] ?? "ts-creator";
const fabric = (await import(modulePath)) as Fabric;

const emit = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event));
};

const decode = (reference: string): { ref: { volume_id: string } } =>
  JSON.parse(Buffer.from(reference.slice("sp-ref:".length), "base64url").toString("utf8"));

class MemoryScratchPad {
  commits = 0;
  readonly ledger = new Map<string, Set<GrantKind>>();
  constructor(
    readonly volumeId: string,
    readonly creator: string,
  ) {}

  commit(): string {
    this.commits += 1;
    const made = {
      ref: { volume_id: this.volumeId, root: "r1", path: `/${this.commits}.md` },
      source_sequence: 1,
      creator: this.creator,
    };
    return "sp-ref:" + Buffer.from(JSON.stringify(made)).toString("base64url");
  }

  owns(reference: string): boolean {
    try {
      return decode(reference).ref.volume_id === this.volumeId;
    } catch {
      return false;
    }
  }

  grantRead(
    reference: string,
    grantee: { account: string; user: string },
    trace: { threadId: string; rootId: string } | undefined,
    toolCallId?: string,
    kind: GrantKind = "first-hand",
  ): void {
    if (!this.owns(reference)) throw new Error("not this volume");
    const who = `${grantee.account}.${grantee.user}`;
    const key = `${reference} ${who}`;
    this.ledger.set(key, new Set([...(this.ledger.get(key) ?? []), kind]));
    emit({
      event: "grant",
      reference,
      grantee: who,
      thread_id: trace?.threadId ?? null,
      root_id: trace?.rootId ?? null,
      tool_call_id: toolCallId ?? null,
      kind,
    });
  }

  granted(reference: string, grantee: { account: string; user: string }): GrantKind | undefined {
    const kinds = this.ledger.get(`${reference} ${grantee.account}.${grantee.user}`);
    if (kinds?.has("first-hand")) return "first-hand";
    return kinds?.has("on-request") ? "on-request" : undefined;
  }
}

const nc = await connect({
  servers: url,
  reconnect: false,
  authenticator: credsAuthenticator(new TextEncoder().encode(readFileSync(creds, "utf8"))),
});
const signer = await signerFromCredsFile(creds);
const tracing = fabric.fabricTracing();
const address = `agents.prompt.${agent}.interop.host`;
const pad = new MemoryScratchPad(`vol-${agent}`, address);
const agents = new Agents({ nc, identity: { signer } });
const ext = fabric.scratchPadExtension({ scratchPad: pad, agents });
const svc = new AgentService({
  nc,
  agent,
  owner: "interop",
  name: "host",
  identity: { signer },
  heartbeatIntervalS: 5,
  keepaliveIntervalS: null,
  interceptors: [tracing.requestInterceptor, ext.requestInterceptor],
  extraMetadata: { scratchpad_refs_ok: "true" },
  extraEndpoints: [fabric.grantRequestEndpoint({ promptAddress: address, scratchPad: pad })],
});

svc.onPrompt(async (envelope, response) => {
  emit({ event: "prompt", text: envelope.prompt });
  if (envelope.prompt === "commit") {
    const ref = pad.commit();
    let reply = "committed";
    if (await ext.grantCaller(ref, response.sender)) reply += `\n\n${ref}`;
    await response.send(reply);
  } else {
    await response.send("read");
  }
});

await svc.start();
const seen = nc.subscribe(fabric.grantSubject(address));
void (async () => {
  for await (const m of seen) emit({ event: "request", data: m.string() });
})();
await nc.flush();
console.log(`agent service listening on ${svc.subject.prompt}`);

const shutdown = async (): Promise<void> => {
  try {
    await agents.close();
    await svc.stop();
  } finally {
    await nc.close();
    process.exit(0);
  }
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
await new Promise(() => {});
