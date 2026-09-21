import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import { activeTrace, fabricTracing, traceHeaders } from "../../src/index.js";
import { findNatsServerBinary, NatsServerProcess } from "../harness/nats-server.js";
import { caller, drain, handleOf, host, sleep } from "../support/fixtures.js";

const bin = await findNatsServerBinary();

/**
 * One execution's trace must stay its own. The ambient scope is bound per
 * request and must not survive it, be shared with a concurrent request, or
 * carry its turn count into the next one. Work spawned inside a handler is
 * the deliberate exception: a tool running as its own task belongs to the
 * same execution and counts against it.
 */
describe.skipIf(!bin)("trace scope isolation", () => {
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

  async function serve(
    agent: string,
    onPrompt: () => Promise<void>,
    prompts: (prompt: () => Promise<void>) => Promise<void>,
  ): Promise<void> {
    const { svc } = await host(nc, {
      agent,
      interceptors: [fabricTracing().requestInterceptor],
      onPrompt: async (_env, reply) => {
        await onPrompt();
        await reply("ok");
      },
    });
    const client = caller(nc);
    const handle = await handleOf(client, svc);
    await prompts(async () => drain(await handle.prompt("hi")));
    await sleep(100);
    await svc.stop();
    await client.close();
  }

  it("does not leak the scope between requests", async () => {
    const seen: string[] = [];
    await serve(
      "iso",
      async () => {
        const scope = activeTrace();
        expect(scope).toBeDefined();
        seen.push(scope!.threadId);
        await sleep(20); // yield mid-handler
        expect(activeTrace()?.threadId).toBe(scope!.threadId);
      },
      async (prompt) => {
        for (let i = 0; i < 3; i++) await prompt();
      },
    );
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(activeTrace()).toBeUndefined();
  });

  it("counts turns per request", async () => {
    const counts: number[] = [];
    await serve(
      "iso2",
      async () => {
        traceHeaders();
        traceHeaders();
        counts.push(activeTrace()!.turnCountHint);
        await Promise.resolve();
      },
      async (prompt) => {
        for (let i = 0; i < 3; i++) await prompt();
      },
    );
    expect(counts).toEqual([2, 2, 2]);
  });

  it("does not share a scope between concurrent requests", async () => {
    const pairs: Array<[string, string]> = [];
    await serve(
      "conc",
      async () => {
        const before = activeTrace()!.threadId;
        await sleep(150); // overlap with the other requests
        pairs.push([before, activeTrace()!.threadId]);
      },
      async (prompt) => {
        await Promise.all([prompt(), prompt(), prompt()]);
      },
    );
    expect(pairs).toHaveLength(3);
    for (const [before, after] of pairs) expect(after).toBe(before);
    expect(new Set(pairs.map((p) => p[0])).size).toBe(3);
  });

  it("shares the scope with work spawned inside the handler", async () => {
    const seen: Record<string, unknown> = {};
    await serve(
      "spawn",
      async () => {
        traceHeaders();
        // A tool running as its own task must count against the same
        // execution and see the same thread.
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            seen["headers"] = traceHeaders();
            seen["thread"] = activeTrace()?.threadId;
            resolve();
          }, 5),
        );
        seen["count"] = activeTrace()!.turnCountHint;
        seen["outerThread"] = activeTrace()!.threadId;
      },
      async (prompt) => prompt(),
    );
    expect(seen["thread"]).toBe(seen["outerThread"]);
    expect(seen["count"]).toBe(2);
  });
});
