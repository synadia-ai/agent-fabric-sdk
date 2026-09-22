// The grant request without a server: the creator's rule, one test per
// condition, the requester's reading of an answer, and the creator's
// endpoint. `python/tests/test_grant_request.py` is the twin; the signature
// and replay checks, which need a signed message, are in the integration
// tests.

import { describe, expect, it } from "vitest";
import {
  answerGrantRequest,
  encodeGrantRequest,
  grantRequestEndpoint,
  requestGrant,
  type GrantKind,
  type Grantee,
  type TraceIds,
} from "../../src/index.js";
import { makeReference, MemoryScratchPad, stubAgents } from "../support/scratchpad.js";

const SELF = "agents.prompt.creator.fabric.r1";
const REQUESTER = "APP.bob";
const GRANTEE = "ACME.carol";
const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);

function creator(): { pad: MemoryScratchPad; ref: string } {
  const pad = new MemoryScratchPad("vol-creator", SELF);
  const ref = pad.commit("/findings.md");
  // Handed to the requester first-hand: the verified caller of a reply.
  pad.grantRead(ref, { account: "APP", user: "bob" }, undefined);
  pad.grants.length = 0;
  return { pad, ref };
}

const ask = (ref: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ reference: ref, grantee: GRANTEE, ...extra });

describe("the creator's rule", () => {
  it("grants on request: read, the one reference, the requester's labels", async () => {
    const { pad, ref } = creator();
    const payload = encodeGrantRequest({
      reference: ref,
      grantee: GRANTEE,
      trace: { thread_id: THREAD, root_id: ROOT, tool_call_id: "toolu_9" },
    });
    expect(await answerGrantRequest(REQUESTER, payload, pad)).toEqual({ granted: true });
    expect(pad.grants).toEqual([
      {
        reference: ref,
        grantee: GRANTEE,
        trace: { threadId: THREAD, rootId: ROOT },
        toolCallId: "toolu_9",
        kind: "on-request",
      },
    ]);
    expect(pad.granted(ref, { account: "ACME", user: "carol" })).toBe("on-request");
  });

  it("grants without labels a request that has none, or has malformed ones", async () => {
    const { pad, ref } = creator();
    await answerGrantRequest(REQUESTER, ask(ref), pad);
    await answerGrantRequest(
      REQUESTER,
      ask(ref, { trace: { thread_id: "not-hex", root_id: ROOT, tool_call_id: "t" } }),
      pad,
    );
    await answerGrantRequest(
      REQUESTER,
      ask(ref, { trace: { thread_id: THREAD, root_id: ROOT, tool_call_id: "" } }),
      pad,
    );
    expect(pad.grants.map((g) => [g.trace, g.toolCallId])).toEqual([
      [undefined, undefined],
      [undefined, undefined],
      [{ threadId: THREAD, rootId: ROOT }, undefined],
    ]);
  });

  it.each([
    ["not JSON", "{"],
    ["not an object", "[1]"],
    ["no reference", JSON.stringify({ grantee: GRANTEE })],
    ["no grantee", JSON.stringify({ reference: "sp-ref:x" })],
    ["a number for the grantee", JSON.stringify({ reference: "sp-ref:x", grantee: 7 })],
  ])("refuses what is not a grant request: %s", async (_what, payload) => {
    const { pad } = creator();
    expect(await answerGrantRequest(REQUESTER, payload, pad)).toEqual({
      granted: false,
      reason: "not a grant request",
    });
    expect(pad.grants).toEqual([]);
  });

  it("refuses a grantee that is not an agent identity", async () => {
    const { pad, ref } = creator();
    expect(
      await answerGrantRequest(
        REQUESTER,
        JSON.stringify({ reference: ref, grantee: "carol" }),
        pad,
      ),
    ).toEqual({ granted: false, reason: "grantee is not an agent identity" });
  });

  it("refuses a reference into another volume, or one that does not decode", async () => {
    const { pad } = creator();
    for (const reference of [makeReference("vol-else", "/x.md", SELF), "sp-ref:garbage"]) {
      expect(await answerGrantRequest(REQUESTER, ask(reference), pad)).toEqual({
        granted: false,
        reason: "the reference does not point into this agent's volume",
      });
    }
    const throwing = Object.assign(new MemoryScratchPad("vol-creator"), {
      owns: (): boolean => {
        throw new Error("decode");
      },
    });
    expect(await answerGrantRequest(REQUESTER, ask("sp-ref:x"), throwing)).toMatchObject({
      reason: "the reference does not point into this agent's volume",
    });
  });

  it("refuses a requester it never granted read on that reference", async () => {
    const { pad } = creator();
    const other = pad.commit("/other.md");
    expect(await answerGrantRequest(REQUESTER, ask(other), pad)).toEqual({
      granted: false,
      reason: "this agent holds no live read grant it made to the requester on that reference",
    });
    expect(pad.grants).toEqual([]);
  });

  it("refuses a requester whose grant has expired", async () => {
    const { pad, ref } = creator();
    pad.now += 601;
    expect(await answerGrantRequest(REQUESTER, ask(ref), pad)).toMatchObject({
      reason: "this agent holds no live read grant it made to the requester on that reference",
    });
  });

  it("refuses a requester whose own grant was made on request", async () => {
    const pad = new MemoryScratchPad("vol-creator", SELF);
    const ref = pad.commit();
    pad.grantRead(ref, { account: "APP", user: "bob" }, undefined, undefined, "on-request");
    expect(await answerGrantRequest(REQUESTER, ask(ref), pad)).toEqual({
      granted: false,
      reason:
        "the requester's own grant was made at another agent's request; " +
        "only an agent this agent handed the reference itself may ask for another",
    });
  });

  it("lets a live first-hand grant stand when a later one was made on request", async () => {
    const { pad, ref } = creator();
    pad.grantRead(ref, { account: "APP", user: "bob" }, undefined, undefined, "on-request");
    expect(await answerGrantRequest(REQUESTER, ask(ref), pad)).toEqual({ granted: true });
  });

  it("refuses a request for the requester itself", async () => {
    const { pad, ref } = creator();
    expect(
      await answerGrantRequest(
        REQUESTER,
        JSON.stringify({ reference: ref, grantee: REQUESTER }),
        pad,
      ),
    ).toEqual({
      granted: false,
      reason: "a grant request is for another agent, not for the requester",
    });
    expect(pad.grants).toEqual([]);
  });

  it("answers a failing grant, or a failing ledger, with a refusal", async () => {
    const { pad, ref } = creator();
    pad.failGrants = "permission_denied";
    expect(await answerGrantRequest(REQUESTER, ask(ref), pad)).toEqual({
      granted: false,
      reason: "the grant could not be made",
    });
    const ledger = Object.assign(creator().pad, {
      granted: (): GrantKind | undefined => {
        throw new Error("ledger");
      },
    });
    expect(await answerGrantRequest(REQUESTER, ask(ref), ledger)).toMatchObject({
      reason: "the grant could not be made",
    });
  });

  it("takes a port whose methods are async", async () => {
    const { pad, ref } = creator();
    const asyncPad = {
      owns: (r: string) => Promise.resolve(pad.owns(r)),
      granted: (r: string, g: Grantee) => Promise.resolve(pad.granted(r, g)),
      grantRead: (r: string, g: Grantee, t: TraceIds | undefined, id?: string, k?: GrantKind) =>
        Promise.resolve(pad.grantRead(r, g, t, id, k)),
    };
    expect(await answerGrantRequest(REQUESTER, ask(ref), asyncPad)).toEqual({ granted: true });
  });
});

describe("the requester's reading of an answer", () => {
  const request = { reference: "sp-ref:x", grantee: GRANTEE };

  it("sends the request, signed, to the creator's grant subject", async () => {
    const stub = stubAgents();
    expect(await requestGrant(stub.agents, SELF, request)).toEqual({ granted: true });
    expect(stub.requests).toEqual([
      { subject: "agents.sp-grant.creator.fabric.r1", payload: encodeGrantRequest(request) },
    ]);
  });

  it("passes a refusal's reason on", async () => {
    const stub = stubAgents();
    stub.answer = '{"granted":false,"reason":"not yours"}';
    expect(await requestGrant(stub.agents, SELF, request)).toEqual({
      granted: false,
      reason: "not yours",
    });
  });

  it.each([
    ['{"granted":false}', "refused without a reason"],
    ['{"granted":"yes"}', "refused without a reason"],
    ["[true]", "refused without a reason"],
    ["null", "refused without a reason"],
  ])("reads %s as a refusal", async (answer, reason) => {
    const stub = stubAgents();
    stub.answer = answer;
    expect(await requestGrant(stub.agents, SELF, request)).toEqual({ granted: false, reason });
  });

  it("reads no answer, or no JSON, as a refusal naming the creator", async () => {
    const stub = stubAgents();
    stub.answer = new Error("timeout");
    expect(await requestGrant(stub.agents, SELF, request)).toEqual({
      granted: false,
      reason: `no answer from ${SELF}: timeout`,
    });
    stub.answer = "";
    const reply = await requestGrant(stub.agents, SELF, request);
    expect(reply.granted).toBe(false);
    expect(reply.granted ? "" : reply.reason).toMatch(
      /^no answer from agents\.prompt\.creator\.fabric\.r1: /,
    );
  });

  it("sends nothing to an address that is not a prompt address", async () => {
    const stub = stubAgents();
    expect(await requestGrant(stub.agents, "agents.status.x.y.z", request)).toEqual({
      granted: false,
      reason: "no answer from agents.status.x.y.z: not a prompt address: agents.status.x.y.z",
    });
    expect(stub.requests).toEqual([]);
  });
});

describe("the creator's endpoint", () => {
  it("is an extra endpoint next to the prompt address, in the agents queue group", () => {
    const endpoint = grantRequestEndpoint({ promptAddress: SELF, scratchPad: creator().pad });
    expect([endpoint.name, endpoint.subject, endpoint.queue, endpoint.metadata]).toEqual([
      "sp-grant",
      "agents.sp-grant.creator.fabric.r1",
      "agents",
      undefined,
    ]);
  });
});
