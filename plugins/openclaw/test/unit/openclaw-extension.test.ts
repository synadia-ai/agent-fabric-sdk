// The factory and the extension, driven by a fake of the OpenClaw plugin:
// no server, no OpenClaw. What the plugin does with each hook is the
// plugin's tests' business; here is what the add-on gives it — the served
// pair, the seeded trace scope, the served thread under a tool call, the
// loop guard.

import { describe, expect, it } from "vitest";
import { NatsAgentError } from "@synadia-ai/agents";
import {
  activeTrace,
  DEFAULT_EDGE_SUBJECT,
  EDGE_SUBJECT_VAR,
  LOOP_GUARD_CODE,
  loopGuardDescription,
  traceRecordCounts,
  validHarnessThreadId,
} from "@synadia-ai/agent-fabric";
import defaultExport, {
  fabricExtension,
  createFabricExtension,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
  openClawTraceScope,
  validTraceId,
} from "../../src/index.js";
import {
  extensionContext,
  fakeClient,
  fakeService,
  phaseOne,
  planOf,
  PLUGIN_AGENT_ID,
  recordingLogger,
  serve,
  type Published,
} from "../support/fake-plugin.js";
import { servedSchemaErrors } from "../support/harness.js";

const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);
const CALLER = "ACME.coordinator";
const NO_ENV: NodeJS.ProcessEnv = {};

type Extension = ReturnType<typeof createFabricExtension>;

/** A started extension over a fake client, with what it logged and published. */
async function started(
  overrides: Parameters<typeof extensionContext>[0] = {},
  env: NodeJS.ProcessEnv = NO_ENV,
): Promise<{
  ext: Extension;
  published: Published[];
  lines: ReturnType<typeof recordingLogger>["lines"];
}> {
  const { logger, lines } = recordingLogger();
  const ext = createFabricExtension(extensionContext({ ...overrides, logger }), env);
  const { agents, published } = fakeClient(overrides.senderIdentity !== "off");
  await ext.started!({ agents, service: fakeService() });
  return { ext, published, lines };
}

describe("the factory", () => {
  it("is the default export, and the named one", () => {
    expect(defaultExport).toBe(fabricExtension);
  });

  it("returns the extension of the contract: tracing's hooks, the guard, no tool extensions", () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    expect(ext.name).toBe(EXTENSION_NAME);
    expect(ext.requestInterceptors).toHaveLength(2);
    expect(ext.promptInterceptors).toHaveLength(2);
    expect(typeof ext.heartbeatExtras).toBe("function");
    expect(ext.toolExtensions).toBeUndefined();
    expect(typeof ext.started).toBe("function");
    expect(typeof ext.stopping).toBe("function");
    expect(Object.keys(ext.events!).sort()).toEqual([
      "aroundDispatch",
      "aroundToolCall",
      "promptAccepted",
      "promptEnded",
    ]);
  });

  it("reports the process-wide record counts on the heartbeat", () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const counts = traceRecordCounts();
    expect(ext.heartbeatExtras!()).toEqual({
      records_published: counts.published,
      records_dropped: counts.dropped,
    });
  });

  it("refuses an edge subject that can never be published to", () => {
    expect(() =>
      createFabricExtension(extensionContext({ options: { edgeSubject: "TRACE.>" } }), NO_ENV),
    ).toThrow(NatsAgentError);
  });

  it("logs the definitive address at start, and no warning with identity on", async () => {
    const { lines } = await started();
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
    expect(lines.map((l) => l.message)).toContain(
      `${EXTENSION_NAME}: tracing agents.prompt.oc.team.summarizer, edge and served records on TRACE.edges`,
    );
  });
});

describe("the served pair", () => {
  it("publishes start at promptAccepted and end at promptEnded, in order, with one trace id", async () => {
    const { ext, published } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await prompt.accepted;
    await ext.stopping!();
    // `start` is out before the turn ends.
    expect(published.map((p) => p.record["phase"])).toEqual(["start"]);

    const endedAt = 1_758_000_123_456;
    await prompt.end("ok", endedAt);
    await ext.stopping!();
    expect(published.map((p) => p.record["phase"])).toEqual(["start", "end"]);

    const [start, end] = published.map((p) => p.record);
    const traceId = start!["harness_thread_id"];
    expect(validTraceId(traceId)).toBe(true);
    expect(validHarnessThreadId(traceId)).toBe(true);
    expect(start).toMatchObject({
      version: 1,
      kind: "served",
      agent: PLUGIN_AGENT_ID,
      thread_id: THREAD,
      root_id: ROOT,
      harness: "openclaw",
      harness_thread_id: traceId,
      phase: "start",
    });
    expect(start!["status"]).toBeUndefined();
    expect(end).toMatchObject({
      thread_id: THREAD,
      root_id: ROOT,
      harness: "openclaw",
      harness_thread_id: traceId,
      phase: "end",
      status: "ok",
      ts: Math.floor(endedAt / 1000),
    });
    for (const p of published) {
      expect(servedSchemaErrors(p.record)).toEqual([]);
      expect(p.subject).toBe(DEFAULT_EDGE_SUBJECT);
      expect(p.nonce).toBe(p.record["record_id"]);
    }
  });

  it("stamps start with the arrival", async () => {
    const { ext, published } = await started();
    const before = Math.floor(Date.now() / 1000);
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    const after = Math.floor(Date.now() / 1000);
    await prompt.end("ok", Date.now() + 60_000);
    await ext.stopping!();
    const ts = published[0]!.record["ts"] as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("carries the outcome OpenClaw reports: error when the dispatch failed", async () => {
    const { ext, published } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.dispatched;
    await prompt.end("error");
    await expect(prompt.done).rejects.toThrow("the turn failed");
    await ext.stopping!();
    expect(published.map((p) => [p.record["phase"], p.record["status"]])).toEqual([
      ["start", undefined],
      ["end", "error"],
    ]);
  });

  it("mints a fresh trace id per prompt, a root's included", async () => {
    const { ext, published, lines } = await started();
    const a = serve(ext, { thread_id: THREAD, root_id: ROOT });
    const b = serve(ext, {});
    await a.accepted;
    await b.accepted;
    await a.end();
    await b.end();
    await ext.stopping!();
    const starts = published.filter((p) => p.record["phase"] === "start").map((p) => p.record);
    expect(starts).toHaveLength(2);
    expect(starts[0]!["harness_thread_id"]).not.toBe(starts[1]!["harness_thread_id"]);
    // The prompt without a pair got a minted root; the pair names it.
    expect(starts[1]!["thread_id"]).toBe(starts[1]!["root_id"]);
    expect(starts[1]!["thread_id"]).not.toBe(THREAD);
    // No id was ever refused.
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
  });

  it("publishes on the configured edge subject, and nothing when propagate-only", async () => {
    const custom = await started({}, { [EDGE_SUBJECT_VAR]: "TRACE.staging.edges" });
    const one = serve(custom.ext, { thread_id: THREAD, root_id: ROOT });
    await one.end();
    await custom.ext.stopping!();
    expect(custom.published.map((p) => p.subject)).toEqual([
      "TRACE.staging.edges",
      "TRACE.staging.edges",
    ]);

    const silent = await started({ options: { edgeSubject: null } });
    const two = serve(silent.ext, { thread_id: THREAD, root_id: ROOT });
    await two.dispatched;
    // The turn is still seeded; no pair names it.
    expect(two.inTurn(() => validTraceId(openClawTraceScope()?.getStore()?.traceId))).toBe(true);
    await two.end();
    await silent.ext.stopping!();
    expect(silent.published).toEqual([]);
  });

  it("gives a prompt accepted before started no pair, and still serves it", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.dispatched;
    const { agents, published } = fakeClient();
    await ext.started!({ agents, service: fakeService() });
    await prompt.end();
    await ext.stopping!();
    expect(published).toEqual([]);
  });
});

describe("the dispatch", () => {
  it("runs inside OpenClaw's trace scope with the pair's id, and inside the served scope", async () => {
    const { ext, published } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await prompt.dispatched;
    await ext.stopping!();
    const traceId = published[0]!.record["harness_thread_id"];

    const seen = prompt.inTurn(() => ({
      openclaw: openClawTraceScope()?.getStore(),
      fabric: activeTrace(),
    }));
    expect(seen.openclaw?.traceId).toBe(traceId);
    expect(seen.openclaw?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(seen.openclaw?.traceFlags).toBe("01");
    expect(seen.fabric).toMatchObject({ threadId: THREAD, rootId: ROOT });
    // Nothing leaks out of the dispatch.
    expect(openClawTraceScope()?.getStore()).toBeUndefined();
    await prompt.end();
  });

  it("calls run once, synchronously, and returns its own promise", () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const request = { id: "never-seen", extras: {} };
    const own = Promise.resolve("dispatched");
    let calls = 0;
    const returned = ext.events!.aroundDispatch!(request, () => {
      calls++;
      return own;
    });
    expect(calls).toBe(1);
    expect(returned).toBe(own);
  });

  it("leaves a request it never saw alone", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const request = { id: "never-seen", extras: {} };
    const inside = await ext.events!.aroundDispatch!(request, () =>
      Promise.resolve({ openclaw: openClawTraceScope()?.getStore(), fabric: activeTrace() }),
    );
    expect(inside).toEqual({ openclaw: undefined, fabric: undefined });
    expect(ext.events!.aroundToolCall!(request, "prompt_agent", () => activeTrace())).toBe(
      undefined,
    );
    expect(() => ext.events!.promptEnded!(request, "ok", Date.now())).not.toThrow();
  });
});

describe("a tool call", () => {
  it("files the prompt OpenClaw's model sends under the served thread, with the tool-call ID", async () => {
    const { ext } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await prompt.dispatched;
    // In the turn's context, as OpenClaw 2026.8 and later run the tool.
    const [plan] = await prompt.inTurn(() =>
      ext.events!.aroundToolCall!(prompt.request, "prompt_agent", () =>
        phaseOne(ext.promptInterceptors!, { toolCallId: "call_oc_01" }),
      ),
    );
    expect(planOf(plan)).toMatchObject({
      parentId: THREAD,
      rootId: ROOT,
      toolCallId: "call_oc_01",
    });
    expect(planOf(plan).threadId).not.toBe(THREAD);
    await prompt.end();
  });

  it("binds the served scope even from a context that lost it", async () => {
    const { ext } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    // Called from the test's own context: no scope ambient.
    expect(activeTrace()).toBeUndefined();
    const [plan] = await ext.events!.aroundToolCall!(prompt.request, "prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "call_oc_02" }),
    );
    expect(planOf(plan)).toMatchObject({ parentId: THREAD, rootId: ROOT });
    await prompt.end();
  });
});

describe("the loop guard", () => {
  it("refuses a prompt of a tree OpenClaw's model waits in with 409, and admits it after", async () => {
    const { ext } = await started();
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await first.dispatched;
    await first.inTurn(() =>
      ext.events!.aroundToolCall!(first.request, "prompt_agent", () =>
        phaseOne(ext.promptInterceptors!, { toolCallId: "call_oc_03" }),
      ),
    );

    const back = serve(ext, { thread_id: "c".repeat(32), root_id: ROOT }, "ACME.researcher");
    await expect(back.accepted).rejects.toMatchObject({
      name: "RequestRejectedError",
      code: LOOP_GUARD_CODE,
      description: loopGuardDescription(ROOT),
    });

    const other = serve(ext, { thread_id: "d".repeat(32), root_id: "e".repeat(32) });
    await other.accepted;
    await other.end();

    await first.end();
    const later = serve(ext, { thread_id: "f".repeat(32), root_id: ROOT });
    await later.accepted;
    await later.end();
  });
});

describe("the loop guard, once the calls have settled", () => {
  it("admits a prompt of the tree once the model's calls have settled, the request still open", async () => {
    const { ext } = await started();
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT }, CALLER);
    await first.dispatched;
    const toolCall = (name: string, result: () => Promise<unknown>): Promise<unknown> =>
      first.inTurn(() => ext.events!.aroundToolCall!(first.request, name, result));
    const admitted = async (thread: string, root = ROOT): Promise<void> => {
      const p = serve(ext, { thread_id: thread.repeat(32), root_id: root });
      await p.accepted;
      await p.end();
    };
    const refused = (thread: string): Promise<void> =>
      expect(
        serve(ext, { thread_id: thread.repeat(32), root_id: ROOT }).accepted,
      ).rejects.toMatchObject({ code: LOOP_GUARD_CODE });

    // A blocking `prompt_agent`: refused while it runs, admitted once it returned.
    let settle!: (r: unknown) => void;
    let sent!: () => void;
    const prompted = new Promise<void>((r) => (sent = r));
    const blocking = toolCall("prompt_agent", async () => {
      await phaseOne(ext.promptInterceptors!, { toolCallId: "call_oc_11" });
      sent();
      return new Promise((r) => (settle = r));
    });
    await prompted;
    await refused("c");
    await admitted("d", "e".repeat(32));
    settle({ status: "completed", call_id: "c1", text: "done" });
    await blocking;
    await admitted("f");

    // A call with `wait: false`: refused while it is open, admitted after it expired.
    await toolCall("prompt_agent", async () => {
      await phaseOne(ext.promptInterceptors!, { toolCallId: "call_oc_12" });
      return { status: "running", call_id: "c2", open_calls: 1 };
    });
    await refused("1");
    await toolCall("wait_agent", () =>
      Promise.resolve({ status: "expired", call_id: "c2", error: "the call expired" }),
    );
    await admitted("2");
    await first.end();
  });
});

describe("identity off", () => {
  it("warns once at start, and every record owed counts as dropped", async () => {
    const before = traceRecordCounts();
    const { ext, published, lines } = await started({ senderIdentity: "off" });
    for (let i = 0; i < 2; i++) {
      const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
      await prompt.end();
    }
    await ext.stopping!();
    // The add-on's warning a second time `started` is called: still once.
    await ext.started!({ agents: fakeClient(false).agents, service: fakeService() });
    await ext.stopping!();

    expect(published).toEqual([]);
    const after = traceRecordCounts();
    expect(after.dropped - before.dropped).toBe(4);
    expect(after.published - before.published).toBe(0);
    const warnings = lines.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings.filter((w) => w === IDENTITY_OFF_WARNING)).toHaveLength(1);
    // And the publisher's own, once, from the fabric package.
    expect(warnings.filter((w) => /no identity signer/.test(w))).toHaveLength(1);
  });
});
