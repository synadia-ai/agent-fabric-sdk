import { describe, expect, it } from "vitest";
import { RequestRejectedError, type RequestInterceptorContext } from "@synadia-ai/agent-service";
import { decodeEnvelope } from "@synadia-ai/agents";
import { activeTrace, fabricTracing, isThreadId, type TraceScope } from "../../src/index.js";

const enc = new TextEncoder();
const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);

/**
 * Run the host interceptor over a raw envelope, decoded by the protocol
 * SDK as `AgentService` decodes it: the scope the handler would run in, or
 * what the interceptor refused the request with.
 */
async function hostScope(body: string): Promise<TraceScope | undefined> {
  const { requestInterceptor } = fabricTracing();
  const ctx: RequestInterceptorContext = {
    envelope: decodeEnvelope(enc.encode(body)),
    sender: undefined,
    subject: "agents.prompt.a.o.s",
    headers: undefined,
  };
  let seen: TraceScope | undefined;
  await requestInterceptor.aroundRequest(ctx, () => {
    seen = activeTrace();
    return Promise.resolve();
  });
  return seen;
}

async function refusal(body: string): Promise<RequestRejectedError> {
  const err: unknown = await hostScope(body).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RequestRejectedError);
  return err as RequestRejectedError;
}

/**
 * Lineage is the fabric's addition to the envelope — two §5.6 fields the
 * protocol SDK passes through as extras. Both packages read it the same
 * way: a wrongly typed value is a malformed envelope, not a field to
 * quietly ignore — dropping it makes the receiver mint a fresh root and
 * file the execution under a tree of its own.
 */
describe("the host reads the envelope's lineage", () => {
  it("reads both fields", async () => {
    const scope = await hostScope(`{"prompt":"x","thread_id":"${THREAD}","root_id":"${ROOT}"}`);
    expect(scope).toEqual({ threadId: THREAD, rootId: ROOT, turnCountHint: 0 });
  });

  it.each([
    ["absent", '{"prompt":"x"}'],
    ["null", '{"prompt":"x","thread_id":null,"root_id":null}'],
    // An empty id names nothing, so the receiver must mint rather than
    // adopt "" and file every child under it. Python reads the same wire
    // the same way.
    ["an empty string", '{"prompt":"x","thread_id":"","root_id":""}'],
  ])("treats %s as no lineage, and mints a root", async (_label, body) => {
    const scope = await hostScope(body);
    expect(scope).toBeDefined();
    expect(isThreadId(scope!.threadId)).toBe(true);
    expect(scope!.rootId).toBe(scope!.threadId);
    expect(scope!.threadId).not.toBe(THREAD);
  });

  /**
   * The pair travels together: a caller that traces sends both, one that
   * does not sends neither. Exactly one names a broken or hand-written
   * caller, and adopting the lone field would file the execution under a
   * tree the caller never named — so it is rejected like a wrongly shaped
   * id, in both packages.
   */
  it.each([
    ["thread_id alone", `{"prompt":"x","thread_id":"${THREAD}"}`],
    ["root_id alone", `{"prompt":"x","root_id":"${ROOT}"}`],
    ["thread_id with an empty root_id", `{"prompt":"x","thread_id":"${THREAD}","root_id":""}`],
    ["root_id with a null thread_id", `{"prompt":"x","thread_id":null,"root_id":"${ROOT}"}`],
  ])("rejects %s as a half pair with 400", async (_label, body) => {
    const err = await refusal(body);
    expect(err.code).toBe(400);
    expect(err.description).toBe("envelope `thread_id` and `root_id` must be given together");
  });

  it.each([
    ["a number", `{"prompt":"x","thread_id":123,"root_id":"${ROOT}"}`],
    ["an object", `{"prompt":"x","thread_id":{},"root_id":"${ROOT}"}`],
    ["an array", `{"prompt":"x","thread_id":"${THREAD}","root_id":[]}`],
    ["a boolean", `{"prompt":"x","thread_id":"${THREAD}","root_id":true}`],
    ["a lone number", '{"prompt":"x","thread_id":123}'],
  ])("rejects %s with 400", async (_label, body) => {
    const err = await refusal(body);
    expect(err.code).toBe(400);
    expect(err.description).toMatch(/must be a string/);
  });

  /**
   * An adopted id is stamped verbatim on the agent's model requests as a
   * header value, so the receiver bounds it to the shape the packages mint
   * — otherwise a caller can inject a CRLF, or a megabyte, into headers
   * the harness sends to a third party.
   */
  it.each([
    ["uppercase hex", "A".repeat(32)],
    ["one character short", "a".repeat(31)],
    ["one character long", "a".repeat(33)],
    ["non-hex characters", "g".repeat(32)],
    ["a header injection", `${"a".repeat(30)}\r\nX-Injected: yes`],
    ["surrounding whitespace", ` ${"a".repeat(30)} `],
    ["a megabyte of garbage", "a".repeat(1 << 20)],
  ])("rejects %s as malformed with 400", async (_label, id) => {
    for (const body of [
      { prompt: "x", thread_id: id, root_id: ROOT },
      { prompt: "x", thread_id: THREAD, root_id: id },
      { prompt: "x", thread_id: id },
      { prompt: "x", root_id: id },
    ]) {
      const err = await refusal(JSON.stringify(body));
      expect(err.code).toBe(400);
      expect(err.description).toMatch(/must be 32 lowercase hex characters/);
    }
  });

  it("accepts exactly what the caller mints", async () => {
    const { promptInterceptor } = fabricTracing({ edgeSubject: null });
    const extras = await promptInterceptor.beforePrompt({
      context: {},
    } as unknown as Parameters<typeof promptInterceptor.beforePrompt>[0]);
    const fields = extras?.fields ?? {};
    const scope = await hostScope(JSON.stringify({ prompt: "x", ...fields }));
    expect(scope).toEqual({
      threadId: fields["thread_id"],
      rootId: fields["root_id"],
      turnCountHint: 0,
    });
  });

  it("leaves the handler's result and errors to the SDK", async () => {
    const { requestInterceptor } = fabricTracing();
    const ctx: RequestInterceptorContext = {
      envelope: decodeEnvelope(enc.encode('{"prompt":"x"}')),
      sender: undefined,
      subject: "s",
      headers: undefined,
    };
    const boom = new Error("handler failed");
    await expect(requestInterceptor.aroundRequest(ctx, () => Promise.reject(boom))).rejects.toBe(
      boom,
    );
    expect(activeTrace()).toBeUndefined();
  });
});
