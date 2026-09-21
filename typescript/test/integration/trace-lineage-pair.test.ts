import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { Msg, NatsConnection } from "@nats-io/nats-core";
import { fabricTracing, isThreadId, traceHeaders } from "../../src/index.js";
import { findNatsServerBinary, NatsServerProcess } from "../harness/nats-server.js";
import { errorCode, host, rawStream } from "../support/fixtures.js";

const bin = await findNatsServerBinary();
const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);

/**
 * The envelope's lineage is a pair, adopted whole or not at all. Neither
 * field present: the host mints a root. Both present and well-formed:
 * adopted verbatim. Exactly one, or either malformed: a malformed envelope
 * — the §9 `400` frame and the terminator, no ack, and the handler never
 * runs — the same treatment as any other wrongly shaped field, and the
 * same as the Python host. Completing a half pair would file the
 * execution under a tree the caller never named.
 */
describe.skipIf(!bin)("the envelope's lineage pair", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  beforeAll(async () => {
    await server.start();
    nc = await connect({ servers: server.url, reconnect: false });
  });
  afterAll(async () => {
    await nc.close();
    await server.stop();
  });

  interface Outcome {
    readonly frames: Msg[];
    /** What the handler was handed, or `undefined` when it never ran. */
    readonly headers: Record<string, string> | undefined;
  }

  async function send(agent: string, body: Record<string, unknown>): Promise<Outcome> {
    let headers: Record<string, string> | undefined;
    const tracing = fabricTracing();
    const { svc } = await host(nc, {
      agent,
      interceptors: [tracing.requestInterceptor],
      onPrompt: async (_env, reply) => {
        headers = traceHeaders();
        await reply("ok");
      },
    });
    try {
      const frames = await rawStream(nc, svc.subject.prompt, JSON.stringify(body));
      return { frames, headers };
    } finally {
      await svc.stop();
    }
  }

  it.each([
    ["thread_id alone", { prompt: "hi", thread_id: THREAD }],
    ["root_id alone", { prompt: "hi", root_id: ROOT }],
  ])("rejects %s with a 400 before the handler runs", async (_label, body) => {
    const { frames, headers } = await send("pair-half", body);
    expect(headers).toBeUndefined();
    expect(errorCode(frames)).toBe("400");
    expect(frames[0]!.headers?.get("Nats-Service-Error")).toBe(
      "envelope `thread_id` and `root_id` must be given together",
    );
    expect(frames).toHaveLength(2); // the error frame and the terminator, no ack
  });

  it.each([
    ["an uppercase thread_id", { prompt: "hi", thread_id: THREAD.toUpperCase(), root_id: ROOT }],
    ["a short root_id", { prompt: "hi", thread_id: THREAD, root_id: ROOT.slice(1) }],
    ["a numeric thread_id", { prompt: "hi", thread_id: 7, root_id: ROOT }],
  ])("rejects %s with a 400 before the handler runs", async (_label, body) => {
    const { frames, headers } = await send("pair-bad", body);
    expect(headers).toBeUndefined();
    expect(errorCode(frames)).toBe("400");
    expect(frames).toHaveLength(2);
  });

  it("adopts a well-formed pair verbatim", async () => {
    const { frames, headers } = await send("pair-full", {
      prompt: "hi",
      thread_id: THREAD,
      root_id: ROOT,
    });
    expect(errorCode(frames)).toBeUndefined();
    expect(headers).toEqual({ "X-Synadia-Thread-ID": THREAD, "X-Synadia-Root-ID": ROOT });
  });

  it("mints a root when neither field is present", async () => {
    const { frames, headers } = await send("pair-none", { prompt: "hi" });
    expect(errorCode(frames)).toBeUndefined();
    expect(headers).toBeDefined();
    const thread = headers!["X-Synadia-Thread-ID"]!;
    const root = headers!["X-Synadia-Root-ID"]!;
    expect(isThreadId(thread)).toBe(true);
    expect(root).toBe(thread);
  });
});
