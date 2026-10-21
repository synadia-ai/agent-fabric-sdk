// A caller with exactly a caller's permissions, in operator mode: erin, an
// ACME user whose JWT carries the allow lists of
// `test-fixtures/identity/operator/caller-permissions.json`, prompts an agent
// alice hosts without limits. It lists, finds, prompts and asks; its edge
// record lands on `TRACE.edges` and validates; the prompt is a root, and its
// root is the one `prompt()` returned; the agent sees erin verified. Without
// `$SYS.REQ.USER.INFO` the caller fails to start, and on the default inbox
// prefix the caller is refused: both belong to what a caller needs.

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import {
  Agents,
  decodeJwtPayload,
  newAgentId,
  resolveNatsConnectionBundle,
  type SenderInfo,
} from "@synadia-ai/agents";
import {
  CANNOT_ANSWER,
  FabricCallerError,
  fabricCaller,
  fabricTracing,
  type FabricCaller,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import { capture, dec, drain, edgeSchemaErrors, enc, parse, sleep } from "../support/fixtures.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
}
interface UserKeys {
  readonly users: Record<string, { readonly public: string }>;
}
interface CallerPermissions {
  readonly pub: string[];
  readonly sub: string[];
}
const bin = await findNatsServerBinary();
const readJson = async <T>(name: string): Promise<T> =>
  JSON.parse(await readFile(identityFixture(name), "utf8")) as T;
const opKeys = await readJson<OperatorKeys>("operator/keys.json");
const userKeys = await readJson<UserKeys>("keys.json");
const permissions = await readJson<CallerPermissions>("operator/caller-permissions.json");
const ERIN_ID = newAgentId(opKeys.accounts["ACME"]!.public, userKeys.users["erin"]!.public);
const ERIN = identityFixture("operator/erin.creds");
const ERIN_NO_USER_INFO = identityFixture("operator/erin-no-user-info.creds");
const ALICE = identityFixture("operator/alice.creds");

const USER_INFO = "$SYS.REQ.USER.INFO";

/** The `nats` claims of the user JWT in a creds file. */
async function userClaims(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  const jwt = /-----BEGIN NATS USER JWT-----\s*([^\s-][^\s]*)\s*-+END NATS USER JWT/.exec(
    text,
  )?.[1];
  if (jwt === undefined) throw new Error(`no user JWT in ${path}`);
  return decodeJwtPayload(jwt)["nats"] as Record<string, unknown>;
}

describe("the caller fixtures carry the caller's permissions", () => {
  it("erin.creds allows exactly the list", async () => {
    const nats = await userClaims(ERIN);
    expect(nats["pub"]).toEqual({ allow: permissions.pub });
    expect(nats["sub"]).toEqual({ allow: permissions.sub });
    expect(permissions.pub).toContain(USER_INFO);
  });

  it("erin-no-user-info.creds allows the list without the identity lookup", async () => {
    const nats = await userClaims(ERIN_NO_USER_INFO);
    expect(nats["pub"]).toEqual({ allow: permissions.pub.filter((s) => s !== USER_INFO) });
    expect(nats["sub"]).toEqual({ allow: permissions.sub });
  });
});

describe.skipIf(!bin)("a caller with a caller's permissions", () => {
  const server = new NatsServerProcess();
  let alice: NatsConnection;
  let svc: AgentService;
  let caller: FabricCaller;
  const seen: Array<{ prompt: string; sender: SenderInfo | undefined; answer?: string }> = [];

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    alice = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(enc.encode(await readFile(ALICE, "utf8"))),
      reconnect: false,
    });
    const tracing = fabricTracing();
    svc = new AgentService({
      nc: alice,
      agent: "writer",
      owner: "fabric",
      name: "writer-1",
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [tracing.requestInterceptor],
    });
    svc.onPrompt(async (envelope, response) => {
      const entry: (typeof seen)[number] = { prompt: envelope.prompt, sender: response.sender };
      seen.push(entry);
      if (envelope.prompt.startsWith("ask:")) {
        const answer = await response.ask("which colour?", { timeoutMs: 3_000 });
        entry.answer = answer.prompt;
        await response.send(`got ${answer.prompt}`);
      } else {
        await response.send(`echo: ${envelope.prompt}`);
      }
    });
    await svc.start();
    caller = await fabricCaller({ creds: ERIN, url: server.url, name: "erin-cli" });
  });

  afterAll(async () => {
    await caller?.close();
    await svc?.stop();
    await alice?.close();
    await server.stop();
  });

  it("lists the agent", async () => {
    const found = await caller.list();
    expect(found.map((a) => a.promptSubject)).toEqual([svc.subject.prompt]);
  });

  it("finds it by address and by kind", async () => {
    expect((await caller.find(svc.subject.prompt)).promptSubject).toBe(svc.subject.prompt);
    expect((await caller.find("writer")).promptSubject).toBe(svc.subject.prompt);
    await expect(caller.find("nobody")).rejects.toThrow(
      `no agent "nobody"; there: ${svc.subject.prompt}`,
    );
  });

  it("prompts: one edge record, a root, the root it returned, a verified sender", async () => {
    const edges = capture(alice, "TRACE.edges");
    const prompts = capture(alice, svc.subject.prompt);
    await alice.flush();
    const { stream, rootId } = await caller.prompt("writer", "hello");
    let text = "";
    for await (const m of stream) if (m.type === "response") text += m.text;
    const root = await rootId;
    await sleep(200);
    edges.stop();
    prompts.stop();

    expect(text).toBe("echo: hello");
    expect(edges.msgs).toHaveLength(1);
    const record = parse(edges.msgs[0]!);
    expect(edgeSchemaErrors(record)).toEqual([]);
    expect(record).toMatchObject({
      parent_id: null,
      thread_id: root,
      root_id: root,
      agent: ERIN_ID,
    });
    expect(dec.decode(prompts.msgs[0]!.data)).toBe(
      `{"prompt":"hello","thread_id":"${root}","root_id":"${root}"}`,
    );
    const sender = seen.at(-1)!.sender;
    expect(sender?.trust).toBe("verified");
    expect(sender?.trust === "verified" ? sender.id : undefined).toBe(ERIN_ID);
  });

  it("asks: the whole reply and its root", async () => {
    const reply = await caller.ask("writer", "hi");
    expect(reply.text).toBe("echo: hi");
    expect(reply.rootId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("answers a question with onQuery", async () => {
    const reply = await caller.ask("writer", "ask: colour", { onQuery: () => "blue" });
    expect(reply.text).toBe("got blue");
    expect(seen.at(-1)!.answer).toBe("blue");
  });

  it("tells the agent it cannot answer without onQuery, and the agent goes on", async () => {
    const reply = await caller.ask("writer", "ask: colour");
    expect(reply.text).toBe(`got ${CANNOT_ANSWER}`);
  });

  it("fails at fabricCaller() without $SYS.REQ.USER.INFO, which signing needs", async () => {
    const err = await fabricCaller({ creds: ERIN_NO_USER_INFO, url: server.url }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FabricCallerError);
    expect((err as FabricCallerError).reason).toBe("identity");
    expect((err as Error).message).toMatch(/USER\.INFO/);
  });

  it("settles rootId when the stream is cancelled before it goes out", async () => {
    const { stream, rootId } = await caller.prompt("writer", "never sent");
    stream.cancel();
    await expect(rootId).rejects.toMatchObject({ reason: "not-sent" });
  });

  it("settles rootId when iteration fails before the prompt goes out", async () => {
    const { stream, rootId } = await caller.prompt("writer", "never sent");
    await caller.agents.close();
    await expect(drain(stream)).rejects.toThrow();
    await expect(rootId).rejects.toThrow();
  });

  it("gives the server's own refusal for creds it does not accept", async () => {
    // erin's creds with the JWT's claims changed after signing: the
    // signature no longer verifies, so the server refuses the connection.
    const text = await readFile(ERIN, "utf8");
    const jwt = /-----BEGIN NATS USER JWT-----\s*(\S+)/.exec(text)![1]!;
    const [head, body, sig] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<
      string,
      unknown
    >;
    const forged = Buffer.from(JSON.stringify({ ...claims, name: "mallory" })).toString(
      "base64url",
    );
    const dir = await mkdtemp(join(tmpdir(), "fabric-caller-"));
    const bad = join(dir, "bad.creds");
    await writeFile(bad, text.replace(jwt, `${head}.${forged}.${sig}`));
    const err = await fabricCaller({ creds: bad, url: server.url }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/authorization violation/i);
    expect((err as FabricCallerError).reason).toBe("connect");
  });

  it("is refused on the default inbox prefix", async () => {
    const bundle = await resolveNatsConnectionBundle(
      { url: server.url, creds: ERIN },
      { identity: "signed" },
    );
    const nc = await connect({ ...bundle.connectionOptions, reconnect: false });
    const agents = new Agents({ nc, identity: { signer: bundle.signer } });
    try {
      await expect(agents.discover({ timeoutMs: 500 })).rejects.toThrow(
        /Permissions Violation for Subscription to "_INBOX\.(?!agents\.)/,
      );
      await expect(agents.selfId()).rejects.toThrow();
    } finally {
      await agents.close();
      await nc.close();
      bundle.wipe();
    }
  });

  it("names the URL when it cannot connect", async () => {
    const err = await fabricCaller({ creds: ERIN, url: "nats://127.0.0.1:1" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FabricCallerError);
    expect((err as FabricCallerError).reason).toBe("connect");
    expect((err as Error).message).toContain("nats://127.0.0.1:1");
  });
});
