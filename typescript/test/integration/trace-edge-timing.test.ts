import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection } from "@nats-io/nats-core";
import type { AgentService } from "@synadia-ai/agent-service";
import {
  parseSenderHeader,
  PayloadTooLargeError,
  readSenderHeaderValue,
  signerFromSeed,
  type PromptInterceptor,
  type SenderSigner,
} from "@synadia-ai/agents";
import { fabricTracing, traceRecordCounts } from "../../src/index.js";
import {
  findNatsServerBinary,
  identityFixture,
  NatsServerProcess,
} from "../harness/nats-server.js";
import {
  ALICE,
  caller,
  capture,
  dec,
  drain,
  enc,
  handleOf,
  host,
  parse,
  sleep,
} from "../support/fixtures.js";

const bin = await findNatsServerBinary();

/** alice's signer, failing whenever it is asked to sign for `subject`. */
function failingFor(subject: string): SenderSigner {
  const real = signerFromSeed(ALICE.seed);
  const marker = `\n${subject}\n`;
  return {
    publicKey: real.publicKey,
    sign(data) {
      if (dec.decode(data).includes(marker)) throw new Error("signer unavailable");
      return real.sign(data);
    },
  };
}

/**
 * An edge record is a claim that a prompt went out. It must not outrun
 * the prompt, and it must not exist at all for a prompt that never goes
 * out — one whose stream is never iterated, or that validation rejects.
 * The prompt interceptor publishes it in the SDK's second phase, after the
 * prompt is signed and its size checked, immediately before the publish.
 */
describe.skipIf(!bin)("edge record timing", () => {
  const server = new NatsServerProcess();
  let nc: NatsConnection;
  let observer: NatsConnection;
  let svc: AgentService;

  beforeAll(async () => {
    await server.start({ configPath: identityFixture("nkey-noaccounts.conf") });
    const opts = {
      servers: server.url,
      authenticator: nkeyAuthenticator(enc.encode(ALICE.seed)),
      reconnect: false,
    };
    nc = await connect(opts);
    observer = await connect(opts);
    ({ svc } = await host(nc, { agent: "hunt", maxPayload: "1KB" }));
  });
  afterAll(async () => {
    await svc.stop();
    await observer.close();
    await nc.close();
    await server.stop();
  });

  /** A traced client signing with `signer`; `null` for none. */
  function traced(signer: SenderSigner | null = signerFromSeed(ALICE.seed)) {
    return caller(nc, {
      ...(signer ? { signer } : {}),
      interceptors: [fabricTracing().promptInterceptor],
    });
  }

  it("precedes the prompt on the wire", async () => {
    const order: string[] = [];
    const edges = observer.subscribe("TRACE.edges");
    const prompts = observer.subscribe(svc.subject.prompt);
    void (async () => {
      for await (const _m of edges) order.push("edge");
    })();
    void (async () => {
      for await (const _m of prompts) order.push("prompt");
    })();
    await observer.flush();

    const agents = traced();
    await drain(await (await handleOf(agents, svc)).prompt("hi"));
    await sleep(300);
    edges.unsubscribe();
    prompts.unsubscribe();
    await agents.close();
    expect(order).toEqual(["edge", "prompt"]);
  });

  it("carries one id: record_id, Nats-Msg-Id and the signed nonce agree", async () => {
    // A reader de-duplicates on (signing user, record_id); a stream on
    // Nats-Msg-Id; the signature binds the nonce. All three must be the
    // same value or the record is counted differently by each.
    const edges = capture(observer, "TRACE.edges");
    await observer.flush();
    const agents = traced();
    await drain(await (await handleOf(agents, svc)).prompt("hi"));
    await sleep(300);
    edges.stop();
    await agents.close();

    expect(edges.msgs).toHaveLength(1);
    const record = parse(edges.msgs[0]!);
    const sender = parseSenderHeader(readSenderHeaderValue(edges.msgs[0]!.headers) ?? "");
    expect(sender?.nonce).toBe(record["record_id"]);
    expect(edges.msgs[0]!.headers?.get("Nats-Msg-Id")).toBe(record["record_id"]);
  });

  it("is stamped with the time the prompt went out, not the time it was planned", async () => {
    const edges = capture(observer, "TRACE.edges");
    await observer.flush();
    const agents = traced();
    const s = await (await handleOf(agents, svc)).prompt("hi"); // planned now …
    await sleep(1100); // … a whole second passes …
    const sentAt = Math.floor(Date.now() / 1000);
    await drain(s); // … sent now
    await sleep(300);
    edges.stop();
    await agents.close();
    expect(edges.msgs).toHaveLength(1);
    expect(parse(edges.msgs[0]!)["ts"]).toBeGreaterThanOrEqual(sentAt);
  });

  it("is not published when the caller never iterates the stream", async () => {
    const edges = capture(observer, "TRACE.edges");
    await observer.flush();
    const agents = traced();
    await (await handleOf(agents, svc)).prompt("hi"); // returned, never iterated
    await sleep(300);
    edges.stop();
    await agents.close();
    expect(edges.msgs).toHaveLength(0);
  });

  it("is not published when the prompt's header cannot be signed at publish time", async () => {
    // The prompt's `Agent-Sender` header is signed at publish time,
    // immediately before the request goes out, and signing can fail.
    // Fail it for the prompt subject only — the edge record's own header
    // (another subject) is left alone, so the edge WOULD go out if it
    // were published first.
    const edges = capture(observer, "TRACE.edges");
    const prompts = capture(observer, svc.subject.prompt);
    await observer.flush();
    const agents = traced(failingFor(svc.subject.prompt));
    const before = traceRecordCounts();
    const s = await (await handleOf(agents, svc)).prompt("hi");
    await expect(drain(s)).rejects.toThrow("signer unavailable");
    await sleep(300);
    edges.stop();
    prompts.stop();
    await agents.close();
    expect(edges.msgs).toHaveLength(0);
    expect(prompts.msgs).toHaveLength(0);
    expect(traceRecordCounts()).toEqual(before);
  });

  it("is not published when validation rejects the prompt", async () => {
    const edges = capture(observer, "TRACE.edges");
    await observer.flush();
    const agents = traced();
    const handle = await handleOf(agents, svc);
    // Text-only prompts validate synchronously (§5.4), so the throw is not
    // a rejected promise.
    expect(() => handle.prompt("x".repeat(10_000))).toThrow(PayloadTooLargeError);
    await sleep(300);
    edges.stop();
    await agents.close();
    expect(edges.msgs).toHaveLength(0);
  });

  it("is not published when the prompt fails the size check at publish time", async () => {
    // 1 KB: the prompt alone fits with room for its header; with another
    // interceptor's bulky field it no longer does, which only the check the
    // SDK makes at publish time — after the first phase, before the second
    // — can see. The edge was planned in phase one and is never published.
    const bulky: PromptInterceptor = {
      beforePrompt: () => ({ fields: { x_bulk: "b".repeat(2_000) } }),
    };
    const agents = caller(nc, {
      signed: true,
      interceptors: [fabricTracing().promptInterceptor, bulky],
    });
    const edges = capture(observer, "TRACE.edges");
    const prompts = capture(observer, svc.subject.prompt);
    await observer.flush();
    const before = traceRecordCounts();
    const s = await (await handleOf(agents, svc)).prompt("hi");
    await expect(drain(s)).rejects.toThrow(PayloadTooLargeError);
    await sleep(300);
    edges.stop();
    prompts.stop();
    await agents.close();
    expect(edges.msgs).toHaveLength(0);
    expect(prompts.msgs).toHaveLength(0);
    expect(traceRecordCounts()).toEqual(before);
  });

  it("owes nothing when its own two fields push the prompt over the limit", async () => {
    // Unsigned, so `prompt()` checks the exact size up front: the largest
    // prompt it accepts fits without the lineage fields and not with them.
    // Phase two never runs, so not even the unsigned drop is counted.
    const agents = traced(null);
    const handle = await handleOf(agents, svc);
    let size = 1024;
    for (; size > 0; size -= 1) {
      try {
        await handle.prompt("x".repeat(size)); // never iterated: nothing is sent
        break;
      } catch (err) {
        if (!(err instanceof PayloadTooLargeError)) throw err;
      }
    }
    const prompts = capture(observer, svc.subject.prompt);
    await observer.flush();
    const before = traceRecordCounts();
    await expect(drain(await handle.prompt("x".repeat(size)))).rejects.toThrow(
      PayloadTooLargeError,
    );
    await sleep(300);
    prompts.stop();
    await agents.close();
    expect(prompts.msgs).toHaveLength(0);
    expect(traceRecordCounts()).toEqual(before);
  });
});
