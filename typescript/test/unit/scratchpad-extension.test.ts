// The extension's hooks, without a server: every branch of the prompt
// rewrite, the discovery field, the reply look, and what the agent is
// taken to have been given. `python/tests/test_scratchpad_extension.py` is
// the twin.

import { describe, expect, it } from "vitest";
import type { SenderInfo } from "@synadia-ai/agents";
import {
  bindActiveTrace,
  scratchPadExtension,
  type ScratchPadExtension,
  type TraceScope,
} from "../../src/index.js";
import {
  makeReference,
  MemoryScratchPad,
  promptContext,
  replyContext,
  stubAgent,
  stubAgents,
  type StubAgents,
} from "../support/scratchpad.js";

const SELF = "agents.prompt.caller.fabric.c1";
const CREATOR = "agents.prompt.creator.fabric.r1";
const TARGET_ID = "ACME.carol";
const CREATOR_ID = "ACME.alice";
const SERVED: TraceScope = { threadId: "a".repeat(32), rootId: "b".repeat(32), turnCountHint: 0 };

const target = stubAgent({ address: "agents.prompt.target.fabric.t1", identity: TARGET_ID });
const plain = stubAgent({
  address: "agents.prompt.plain.fabric.p1",
  identity: TARGET_ID,
  readsReferences: false,
});
const creator = stubAgent({ address: CREATOR, identity: CREATOR_ID });

interface Setup {
  readonly ext: ScratchPadExtension;
  readonly pad: MemoryScratchPad;
  readonly stub: StubAgents;
  /** A reference of this agent's own, remembered as committed. */
  readonly own: string;
  /** A reference the creator made, remembered as received. */
  readonly theirs: string;
}

function setup(): Setup {
  const pad = new MemoryScratchPad("vol-self", SELF);
  const stub = stubAgents([target, plain, creator]);
  const ext = scratchPadExtension({ scratchPad: pad, agents: stub.agents });
  const own = pad.commit("/own.md");
  const theirs = makeReference("vol-creator", "/findings.md", CREATOR);
  ext.remember(own);
  ext.remember(`here you go: ${theirs}`);
  return { ext, pad, stub, own, theirs };
}

const served = <T>(fn: () => T): T => bindActiveTrace(SERVED, fn);

describe("the prompt rewrite", () => {
  it("leaves a prompt without references alone", async () => {
    const { ext, pad, stub } = setup();
    expect(await ext.beforePrompt(promptContext(target, "just words"))).toBeUndefined();
    expect(pad.grants).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it("refuses a token the agent was not given, before anything is granted or asked", async () => {
    const { ext, pad, stub, own } = setup();
    const madeUp = makeReference("vol-self", "/other.md", SELF);
    const rewrite = await ext.beforePrompt(promptContext(target, `${own} and ${madeUp}`));
    expect(rewrite).toEqual({
      error:
        `the prompt was not sent: 1 of its ScratchPad references (${madeUp.slice(0, 24)}…) ` +
        "is not one you were given. Copy each reference exactly as you received it, the whole token, or leave it out.",
    });
    expect(pad.grants).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it("refuses a token with one character wrong", async () => {
    const { ext, own } = setup();
    const typo = own.slice(0, -1) + (own.endsWith("A") ? "B" : "A");
    const rewrite = await ext.beforePrompt(promptContext(target, `see ${typo}`));
    expect(rewrite && "error" in rewrite ? rewrite.error : "").toMatch(/not one you were given/);
  });

  it("takes every reference out for a target that reads none, and grants nothing", async () => {
    const { ext, pad, stub, own, theirs } = setup();
    const rewrite = await ext.beforePrompt(
      promptContext(plain, `Summarise ${own}\nand ${theirs} and ${own}.`),
    );
    expect(rewrite).toEqual({
      prompt: "Summarise\nand  and .",
      fields: {
        references_removed: 3,
        note:
          `"${plain.promptSubject}" does not read ScratchPad references: 3 reference(s) were removed ` +
          "from your prompt, it got only the text, and nothing was granted",
      },
    });
    expect(pad.grants).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it("removes even a token it was not given for such a target, as the reference agents do", async () => {
    const { ext } = setup();
    const madeUp = makeReference("vol-x", "/x.md");
    const rewrite = await ext.beforePrompt(promptContext(plain, `hi ${madeUp}`));
    expect(rewrite).toMatchObject({ prompt: "hi", fields: { references_removed: 1 } });
  });

  it("refuses a prompt that was nothing but references for such a target", async () => {
    const { ext, own } = setup();
    expect(await ext.beforePrompt(promptContext(plain, `  ${own}  `))).toEqual({
      error:
        `the prompt was not sent: "${plain.promptSubject}" does not read ScratchPad references ` +
        "(discover_agents: reads_scratchpad_references is false), and the prompt held nothing but references; " +
        "put the content they point at into the prompt itself",
    });
  });

  it("refuses a target whose identity did not verify", async () => {
    const { ext, pad, own } = setup();
    for (const unverified of [
      stubAgent({ address: "agents.prompt.u.fabric.u1", identity: TARGET_ID, verified: false }),
      stubAgent({ address: "agents.prompt.u.fabric.u2" }),
    ]) {
      expect(await ext.beforePrompt(promptContext(unverified, own))).toEqual({
        error:
          `cannot hand a ScratchPad reference to "${unverified.promptSubject}": its identity is not verified, ` +
          "so no read grant can be issued; put the content in the prompt instead",
      });
    }
    expect(pad.grants).toEqual([]);
  });

  it("grants the target read on its own content, first-hand, under the served prompt and the tool call", async () => {
    const { ext, pad, stub, own } = setup();
    const rewrite = await served(() => ext.beforePrompt(promptContext(target, `read ${own}`)));
    expect(rewrite).toBeUndefined();
    expect(pad.grants).toEqual([
      {
        reference: own,
        grantee: TARGET_ID,
        trace: { threadId: SERVED.threadId, rootId: SERVED.rootId },
        toolCallId: "toolu_1",
        kind: "first-hand",
      },
    ]);
    expect(stub.requests).toEqual([]);
  });

  it("grants once for a reference that appears twice", async () => {
    const { ext, pad, own } = setup();
    await ext.beforePrompt(promptContext(target, `${own} and again ${own}`));
    expect(pad.grants).toHaveLength(1);
  });

  it("grants without labels outside a served prompt, and without a tool-call ID it was not given", async () => {
    const { ext, pad, own } = setup();
    await ext.beforePrompt(promptContext(target, own, null));
    expect(pad.grants[0]).toMatchObject({ trace: undefined, toolCallId: undefined });
  });

  it("drops a tool-call ID the edge record would drop", async () => {
    const { ext, pad, own } = setup();
    await served(() => ext.beforePrompt(promptContext(target, own, "x".repeat(257))));
    expect(pad.grants[0]?.toolCallId).toBeUndefined();
  });

  it("refuses the prompt when its own grant fails", async () => {
    const { ext, pad, own } = setup();
    pad.failGrants = "permission_denied";
    expect(await ext.beforePrompt(promptContext(target, `read ${own}`))).toEqual({
      error: `could not grant "${target.promptSubject}" read on ${own.slice(0, 32)}…: permission_denied; the prompt was not sent`,
    });
  });

  it("asks the creator for another agent's content, with the served prompt's labels, and sends it granted", async () => {
    const { ext, pad, stub, theirs } = setup();
    const rewrite = await served(() => ext.beforePrompt(promptContext(target, `use ${theirs}`)));
    expect(rewrite).toBeUndefined();
    expect(pad.grants).toEqual([]);
    expect(stub.requests).toEqual([
      {
        subject: "agents.sp-grant.creator.fabric.r1",
        payload:
          `{"reference":"${theirs}","grantee":"${TARGET_ID}","trace":{"thread_id":"${SERVED.threadId}",` +
          `"root_id":"${SERVED.rootId}","tool_call_id":"toolu_1"}}`,
      },
    ]);
  });

  it("asks without labels outside a served prompt", async () => {
    const { ext, stub, theirs } = setup();
    await ext.beforePrompt(promptContext(target, `use ${theirs}`));
    expect(stub.requests[0]?.payload).toBe(`{"reference":"${theirs}","grantee":"${TARGET_ID}"}`);
  });

  it("takes out a reference its creator refuses, sends the rest, and says why", async () => {
    const { ext, stub, own, theirs } = setup();
    stub.answer = '{"granted":false,"reason":"not yours to pass on"}';
    const rewrite = await ext.beforePrompt(promptContext(target, `use ${theirs} and ${own}`));
    const address = target.promptSubject;
    expect(rewrite).toEqual({
      prompt: `use  and ${own}`,
      fields: {
        references_removed: 1,
        note:
          `1 reference(s) were removed from your prompt, and "${address}" got only the text: ` +
          `you did not create that content, and its creator did not grant "${address}" read (not yours to pass on). ` +
          "If it needs the content, put the content itself in a prompt",
      },
    });
  });

  it("counts every occurrence of a refused reference it removes", async () => {
    const { ext, stub, theirs } = setup();
    stub.answer = '{"granted":false,"reason":"no"}';
    const rewrite = await ext.beforePrompt(promptContext(target, `a ${theirs} b ${theirs}`));
    expect(stub.requests).toHaveLength(1);
    expect(rewrite).toMatchObject({ prompt: "a  b", fields: { references_removed: 2 } });
  });

  it("takes out a reference whose creator does not answer", async () => {
    const { ext, stub, theirs } = setup();
    stub.answer = new Error("no responders available for request");
    const rewrite = await ext.beforePrompt(promptContext(target, `use ${theirs} please`));
    expect(rewrite).toMatchObject({ prompt: "use  please", fields: { references_removed: 1 } });
    expect(rewrite && "fields" in rewrite ? rewrite.fields?.["note"] : "").toContain(
      `(no answer from ${CREATOR}: no responders available for request)`,
    );
  });

  it("takes out a reference whose creator is not on the fabric, or not verified, without asking", async () => {
    for (const discovered of [
      [target],
      [target, stubAgent({ address: CREATOR, identity: CREATOR_ID, verified: false })],
    ]) {
      const { ext, stub, theirs } = setup();
      stub.discovered = discovered;
      const rewrite = await ext.beforePrompt(promptContext(target, `use ${theirs} please`));
      expect(rewrite && "fields" in rewrite ? rewrite.fields?.["note"] : "").toContain(
        `(its creator, ${CREATOR}, is not on the fabric with a verified identity)`,
      );
      expect(stub.requests).toEqual([]);
    }
  });

  it("takes out a reference that names no creator, without asking", async () => {
    const { ext, stub } = setup();
    const anonymous = makeReference("vol-else", "/x.md");
    ext.remember(anonymous);
    const rewrite = await ext.beforePrompt(promptContext(target, `use ${anonymous} please`));
    expect(rewrite && "fields" in rewrite ? rewrite.fields?.["note"] : "").toContain(
      "(the reference does not name its creator)",
    );
    expect(stub.requests).toEqual([]);
  });

  it("sends a creator's reference to the creator itself without asking", async () => {
    const { ext, stub, theirs } = setup();
    expect(await ext.beforePrompt(promptContext(creator, `revise ${theirs}`))).toBeUndefined();
    expect(stub.requests).toEqual([]);
  });

  it("refuses a prompt that was nothing but refused references", async () => {
    const { ext, stub, theirs } = setup();
    stub.answer = '{"granted":false,"reason":"no"}';
    expect(await ext.beforePrompt(promptContext(target, theirs))).toEqual({
      error:
        `the prompt was not sent: it held nothing but references, and their creator did not grant ` +
        `"${target.promptSubject}" read (no); put the content they point at into the prompt itself`,
    });
  });

  it("finds a creator it has not seen through a discovery of its own, once", async () => {
    const { ext, stub, theirs } = setup();
    let discoveries = 0;
    const discover = stub.agents.discover.bind(stub.agents);
    (stub.agents as { discover: typeof discover }).discover = (...args) => {
      discoveries += 1;
      return discover(...args);
    };
    await ext.beforePrompt(promptContext(target, theirs));
    await ext.beforePrompt(promptContext(target, theirs));
    expect(discoveries).toBe(1);
    expect(stub.requests).toHaveLength(2);
  });
});

describe("the discovery field", () => {
  it("says whether the agent reads references", () => {
    const { ext } = setup();
    expect(ext.discoveryFields(target)).toEqual({ reads_scratchpad_references: true });
    expect(ext.discoveryFields(plain)).toEqual({ reads_scratchpad_references: false });
  });

  it("remembers the handle, so a creator it listed is asked without another discovery", async () => {
    const { ext, stub, theirs } = setup();
    ext.discoveryFields(creator);
    stub.discovered = [];
    await ext.beforePrompt(promptContext(target, theirs));
    expect(stub.requests).toHaveLength(1);
  });
});

describe("what the agent was given", () => {
  it("includes the references in a reply and in a question", async () => {
    const { ext, stub } = setup();
    const inReply = makeReference("vol-creator", "/r.md", CREATOR);
    const inQuestion = makeReference("vol-creator", "/q.md", CREATOR);
    expect(ext.afterReply(replyContext(creator, "reply", `done: ${inReply}`))).toBeUndefined();
    ext.afterReply(replyContext(creator, "question", `which one? ${inQuestion}`));
    expect(await ext.beforePrompt(promptContext(target, `${inReply} ${inQuestion}`))).toBe(
      undefined,
    );
    expect(stub.requests).toHaveLength(2);
  });

  it("includes the references in the prompts the agent serves", async () => {
    const { ext, stub } = setup();
    const handed = makeReference("vol-creator", "/h.md", CREATOR);
    let ran = 0;
    await ext.requestInterceptor.aroundRequest(
      {
        envelope: { prompt: `work from ${handed}`, extras: {} },
        sender: undefined,
        subject: SELF,
        headers: undefined,
      },
      () => {
        ran += 1;
        return Promise.resolve();
      },
    );
    expect(ran).toBe(1);
    expect(await ext.beforePrompt(promptContext(target, handed))).toBeUndefined();
    expect(stub.requests).toHaveLength(1);
  });
});

describe("the reply side", () => {
  const verified = { trust: "verified", id: "APP.bob" } as unknown as SenderInfo;
  const claimed = { trust: "claimed", claim: { account: "APP", user: "bob" } } as SenderInfo;

  it("grants a verified caller read on its own reference, first-hand, and remembers it", async () => {
    const pad = new MemoryScratchPad("vol-self", SELF);
    const ext = scratchPadExtension({ scratchPad: pad, agents: stubAgents().agents });
    const ref = pad.commit("/reply.md");
    expect(await served(() => ext.grantCaller(ref, verified))).toBe(true);
    expect(pad.grants).toEqual([
      {
        reference: ref,
        grantee: "APP.bob",
        trace: { threadId: SERVED.threadId, rootId: SERVED.rootId },
        toolCallId: undefined,
        kind: "first-hand",
      },
    ]);
    expect(pad.granted(ref, { account: "APP", user: "bob" })).toBe("first-hand");
    expect(await ext.beforePrompt(promptContext(target, ref))).toBeUndefined();
  });

  it("grants nothing to a caller that did not verify, but still remembers the reference", async () => {
    const pad = new MemoryScratchPad("vol-self", SELF);
    const ext = scratchPadExtension({ scratchPad: pad, agents: stubAgents().agents });
    const ref = pad.commit("/reply.md");
    expect(await ext.grantCaller(ref, claimed)).toBe(false);
    expect(await ext.grantCaller(ref, undefined)).toBe(false);
    expect(pad.grants).toEqual([]);
    expect(await ext.beforePrompt(promptContext(target, ref))).toBeUndefined();
    expect(pad.grants).toHaveLength(1);
  });

  it("refuses a reference that is not the agent's own", async () => {
    const pad = new MemoryScratchPad("vol-self", SELF);
    const ext = scratchPadExtension({ scratchPad: pad, agents: stubAgents().agents });
    await expect(
      ext.grantCaller(makeReference("vol-else", "/x.md", CREATOR), verified),
    ).rejects.toThrow(/another agent's volume/);
    expect(pad.grants).toEqual([]);
  });

  it("lets a failing grant through to the agent", async () => {
    const pad = new MemoryScratchPad("vol-self", SELF);
    pad.failGrants = "permission_denied";
    const ext = scratchPadExtension({ scratchPad: pad, agents: stubAgents().agents });
    await expect(ext.grantCaller(pad.commit(), verified)).rejects.toThrow("permission_denied");
  });
});
