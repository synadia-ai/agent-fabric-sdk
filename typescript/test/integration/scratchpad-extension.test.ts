// The ScratchPad extension over a real nats-server, in operator mode with
// real identities: a caller (bob, in APP) runs `AgentTools` with the
// extension and `fabricTracing()`, and serves prompts whose handler plays
// the model — each prompt names one tool call, the handler executes it and
// answers with the result. It prompts a target that reads references
// (carol, ACME), one that reads none (carol again, another name), and a
// creator (alice, ACME) that hands out references of its own and answers
// grant requests on its extra endpoint. Every agent's ScratchPad is an
// in-memory fake that records its grants. `python/tests/test_scratchpad_e2e.py`
// is the twin.

import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { AgentService } from "@synadia-ai/agent-service";
import {
  Agents,
  AgentSubject,
  AgentTools,
  newAgentId,
  signerFromCredsFile,
  type Agent,
  type SenderSigner,
} from "@synadia-ai/agents";
import {
  activeTrace,
  encodeGrantReply,
  fabricTracing,
  grantRequestEndpoint,
  scratchPadExtension,
  type TraceIds,
} from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import {
  dec,
  edgeSchemaErrors,
  enc,
  grantReplySchemaErrors,
  grantRequestSchemaErrors,
  parse,
  sleep,
} from "../support/fixtures.js";
import { makeReference, MemoryScratchPad } from "../support/scratchpad.js";

interface OperatorKeys {
  readonly accounts: Record<string, { readonly public: string }>;
  readonly users: Record<string, { readonly public: string; readonly account: string }>;
}
const bin = await findNatsServerBinary();
const keys = JSON.parse(
  await readFile(identityFixture("operator/keys.json"), "utf8"),
) as OperatorKeys;
const idOf = (user: string): string =>
  newAgentId(keys.accounts[keys.users[user]!.account]!.public, keys.users[user]!.public);
const BOB = idOf("bob");
const CAROL = idOf("carol");

const CALLER = AgentSubject.new("caller", "fabric", "c1").prompt;
const TARGET = AgentSubject.new("target", "fabric", "t1").prompt;
const PLAIN = AgentSubject.new("plain", "fabric", "p1").prompt;
const CREATOR = AgentSubject.new("creator", "fabric", "r1").prompt;
const GRANTS = "agents.sp-grant.creator.fabric.r1";

/** What the caller's handler answers: the tool's result and the served prompt's ids. */
interface Played {
  readonly result: Record<string, unknown>;
  readonly served: TraceIds;
}

describe.skipIf(!bin)("the ScratchPad extension between three agents", () => {
  const server = new NatsServerProcess();
  const connections: NatsConnection[] = [];
  const services: AgentService[] = [];
  const clients: Agents[] = [];
  let tools: AgentTools;
  let driver: Agents;
  let callerHandle: Agent;
  let bobSigner: SenderSigner;
  const tracing = fabricTracing();
  const callerPad = new MemoryScratchPad("vol-bob", CALLER);
  const creatorPad = new MemoryScratchPad("vol-alice", CREATOR);
  const seenByTarget: string[] = [];
  const seenByPlain: string[] = [];
  const edges: Msg[] = [];
  const grantRequests: Msg[] = [];
  let remember: (text: string) => void = () => {};

  async function as(user: string): Promise<NatsConnection> {
    const creds = identityFixture(`operator/${user}.creds`);
    const nc = await connect({
      servers: server.url,
      authenticator: credsAuthenticator(enc.encode(await readFile(creds, "utf8"))),
      reconnect: false,
    });
    connections.push(nc);
    return nc;
  }

  function reader(
    nc: NatsConnection,
    signer: SenderSigner,
    name: string,
    seen: string[],
    reads: boolean,
  ): AgentService {
    const svc = new AgentService({
      nc,
      agent: name.split(".")[0]!,
      owner: "fabric",
      name: name.split(".")[1]!,
      identity: { signer },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [tracing.requestInterceptor],
      ...(reads ? { extraMetadata: { scratchpad_refs_ok: "true" } } : {}),
    });
    svc.onPrompt(async (envelope, response) => {
      seen.push(envelope.prompt);
      await response.send("read");
    });
    return svc;
  }

  /**
   * One tool call, played by the caller inside a prompt it serves. The call
   * travels base64url-encoded on the prompt's first line, so the caller is
   * given no reference by it; `handed` follows in plain text, as a
   * reference handed over in a prompt.
   */
  async function play(
    tool: string,
    args: unknown,
    toolCallId: string,
    handed = "",
  ): Promise<Played> {
    const script = Buffer.from(JSON.stringify({ tool, args, toolCallId })).toString("base64url");
    let text = "";
    for await (const m of await callerHandle.prompt(`${script}\n${handed}`)) {
      if (m.type === "response") text += m.text;
    }
    return JSON.parse(text) as Played;
  }

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("operator/operator.conf") });
    const [ncBob, ncAlice, ncCarol] = [await as("bob"), await as("alice"), await as("carol")];
    bobSigner = await signerFromCredsFile(identityFixture("operator/bob.creds"));
    const aliceSigner = await signerFromCredsFile(identityFixture("operator/alice.creds"));
    const carolSigner = await signerFromCredsFile(identityFixture("operator/carol.creds"));

    // The target that reads references, and the one that reads none.
    services.push(reader(ncCarol, carolSigner, "target.t1", seenByTarget, true));
    services.push(reader(ncCarol, carolSigner, "plain.p1", seenByPlain, false));

    // The creator: hands a reference of its own to its verified caller, and
    // answers grant requests about it.
    const aliceClient = new Agents({ nc: ncAlice, identity: { signer: aliceSigner } });
    clients.push(aliceClient);
    const creatorExt = scratchPadExtension({ scratchPad: creatorPad, agents: aliceClient });
    const creator = new AgentService({
      nc: ncAlice,
      agent: "creator",
      owner: "fabric",
      name: "r1",
      identity: { signer: aliceSigner },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [tracing.requestInterceptor, creatorExt.requestInterceptor],
      extraMetadata: { scratchpad_refs_ok: "true" },
      extraEndpoints: [grantRequestEndpoint({ promptAddress: CREATOR, scratchPad: creatorPad })],
    });
    creator.onPrompt(async (_envelope, response) => {
      const ref = creatorPad.commit();
      let reply = "the findings";
      if (await creatorExt.grantCaller(ref, response.sender)) reply += `\n\n${ref}`;
      await response.send(reply);
    });
    services.push(creator);

    // The caller: the agent tools with the extension, on a traced, signed client.
    const client = new Agents({
      nc: ncBob,
      identity: { signer: bobSigner },
      interceptors: [tracing.promptInterceptor],
    });
    clients.push(client);
    const ext = scratchPadExtension({ scratchPad: callerPad, agents: client });
    remember = (text) => ext.remember(text);
    tools = new AgentTools({ agents: client, selfAddress: CALLER, extensions: [ext] });
    const caller = new AgentService({
      nc: ncBob,
      agent: "caller",
      owner: "fabric",
      name: "c1",
      identity: { signer: bobSigner },
      heartbeatIntervalS: 30,
      keepaliveIntervalS: null,
      interceptors: [tracing.requestInterceptor, tools.requestInterceptor, ext.requestInterceptor],
    });
    caller.onPrompt(async (envelope, response) => {
      const script = Buffer.from(envelope.prompt.split("\n")[0]!, "base64url").toString("utf8");
      const { tool, args, toolCallId } = JSON.parse(script) as {
        tool: string;
        args: unknown;
        toolCallId: string;
      };
      const result = await tools.execute(tool, args, { toolCallId });
      const scope = activeTrace()!;
      await response.send(
        JSON.stringify({ result, served: { threadId: scope.threadId, rootId: scope.rootId } }),
      );
    });
    services.push(caller);
    for (const svc of services) await svc.start();

    for (const [nc, subject, into] of [
      [ncBob, "TRACE.edges", edges],
      [ncAlice, GRANTS, grantRequests],
    ] as const) {
      const sub = nc.subscribe(subject);
      void (async () => {
        for await (const m of sub) into.push(m);
      })();
      await nc.flush();
    }

    driver = new Agents({ nc: ncBob });
    clients.push(driver);
    const found = await driver.discover({ filter: { agent: "caller" } });
    callerHandle = found[0]!;
  });

  afterAll(async () => {
    await tools?.close();
    for (const c of clients) await c.close();
    for (const s of services) await s.stop();
    for (const nc of connections) await nc.close();
    await server.stop();
  });

  it("shows which agents read references", async () => {
    const { result } = await play("discover_agents", {}, "toolu_discover");
    const agents = result["agents"] as Array<Record<string, unknown>>;
    const reads = Object.fromEntries(
      agents.map((a): [unknown, unknown] => [a["address"], a["reads_scratchpad_references"]]),
    ) as Record<string, unknown>;
    expect(reads).toEqual({ [TARGET]: true, [PLAIN]: false, [CREATOR]: true });
    expect(agents.find((a) => a["address"] === TARGET)?.["identity"]).toBe(CAROL);
  });

  it("grants the target read on its own content, first-hand, and sends it", async () => {
    const own = callerPad.commit("/own.md");
    remember(own);
    const { result, served } = await play(
      "prompt_agent",
      { address: TARGET, prompt: `read ${own}` },
      "toolu_own",
    );
    expect(result).toMatchObject({ state: "completed", reply: "read" });
    expect(result).not.toHaveProperty("references_removed");
    expect(seenByTarget.at(-1)).toBe(`read ${own}`);
    expect(callerPad.grants).toEqual([
      {
        reference: own,
        grantee: CAROL,
        trace: served,
        toolCallId: "toolu_own",
        kind: "first-hand",
      },
    ]);
  });

  it("files the call under the served prompt: the edge carries the tool-call ID and validates", async () => {
    await sleep(100);
    const record = edges.map(parse).find((r) => r["tool_call_id"] === "toolu_own");
    const grant = callerPad.grants.find((g) => g.toolCallId === "toolu_own")!;
    expect(record).toMatchObject({
      agent: BOB,
      parent_id: grant.trace!.threadId,
      root_id: grant.trace!.rootId,
    });
    expect(edgeSchemaErrors(record)).toEqual([]);
  });

  let fromCreator = "";

  it("remembers a reference that comes back in a reply, granted to it first-hand", async () => {
    const { result } = await play(
      "prompt_agent",
      { address: CREATOR, prompt: "your findings, please" },
      "toolu_ask",
    );
    expect(result["state"]).toBe("completed");
    fromCreator = /sp-ref:[A-Za-z0-9_-]+/.exec(result["reply"] as string)![0];
    expect(creatorPad.grants).toEqual([
      expect.objectContaining({ reference: fromCreator, grantee: BOB, kind: "first-hand" }),
    ]);
  });

  it("passes it on: the creator grants the target on request, under the call, then it is sent", async () => {
    const { result, served } = await play(
      "prompt_agent",
      { address: TARGET, prompt: `work from ${fromCreator}` },
      "toolu_theirs",
    );
    expect(result).toMatchObject({ state: "completed", reply: "read" });
    expect(seenByTarget.at(-1)).toBe(`work from ${fromCreator}`);
    expect(creatorPad.grants.at(-1)).toEqual({
      reference: fromCreator,
      grantee: CAROL,
      trace: served,
      toolCallId: "toolu_theirs",
      kind: "on-request",
    });
    // The request as it went over the wire: signed, in the schema's shape.
    const request = grantRequests.at(-1)!;
    expect(request.headers?.get("Agent-Sender")).toBeTruthy();
    expect(dec.decode(request.data)).toBe(
      JSON.stringify({
        reference: fromCreator,
        grantee: CAROL,
        trace: { thread_id: served.threadId, root_id: served.rootId, tool_call_id: "toolu_theirs" },
      }),
    );
    expect(grantRequestSchemaErrors(parse(request))).toEqual([]);
  });

  it("takes out a reference its creator refuses, with a note, and sends the rest", async () => {
    // Handed to the caller in a prompt it served, never granted to it.
    const unshared = creatorPad.commit("/private.md");
    const { result } = await play(
      "prompt_agent",
      { address: TARGET, prompt: `summarise ${unshared} and say hi` },
      "toolu_refused",
      `here is what you need: ${unshared}`,
    );
    expect(result).toMatchObject({ state: "completed", references_removed: 1 });
    expect(result["note"]).toContain(
      "(this agent holds no live read grant it made to the requester on that reference)",
    );
    expect(seenByTarget.at(-1)).toBe("summarise  and say hi");
  });

  it("takes every reference out for a target that reads none", async () => {
    const before = callerPad.grants.length;
    const own = callerPad.commit("/for-plain.md");
    remember(own);
    const { result } = await play(
      "prompt_agent",
      { address: PLAIN, prompt: `${own}\nhello` },
      "toolu_plain",
    );
    expect(result).toMatchObject({ state: "completed", references_removed: 1 });
    expect(result["note"]).toMatch(/does not read ScratchPad references/);
    expect(seenByPlain).toEqual(["hello"]);
    expect(callerPad.grants).toHaveLength(before);
  });

  it("refuses a token the caller was not given, and sends nothing", async () => {
    const seen = seenByTarget.length;
    const madeUp = makeReference("vol-bob", "/made-up.md", CALLER);
    const { result } = await play(
      "prompt_agent",
      { address: TARGET, prompt: `read ${madeUp}` },
      "toolu_madeup",
    );
    expect(Object.keys(result)).toEqual(["error"]);
    expect(result["error"]).toMatch(/is not one you were given/);
    await sleep(100);
    expect(seenByTarget).toHaveLength(seen);
  });

  it("answers an unsigned grant request, and a replayed one, with a refusal", async () => {
    const nc = connections[0]!;
    const unsigned = await nc.request(GRANTS, grantRequests.at(-1)!.data, { timeout: 5000 });
    expect(dec.decode(unsigned.data)).toBe(
      encodeGrantReply({ granted: false, reason: "signature required" }),
    );
    const signed = grantRequests.find((m) => m.headers?.get("Agent-Sender"))!;
    const replayed = await nc.request(GRANTS, signed.data, {
      timeout: 5000,
      headers: signed.headers!,
    });
    const reply = parse(replayed);
    expect(reply).toEqual({ granted: false, reason: "sender rejected" });
    expect(grantReplySchemaErrors(reply)).toEqual([]);
    expect([unsigned.headers, replayed.headers]).toEqual([undefined, undefined]);
  });

  it("answers a signed request for a reference it never handed the requester with a refusal", async () => {
    const client = new Agents({ nc: connections[0]!, identity: { signer: bobSigner } });
    clients.push(client);
    const msg = await client.requestSigned(
      GRANTS,
      JSON.stringify({ reference: creatorPad.commit("/other.md"), grantee: CAROL }),
      { timeoutMs: 5000 },
    );
    expect(dec.decode(msg.data)).toBe(
      encodeGrantReply({
        granted: false,
        reason: "this agent holds no live read grant it made to the requester on that reference",
      }),
    );
  });
});
