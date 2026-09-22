// The references' vocabulary and the grant request's wire shapes, without
// a server. `python/tests/test_scratchpad_vocabulary.py` is the twin.

import { describe, expect, it } from "vitest";
import {
  encodeGrantReply,
  encodeGrantRequest,
  findReferences,
  granteeFromIdentity,
  grantSubject,
  readsReferences,
  READS_REFERENCES_KEY,
  referenceCreator,
  removeReferences,
} from "../../src/index.js";
import { grantReplySchemaErrors, grantRequestSchemaErrors } from "../support/fixtures.js";
import { makeReference } from "../support/scratchpad.js";

const A = makeReference("vol-a", "/a.md", "agents.prompt.writer.acme.w1");
const B = makeReference("vol-b", "/b.md");

describe("findReferences", () => {
  it("finds every token in order, repeats included", () => {
    expect(findReferences(`first ${A}, then ${B} and ${A} again`)).toEqual([A, B, A]);
  });

  it("finds none in plain text", () => {
    expect(findReferences("sp-ref: alone, and sp-ref:")).toEqual([]);
  });

  it("stops a token at the first character outside base64url", () => {
    expect(findReferences("(sp-ref:abc_-9.)")).toEqual(["sp-ref:abc_-9"]);
  });
});

describe("removeReferences", () => {
  it("takes every token out and tidies what that leaves", () => {
    expect(removeReferences(`Read this:  ${A}\n\n\n\nand ${B}   \nthanks`)).toBe(
      "Read this:\n\nand\nthanks",
    );
  });

  it("takes out only the tokens listed, every occurrence of each", () => {
    expect(removeReferences(`${A} ${B} ${A}`, [A])).toBe(B);
  });

  it("leaves nothing of a text that was only references", () => {
    expect(removeReferences(` ${A}\n${B} `)).toBe("");
  });
});

describe("referenceCreator", () => {
  it("reads the creator's prompt address from the token", () => {
    expect(referenceCreator(A)).toBe("agents.prompt.writer.acme.w1");
  });

  it("is undefined for a token that names no creator", () => {
    expect(referenceCreator(B)).toBeUndefined();
  });

  it("is undefined for a token that does not decode", () => {
    expect(referenceCreator("sp-ref:not-json")).toBeUndefined();
    expect(referenceCreator("sp-ref:")).toBeUndefined();
    expect(
      referenceCreator("sp-ref:" + Buffer.from('["creator"]').toString("base64url")),
    ).toBeUndefined();
  });

  it("is undefined for an empty or non-string creator", () => {
    const token = (made: unknown): string =>
      "sp-ref:" + Buffer.from(JSON.stringify(made)).toString("base64url");
    expect(referenceCreator(token({ creator: "" }))).toBeUndefined();
    expect(referenceCreator(token({ creator: 7 }))).toBeUndefined();
  });

  it("is undefined for anything that is not a reference", () => {
    expect(referenceCreator("agents.prompt.writer.acme.w1")).toBeUndefined();
  });
});

describe("readsReferences", () => {
  it("is true only for the key set to the string true", () => {
    expect(READS_REFERENCES_KEY).toBe("scratchpad_refs_ok");
    expect(readsReferences({ scratchpad_refs_ok: "true" })).toBe(true);
    expect(readsReferences({ scratchpad_refs_ok: "True" })).toBe(false);
    expect(readsReferences({ scratchpad_refs_ok: "1" })).toBe(false);
    expect(readsReferences({})).toBe(false);
  });
});

describe("granteeFromIdentity", () => {
  it("splits at the first dot", () => {
    expect(granteeFromIdentity("ACME.alice")).toEqual({ account: "ACME", user: "alice" });
    expect(granteeFromIdentity("$G.u.v")).toEqual({ account: "$G", user: "u.v" });
  });

  it.each(["", "alice", ".alice", "ACME."])("refuses %j", (identity) => {
    expect(() => granteeFromIdentity(identity)).toThrow(/not an agent identity/);
  });
});

describe("grantSubject", () => {
  it("is the prompt address with the verb changed", () => {
    expect(grantSubject("agents.prompt.writer.acme.w1")).toBe("agents.sp-grant.writer.acme.w1");
  });

  it.each(["agents.status.writer.acme.w1", "agents.prompt.", "prompt.writer", ""])(
    "refuses %j",
    (address) => {
      expect(() => grantSubject(address)).toThrow(/not a prompt address/);
    },
  );
});

describe("the grant request on the wire", () => {
  const trace = { thread_id: "a".repeat(32), root_id: "b".repeat(32) };

  it("writes the schema's key order whatever order it was given", () => {
    const bytes = encodeGrantRequest({
      trace: { tool_call_id: "toolu_1", root_id: trace.root_id, thread_id: trace.thread_id },
      grantee: "ACME.carol",
      reference: A,
    });
    expect(bytes).toBe(
      `{"reference":"${A}","grantee":"ACME.carol","trace":{"thread_id":"${trace.thread_id}",` +
        `"root_id":"${trace.root_id}","tool_call_id":"toolu_1"}}`,
    );
    expect(grantRequestSchemaErrors(JSON.parse(bytes))).toEqual([]);
  });

  it("leaves out what it was not given", () => {
    expect(encodeGrantRequest({ reference: A, grantee: "ACME.carol" })).toBe(
      `{"reference":"${A}","grantee":"ACME.carol"}`,
    );
    const bytes = encodeGrantRequest({ reference: A, grantee: "ACME.carol", trace });
    expect(bytes).toBe(
      `{"reference":"${A}","grantee":"ACME.carol","trace":{"thread_id":"${trace.thread_id}","root_id":"${trace.root_id}"}}`,
    );
    expect(grantRequestSchemaErrors(JSON.parse(bytes))).toEqual([]);
  });

  it("writes a grant and a refusal as the reply schema has them", () => {
    expect(encodeGrantReply({ granted: true })).toBe('{"granted":true}');
    expect(encodeGrantReply({ granted: false, reason: "no" })).toBe(
      '{"granted":false,"reason":"no"}',
    );
    for (const reply of ['{"granted":true}', '{"granted":false,"reason":"no"}']) {
      expect(grantReplySchemaErrors(JSON.parse(reply))).toEqual([]);
    }
  });
});
