// The grant request, tested on a real nats-server: the fabric package's
// endpoint and requester, signed and verified by the SDK, as an agent wires
// them. The creator's ScratchPad is one in memory that records every grant
// and answers from those records, as the package's own over `sp` keeps its
// ledger; the package tests that one against a stand-in `sp`.
//
//   creator    — an agent with ScratchPad; it commits content, grants the
//                requester read on it, and answers grant requests
//   requester  — was handed the reference; asks the creator to let a third
//                agent read it
//   stranger   — signed like the requester, but never granted anything
//   third      — granted at the requester's request; it may read, and it may
//                not ask for anyone else
//
// Asserted: the creator's rule, line by line. A signed request from an agent
// the creator granted that reference to ends in one grant by the creator:
// the third agent, on its own volume, made on request, labelled with the
// requester's thread and tool call. Everything else is refused in words and
// grants nothing: no signature, a replayed request, a requester never
// granted, a requester whose own grant was made on request, a request for
// oneself, a reference into another volume, a body that is not a request.

import { readFileSync } from "node:fs";
import { headers, type NatsConnection } from "@nats-io/nats-core";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AgentService } from "@synadia-ai/agent-service";
import { AGENT_SENDER_HEADER, Agents, signerFromSeed } from "@synadia-ai/agents";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  grantRequestEndpoint,
  granteeFromIdentity,
  grantSubject,
  requestGrant,
  type GrantKind,
  type Grantee,
  type GrantRequest,
  type ScratchPadClient,
  type TraceIds,
} from "@synadia-ai/agent-fabric";
import { natsServerOnPath, newUser, TestNatsServer } from "./harness/nats-server.js";

// The two shapes of the exchange, in the fabric package's checkout this
// repository links.
const SCHEMAS_DIR = new URL("../../../test-fixtures/schemas/", import.meta.url);
const loadJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(name, SCHEMAS_DIR), "utf8")) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
const validRequest = ajv.compile(loadJson("sp-grant-request.json"));
const validReply = ajv.compile(loadJson("sp-grant-reply.json"));

const CREATOR_ADDRESS = "agents.prompt.assistant.test.creator";
const TRACE = { thread_id: "a".repeat(32), root_id: "b".repeat(32), tool_call_id: "call_9" };

const binary = await natsServerOnPath();

describe.skipIf(binary === undefined)("the grant request between two agents", () => {
  let server: TestNatsServer;
  let ncCreator: NatsConnection;
  let ncRequester: NatsConnection;
  let ncStranger: NatsConnection;
  let ncThird: NatsConnection;
  let creator: AgentService;
  let requester: Agents;
  let stranger: Agents;
  let third: Agents;
  let reference: string;
  const [creatorUser, requesterUser, strangerUser, thirdUser, fourthUser] = [newUser(), newUser(), newUser(), newUser(), newUser()];
  // On a server without accounts every user is in `$G`.
  const identity = (user: { publicKey: string }): string => `$G.${user.publicKey}`;

  // The creator's ScratchPad, in memory: its volume is `vol-own`, and every
  // grant is recorded with how it came about, which is the ledger the rule
  // reads. `issued` is what the test at hand made; the ledger lives on.
  type Grant = { path: string; grantee: Grantee; trace: TraceIds | undefined; toolCallId: string | undefined; kind: GrantKind };
  const ledger: Grant[] = [];
  let issued: Grant[] = [];
  const decode = (ref: string): { volume_id: string; path: string } | undefined => {
    try {
      return (JSON.parse(Buffer.from(ref.slice("sp-ref:".length), "base64url").toString()) as { ref: { volume_id: string; path: string } }).ref;
    } catch {
      return undefined;
    }
  };
  const pad: ScratchPadClient = {
    async commit(_text, path) {
      const made = { ref: { type: "handoff", handoff_id: "h", volume_id: "vol-own", root: "r", path, expires_at: 9e9 }, source_sequence: 1, creator: CREATOR_ADDRESS };
      return `sp-ref:${Buffer.from(JSON.stringify(made)).toString("base64url")}`;
    },
    async read() {
      return "the findings";
    },
    async owns(ref) {
      return decode(ref)?.volume_id === "vol-own";
    },
    async grantRead(ref, grantee, trace, toolCallId, kind = "first-hand") {
      const r = decode(ref);
      if (r?.volume_id !== "vol-own") throw new Error("only its creator can grant read on it");
      const grant = { path: r.path, grantee, trace, toolCallId, kind };
      ledger.push(grant);
      issued.push(grant);
    },
    granted(ref, grantee) {
      const r = decode(ref);
      const mine = ledger.filter((g) => r?.volume_id === "vol-own" && g.path === r.path && g.grantee.user === grantee.user);
      return mine.some((g) => g.kind === "first-hand") ? "first-hand" : mine[0]?.kind;
    },
  };

  beforeAll(async () => {
    server = await TestNatsServer.start(binary!, [creatorUser, requesterUser, strangerUser, thirdUser]);

    const enc = new TextEncoder();
    const open = (seed: string): Promise<NatsConnection> =>
      connect({ servers: server.url, authenticator: nkeyAuthenticator(enc.encode(seed)) });
    [ncCreator, ncRequester, ncStranger, ncThird] = await Promise.all([
      open(creatorUser.seed),
      open(requesterUser.seed),
      open(strangerUser.seed),
      open(thirdUser.seed),
    ]);

    creator = new AgentService({
      nc: ncCreator,
      agent: "assistant",
      owner: "test",
      name: "creator",
      identity: { signer: signerFromSeed(creatorUser.seed) },
      keepaliveIntervalS: null,
      extraEndpoints: [grantRequestEndpoint({ promptAddress: CREATOR_ADDRESS, scratchPad: pad })],
    });
    creator.onPrompt(async (_envelope, response) => {
      await response.send("not prompted in these tests");
    });
    await creator.start();

    requester = new Agents({ nc: ncRequester, identity: { signer: signerFromSeed(requesterUser.seed) } });
    stranger = new Agents({ nc: ncStranger, identity: { signer: signerFromSeed(strangerUser.seed) } });
    third = new Agents({ nc: ncThird, identity: { signer: signerFromSeed(thirdUser.seed) } });

    // What happened before any request: the creator committed its findings
    // and handed the requester the reference, with a read grant.
    reference = await pad.commit("the findings", "/replies/findings.md", undefined);
    await pad.grantRead(reference, granteeFromIdentity(identity(requesterUser)), undefined);
  });

  afterAll(async () => {
    await requester?.close();
    await stranger?.close();
    await third?.close();
    await creator?.stop();
    await Promise.all([ncCreator?.close(), ncRequester?.close(), ncStranger?.close(), ncThird?.close()]);
    await server?.stop();
  });

  beforeEach(() => {
    issued = [];
  });

  /** The grants the creator made in the test at hand. */
  async function grantsIssued(): Promise<Grant[]> {
    return issued;
  }

  it("the creator grants a third agent read at the request of an agent it granted that reference to", async () => {
    const request: GrantRequest = { reference, grantee: identity(thirdUser), trace: TRACE };
    expect(validRequest(request), JSON.stringify(validRequest.errors)).toBe(true);
    const reply = await requestGrant(requester, CREATOR_ADDRESS, request);
    expect(validReply(reply), JSON.stringify(validReply.errors)).toBe(true);
    expect(reply).toEqual({ granted: true });

    // One grant, made by the creator on its own volume: the third agent,
    // the one path, on request, under the requester's thread and tool call.
    const made = await grantsIssued();
    expect(made).toHaveLength(1);
    expect(made[0]).toEqual({
      path: "/replies/findings.md",
      grantee: { account: "$G", user: thirdUser.publicKey },
      trace: { threadId: TRACE.thread_id, rootId: TRACE.root_id },
      toolCallId: TRACE.tool_call_id,
      kind: "on-request",
    });
    // The creator's record keeps the two apart: the requester it handed the
    // reference itself, the third agent it granted because it was asked.
    expect(pad.granted(reference, granteeFromIdentity(identity(requesterUser)))).toBe("first-hand");
    expect(pad.granted(reference, granteeFromIdentity(identity(thirdUser)))).toBe("on-request");
  });

  it("refuses an agent it granted on request: that grant lets it read, not ask for another", async () => {
    // The test above left the third agent with a live grant on the reference.
    expect(pad.granted(reference, granteeFromIdentity(identity(thirdUser)))).toBe("on-request");
    const reply = await requestGrant(third, CREATOR_ADDRESS, { reference, grantee: identity(fourthUser), trace: TRACE });
    expect(validReply(reply), JSON.stringify(validReply.errors)).toBe(true);
    expect(reply).toEqual({
      granted: false,
      reason: expect.stringMatching(/made at another agent's request.*only an agent this agent handed the reference itself/),
    });
    // Nothing was granted, and nothing about the fourth agent is on record.
    expect(await grantsIssued()).toHaveLength(0);
    expect(pad.granted(reference, granteeFromIdentity(identity(fourthUser)))).toBeUndefined();
    // Nor may it ask for the requester, which would keep both alive in turns.
    expect(await requestGrant(third, CREATOR_ADDRESS, { reference, grantee: identity(requesterUser) })).toEqual({
      granted: false,
      reason: expect.stringMatching(/made at another agent's request/),
    });
    expect(await grantsIssued()).toHaveLength(0);
  });

  it("refuses a requester it never granted that reference to", async () => {
    const reply = await requestGrant(stranger, CREATOR_ADDRESS, { reference, grantee: identity(thirdUser) });
    expect(validReply(reply), JSON.stringify(validReply.errors)).toBe(true);
    expect(reply).toEqual({ granted: false, reason: expect.stringMatching(/no live read grant/) });
    // Granted one reference is not granted another.
    const other = await pad.commit("something else", "/replies/other.md", undefined);
    expect(await requestGrant(requester, CREATOR_ADDRESS, { reference: other, grantee: identity(thirdUser) })).toEqual({
      granted: false,
      reason: expect.stringMatching(/no live read grant/),
    });
    expect(await grantsIssued()).toHaveLength(0);
  });

  it("refuses a request without a signature, and one played a second time", async () => {
    const subject = grantSubject(CREATOR_ADDRESS);
    const body = JSON.stringify({ reference, grantee: identity(thirdUser) });
    const unsigned = await ncRequester.request(subject, body, { timeout: 2000 });
    expect(JSON.parse(unsigned.string())).toEqual({ granted: false, reason: expect.stringMatching(/signature required/) });

    // The same signed message twice: the first is served, the second is a replay.
    const h = headers();
    h.set(AGENT_SENDER_HEADER, await requester.signSender(subject, body));
    const first = await ncRequester.request(subject, body, { timeout: 5000, headers: h });
    expect(JSON.parse(first.string())).toEqual({ granted: true });
    const second = await ncRequester.request(subject, body, { timeout: 2000, headers: h });
    expect(JSON.parse(second.string())).toMatchObject({ granted: false });
    expect(await grantsIssued()).toHaveLength(1);
  });

  it("refuses a request for oneself, a reference into another volume, and a body that is no request", async () => {
    expect(await requestGrant(requester, CREATOR_ADDRESS, { reference, grantee: identity(requesterUser) })).toEqual({
      granted: false,
      reason: expect.stringMatching(/for another agent, not for the requester/),
    });
    const foreign = `sp-ref:${Buffer.from(
      JSON.stringify({
        ref: { type: "handoff", handoff_id: "h", volume_id: "vol-other", root: "r", path: "/replies/findings.md", expires_at: 9e9 },
        source_sequence: 1,
      }),
    ).toString("base64url")}`;
    expect(await requestGrant(requester, CREATOR_ADDRESS, { reference: foreign, grantee: identity(thirdUser) })).toEqual({
      granted: false,
      reason: expect.stringMatching(/does not point into this agent's volume/),
    });
    const junk = await requester.requestSigned(grantSubject(CREATOR_ADDRESS), "grant everyone everything");
    expect(JSON.parse(junk.string())).toEqual({ granted: false, reason: "not a grant request" });
    expect(await grantsIssued()).toHaveLength(0);
  });

  it("takes no answer for a refusal", async () => {
    const reply = await requestGrant(requester, "agents.prompt.assistant.test.nobody", { reference, grantee: identity(thirdUser) }, { timeoutMs: 500 });
    expect(validReply(reply), JSON.stringify(validReply.errors)).toBe(true);
    expect(reply).toEqual({ granted: false, reason: expect.stringMatching(/no answer from agents\.prompt\.assistant\.test\.nobody/) });
  });
});
