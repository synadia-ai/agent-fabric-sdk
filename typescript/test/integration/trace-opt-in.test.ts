import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { RequestInterceptor } from "@synadia-ai/agent-service";
import type { PromptInterceptor } from "@synadia-ai/agents";
import { activeTrace, fabricTracing, traceHeaders, type TraceScope } from "../../src/index.js";
import { findNatsServerBinary, NatsServerProcess } from "../harness/nats-server.js";
import { caller, capture, drain, handleOf, host, parse } from "../support/fixtures.js";

const bin = await findNatsServerBinary();

/**
 * Tracing must be entirely opt-in. A host that does not run the fabric's
 * request interceptor behaves exactly as the protocol SDK does alone — in
 * particular it hands the harness no trace headers, which would otherwise
 * be stamped on model requests going to a third party the operator never
 * opted into.
 */
describe.skipIf(!bin)("tracing is opt-in", () => {
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

  async function seenBy(
    agent: string,
    hostSide: ReadonlyArray<RequestInterceptor>,
    callerSide: ReadonlyArray<PromptInterceptor>,
  ): Promise<{
    headers: Record<string, string>;
    scope: TraceScope | undefined;
    sent: Record<string, unknown>;
  }> {
    let headers: Record<string, string> = { sentinel: "never ran" };
    let scope: TraceScope | undefined;
    const { svc } = await host(nc, {
      agent,
      interceptors: hostSide,
      onPrompt: async (_env, reply) => {
        headers = traceHeaders();
        scope = activeTrace();
        await reply("ok");
      },
    });
    const prompts = capture(nc, svc.subject.prompt);
    await nc.flush();
    const client = caller(nc, { interceptors: callerSide });
    await drain(await (await handleOf(client, svc)).prompt("hi"));
    await svc.stop();
    await client.close();
    prompts.stop();
    return { headers, scope, sent: parse(prompts.msgs[0]!) };
  }

  it("hands out no trace headers when nothing opted in", async () => {
    const seen = await seenBy("untraced", [], []);
    expect(seen.headers).toEqual({});
    expect(seen.scope).toBeUndefined();
    expect(seen.sent).toEqual({ prompt: "hi" });
  });

  it("hands out trace headers when the host opted in", async () => {
    const seen = await seenBy("traced", [fabricTracing().requestInterceptor], []);
    expect(Object.keys(seen.headers).sort()).toEqual(["X-Synadia-Root-ID", "X-Synadia-Thread-ID"]);
  });

  /**
   * Before the split, a service that had not opted in still adopted a
   * caller's pair; with the protocol SDK alone the two fields are plain
   * §5.6 extras that nothing reads. A tree that starts upstream continues
   * only through a host that runs the fabric's request interceptor.
   */
  it("a host without the fabric passes a traced caller's pair through unread", async () => {
    const seen = await seenBy(
      "relay",
      [],
      [fabricTracing({ edgeSubject: null }).promptInterceptor],
    );
    expect(Object.keys(seen.sent)).toEqual(["prompt", "thread_id", "root_id"]);
    expect(seen.headers).toEqual({});
    expect(seen.scope).toBeUndefined();
  });
});
