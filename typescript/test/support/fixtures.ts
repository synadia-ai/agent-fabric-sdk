// Shared test support: the throwaway identity, the edge record's JSON
// Schema, and small helpers for driving a real `AgentService` and `Agents`
// pair over a local nats-server through the public API only.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInbox, type Msg, type NatsConnection } from "@nats-io/nats-core";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { AgentService, type RequestInterceptor } from "@synadia-ai/agent-service";
import {
  Agents,
  signerFromSeed,
  type Agent,
  type PromptInterceptor,
  type RequestEnvelope,
  type SenderSigner,
} from "@synadia-ai/agents";
import { identityFixture } from "../harness/nats-server.js";

interface KeysFile {
  readonly users: Record<string, { readonly public: string; readonly seed: string }>;
}
const keys = JSON.parse(readFileSync(identityFixture("keys.json"), "utf8")) as KeysFile;

/** `alice` from `test-fixtures/identity/keys.json`. */
export const ALICE = keys.users["alice"]!;

export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** The repo root, from this file's URL: `support/` → `test/` → `typescript/` → root. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const EDGE_SCHEMA_PATH = fileURLToPath(
  new URL("../../../test-fixtures/schemas/edge.json", import.meta.url),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateEdgeSchema = ajv.compile(
  JSON.parse(readFileSync(EDGE_SCHEMA_PATH, "utf8")) as Record<string, unknown>,
);

/** The schema's complaints about `record`; `[]` when it validates against `edge.json`. */
export function edgeSchemaErrors(record: unknown): ReadonlyArray<ErrorObject> {
  return validateEdgeSchema(record) ? [] : (validateEdgeSchema.errors ?? []);
}

function vendoredSchema(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../test-fixtures/schemas/${name}`, import.meta.url)),
      "utf8",
    ),
  ) as Record<string, unknown>;
}
// The reply schema names `reason` in a `not: { required }` whose branch has no
// `properties` of its own, which Ajv's `strictRequired` refuses; the schema is
// vendored and never edited, so that one check is off for the grant schemas.
const grantAjv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validateGrantRequest = grantAjv.compile(vendoredSchema("scratchpad_grant.request.json"));
const validateGrantReply = grantAjv.compile(vendoredSchema("scratchpad_grant.reply.json"));

/** The complaints of `scratchpad_grant.request.json` about `request`; `[]` when it validates. */
export function grantRequestSchemaErrors(request: unknown): ReadonlyArray<ErrorObject> {
  return validateGrantRequest(request) ? [] : (validateGrantRequest.errors ?? []);
}

/** The complaints of `scratchpad_grant.reply.json` about `reply`; `[]` when it validates. */
export function grantReplySchemaErrors(reply: unknown): ReadonlyArray<ErrorObject> {
  return validateGrantReply(reply) ? [] : (validateGrantReply.errors ?? []);
}

export function parse(msg: Msg): Record<string, unknown> {
  return JSON.parse(dec.decode(msg.data)) as Record<string, unknown>;
}

export async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _m of stream) {
    /* drain */
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Collect every message on `subject` into `msgs`, in arrival order. */
export function capture(nc: NatsConnection, subject: string): { msgs: Msg[]; stop: () => void } {
  const msgs: Msg[] = [];
  const sub = nc.subscribe(subject);
  void (async () => {
    for await (const m of sub) msgs.push(m);
  })();
  return { msgs, stop: () => sub.unsubscribe() };
}

/** Everything a raw request draws, up to and including the §6.5 terminator. */
export async function rawStream(nc: NatsConnection, subject: string, body: string): Promise<Msg[]> {
  const msgs: Msg[] = [];
  const inbox = createInbox();
  const sub = nc.subscribe(inbox, { timeout: 5_000 });
  nc.publish(subject, body, { reply: inbox });
  for await (const m of sub) {
    msgs.push(m);
    if (m.data.length === 0 && !m.headers) break;
  }
  sub.unsubscribe();
  return msgs;
}

/** The `$SRV.INFO` record of the running instance of `agent`. */
export async function srvInfo(nc: NatsConnection, agent: string): Promise<Record<string, unknown>> {
  const inbox = createInbox();
  const sub = nc.subscribe(inbox, { timeout: 5_000 });
  nc.publish("$SRV.INFO.agents", "", { reply: inbox });
  try {
    for await (const m of sub) {
      const info = parse(m);
      if ((info["metadata"] as Record<string, unknown> | undefined)?.["agent"] === agent) {
        return info;
      }
    }
  } finally {
    sub.unsubscribe();
  }
  throw new Error(`no $SRV.INFO from ${agent}`);
}

export const errorCode = (frames: ReadonlyArray<Msg>): string | undefined =>
  frames.map((m) => m.headers?.get("Nats-Service-Error-Code")).find((c) => c !== undefined);

/** What a {@link host}'s handler saw, per request. */
export interface Handled {
  readonly envelope: RequestEnvelope;
}

export interface HostOptions {
  readonly agent: string;
  readonly interceptors?: ReadonlyArray<RequestInterceptor>;
  readonly heartbeatExtras?: () => Readonly<Record<string, unknown>>;
  readonly maxPayload?: string;
  /** The handler's body; default: reply `ok`. */
  readonly onPrompt?: (
    envelope: RequestEnvelope,
    send: (text: string) => Promise<void>,
  ) => Promise<void>;
}

/** A started `AgentService` on `nc`; stop it with `svc.stop()`. */
export async function host(
  nc: NatsConnection,
  opts: HostOptions,
): Promise<{ svc: AgentService; handled: Handled[] }> {
  const handled: Handled[] = [];
  const svc = new AgentService({
    nc,
    agent: opts.agent,
    owner: "fabric",
    name: `${opts.agent}-1`,
    heartbeatIntervalS: 30,
    keepaliveIntervalS: null,
    ...(opts.interceptors ? { interceptors: opts.interceptors } : {}),
    ...(opts.heartbeatExtras ? { heartbeatExtras: opts.heartbeatExtras } : {}),
    ...(opts.maxPayload !== undefined ? { maxPayload: opts.maxPayload } : {}),
  });
  svc.onPrompt(async (envelope, response) => {
    handled.push({ envelope });
    const send = async (text: string): Promise<void> => {
      await response.send(text);
    };
    await (opts.onPrompt ? opts.onPrompt(envelope, send) : send("ok"));
  });
  await svc.start();
  return { svc, handled };
}

/** A client on `nc`, signing as alice when `signed`, running `interceptors`. */
export function caller(
  nc: NatsConnection,
  opts: {
    readonly signed?: boolean;
    readonly signer?: SenderSigner;
    readonly interceptors?: ReadonlyArray<PromptInterceptor>;
  } = {},
): Agents {
  const signer = opts.signer ?? (opts.signed ? signerFromSeed(ALICE.seed) : undefined);
  return new Agents({
    nc,
    ...(signer ? { identity: { signer } } : {}),
    ...(opts.interceptors ? { interceptors: opts.interceptors } : {}),
  });
}

/** The discovered handle of the service `svc`. */
export async function handleOf(agents: Agents, svc: AgentService): Promise<Agent> {
  const found = await agents.discover({ timeoutMs: 300 });
  const handle = found.find((a) => a.promptSubject === svc.subject.prompt);
  if (handle === undefined) throw new Error(`service ${svc.subject.prompt} not discovered`);
  return handle;
}
