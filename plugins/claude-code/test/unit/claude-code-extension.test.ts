// The factory and the extension, driven by a fake of the Claude Code
// plugin: no server, no Claude Code. What the plugin does with each hook is
// the plugin's tests' business; here is what the add-on gives it — the
// served pair on the session, its `end` at the turn's `Stop`, the served
// thread under a tool call, the loop guard.

import { afterEach, describe, expect, it, vi } from "vitest";
import { NatsAgentError } from "@synadia-ai/agents";
import {
  activeTrace,
  DEFAULT_EDGE_SUBJECT,
  LOOP_GUARD_CODE,
  loopGuardDescription,
  traceRecordCounts,
} from "@synadia-ai/agent-fabric";
import defaultExport, {
  fabricExtension,
  createFabricExtension,
  DEFAULT_STOP_WAIT_MS,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
  isClaudeSessionId,
  NO_SESSION_LINE,
} from "../../src/index.js";
import {
  extensionContext,
  fakeClient,
  fakeService,
  localTurn,
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
const SESSION = "0b5e7c0e-3f0a-4c55-9d0e-8b2f6a1d4c21";
const OTHER_SESSION = "6f1d2e3c-4b5a-4968-8776-a5b4c3d2e1f0";
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

const phases = (published: Published[]): Array<[unknown, unknown]> =>
  published.map((p) => [p.record["phase"], p.record["status"]]);

afterEach(() => {
  vi.useRealTimers();
});

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
      "aroundToolCall",
      "localTurnEnded",
      "localTurnStarted",
      "promptAccepted",
      "promptEnded",
      "promptStarted",
      "sessionStarted",
      "turnStopped",
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

  it("refuses an edge subject that can never be published to, and a stop wait that is no duration", () => {
    expect(() =>
      createFabricExtension(extensionContext({ options: { edgeSubject: "TRACE.>" } }), NO_ENV),
    ).toThrow(NatsAgentError);
    for (const stopWaitMs of [-1, "120000", Number.NaN])
      expect(() =>
        createFabricExtension(extensionContext({ options: { stopWaitMs } }), NO_ENV),
      ).toThrow(NatsAgentError);
  });

  it("logs the definitive address at start, and no warning with identity on", async () => {
    const { lines } = await started();
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
    expect(lines.map((l) => l.message)).toContain(
      `${EXTENSION_NAME}: tracing agents.prompt.cc.team.claude, edge and served records on TRACE.edges`,
    );
  });

  it("knows a Claude Code session id when it sees one", () => {
    expect(isClaudeSessionId(SESSION)).toBe(true);
    for (const bad of ["", " x", "a b", "a\nb", "-lead", "x".repeat(129), 42, undefined])
      expect(isClaudeSessionId(bad)).toBe(false);
  });
});

describe("the served pair", () => {
  it("publishes start at arrival, naming the session the hook reported, and harness claude", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const before = Math.floor(Date.now() / 1000);
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await prompt.accepted;
    const after = Math.floor(Date.now() / 1000);
    await ext.stopping!();
    expect(published).toHaveLength(2);
    const [start] = published.map((p) => p.record);
    expect(start).toMatchObject({
      version: 1,
      kind: "served",
      agent: PLUGIN_AGENT_ID,
      thread_id: THREAD,
      root_id: ROOT,
      harness: "claude",
      harness_thread_id: SESSION,
      phase: "start",
    });
    expect(start!["ts"]).toBeGreaterThanOrEqual(before);
    expect(start!["ts"]).toBeLessThanOrEqual(after);
    for (const p of published) {
      expect(servedSchemaErrors(p.record)).toEqual([]);
      expect(p.subject).toBe(DEFAULT_EDGE_SUBJECT);
      expect(p.nonce).toBe(p.record["record_id"]);
    }
  });

  it("prefers the session the plugin names on the request to the one it last heard of", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(OTHER_SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { sessionId: SESSION });
    await prompt.end("error");
    await ext.stopping!();
    expect(published.map((p) => p.record["harness_thread_id"])).toEqual([SESSION, SESSION]);
  });

  it("ends an answered turn at the Stop that follows the reply, with the stop's time", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    const repliedAt = Date.now();
    await prompt.end("ok", repliedAt);
    // A stop older than the reply belongs to an earlier turn.
    ext.events!.turnStopped!(SESSION, repliedAt - 5_000);
    await settled();
    expect(phases(published)).toEqual([["start", undefined]]);

    const stoppedAt = repliedAt + 7_000;
    ext.events!.turnStopped!(SESSION, stoppedAt);
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "ok"],
    ]);
    expect(published[1]!.record).toMatchObject({
      version: 1,
      harness: "claude",
      harness_thread_id: SESSION,
      ts: Math.floor(stoppedAt / 1000),
    });
    // The model replied itself: no reason.
    expect("reason" in published[1]!.record).toBe(false);
    expect(servedSchemaErrors(published[1]!.record)).toEqual([]);
  });

  it("ends an answered turn at the reply's time when no Stop comes within the bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    const repliedAt = Date.now();
    await prompt.end("ok", repliedAt);
    vi.advanceTimersByTime(DEFAULT_STOP_WAIT_MS - 1);
    await settled();
    expect(phases(published)).toEqual([["start", undefined]]);
    vi.advanceTimersByTime(1);
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "ok"],
    ]);
    expect(published[1]!.record["ts"]).toBe(Math.floor(repliedAt / 1000));
    // A late stop changes nothing.
    ext.events!.turnStopped!(SESSION, repliedAt + 200_000);
    await settled();
    expect(published).toHaveLength(2);
  });

  it("takes the bound from the entry's options", async () => {
    const { ext, published } = await started({ options: { stopWaitMs: 20 } });
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.end("ok");
    await new Promise((r) => setTimeout(r, 60));
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "ok"],
    ]);
  });

  it("ends a failed or expired request at once, with the plugin's time", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const failed = serve(ext, { thread_id: THREAD, root_id: ROOT });
    const failedAt = Date.now() - 3_000;
    await failed.end("error", failedAt);
    await expect(failed.done).rejects.toThrow("the request ended: error");
    const expired = serve(ext, { thread_id: "c".repeat(32), root_id: ROOT });
    await expired.end("timeout");
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "error"],
      ["start", undefined],
      ["end", "timeout"],
    ]);
    expect(published[1]!.record["ts"]).toBe(Math.floor(failedAt / 1000));
  });

  it("ends a prompt answered with the turn's final text at once, with reason final_text, version 2", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    // The plugin sends the final text at the turn's Stop: no Stop follows.
    const answeredAt = Date.now() - 2_000;
    await prompt.end("ok", answeredAt, "final_text");
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "ok"],
    ]);
    expect(published[1]!.record).toMatchObject({
      version: 2,
      status: "ok",
      reason: "final_text",
      ts: Math.floor(answeredAt / 1000),
    });
    expect(published[0]!.record["version"]).toBe(1);
    expect(servedSchemaErrors(published[1]!.record)).toEqual([]);
    // A Stop after it changes nothing.
    ext.events!.turnStopped!(SESSION, Date.now());
    await settled();
    expect(published).toHaveLength(2);
  });

  it("passes the plugin's reason on with a failure: no_reply, expired", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const unanswered = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await unanswered.end("error", undefined, "no_reply");
    await expect(unanswered.done).rejects.toThrow("the request ended: error");
    const expired = serve(ext, { thread_id: "c".repeat(32), root_id: ROOT });
    await expired.end("timeout", undefined, "expired");
    await settled();
    const ends = published.filter((p) => p.record["phase"] === "end").map((p) => p.record);
    expect(ends.map((r) => [r["version"], r["status"], r["reason"]])).toEqual([
      [2, "error", "no_reply"],
      [2, "timeout", "expired"],
    ]);
    for (const record of ends) expect(servedSchemaErrors(record)).toEqual([]);
  });

  it("gives a prompt before any session no pair, one log line, and still serves it", async () => {
    const { ext, published, lines } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await prompt.accepted;
    // The scope is kept: a tool call still files under the served thread.
    const [plan] = await prompt.toolCall("prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_01" }),
    );
    expect(planOf(plan)).toMatchObject({ parentId: THREAD, rootId: ROOT });
    await prompt.end("ok");
    ext.events!.turnStopped!(undefined, Date.now() + 1_000);
    await ext.stopping!();
    expect(published).toEqual([]);
    expect(lines.filter((l) => l.message === NO_SESSION_LINE)).toHaveLength(1);
  });

  it("gives two prompts in one session a pair each, settled in order by two stops", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const t0 = Date.now();
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT });
    const second = serve(ext, { thread_id: "c".repeat(32), root_id: "d".repeat(32) });
    await first.accepted;
    await second.accepted;
    await first.end("ok", t0 + 1_000);
    ext.events!.turnStopped!(SESSION, t0 + 3_000);
    await second.end("ok", t0 + 5_000);
    await settled();
    expect(published.map((p) => [p.record["thread_id"], p.record["phase"]])).toEqual([
      [THREAD, "start"],
      ["c".repeat(32), "start"],
      [THREAD, "end"],
    ]);
    ext.events!.turnStopped!(SESSION, t0 + 9_000);
    await settled();
    const ends = published.filter((p) => p.record["phase"] === "end").map((p) => p.record);
    expect(ends.map((r) => [r["thread_id"], r["ts"]])).toEqual([
      [THREAD, Math.floor((t0 + 3_000) / 1000)],
      ["c".repeat(32), Math.floor((t0 + 9_000) / 1000)],
    ]);
  });

  it("ends every prompt answered before one Stop with it: one turn, both replies", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const t0 = Date.now();
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT });
    const second = serve(ext, { thread_id: "c".repeat(32), root_id: "d".repeat(32) });
    await first.end("ok", t0 + 1_000);
    await second.end("ok", t0 + 2_000);
    ext.events!.turnStopped!(SESSION, t0 + 4_000);
    await settled();
    const ends = published.filter((p) => p.record["phase"] === "end").map((p) => p.record);
    expect(ends.map((r) => [r["thread_id"], r["ts"]])).toEqual([
      [THREAD, Math.floor((t0 + 4_000) / 1000)],
      ["c".repeat(32), Math.floor((t0 + 4_000) / 1000)],
    ]);
  });

  it("keeps the session bound at arrival: a Stop of another session ends nothing", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    ext.events!.sessionStarted!(OTHER_SESSION, "clear");
    await prompt.end("ok");
    ext.events!.turnStopped!(OTHER_SESSION, Date.now() + 1_000);
    await settled();
    expect(phases(published)).toEqual([["start", undefined]]);
    // The plugin names no session on a stop it cannot attribute: any turn may end.
    ext.events!.turnStopped!(undefined, Date.now() + 2_000);
    await settled();
    expect(published[1]!.record).toMatchObject({ phase: "end", harness_thread_id: SESSION });
  });

  it("settles every open turn at stopping: an answered one at its reply, an open one now", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const answered = serve(ext, { thread_id: THREAD, root_id: ROOT });
    const repliedAt = Date.now() - 10_000;
    await answered.end("ok", repliedAt);
    const open = serve(ext, { thread_id: "c".repeat(32), root_id: ROOT });
    await open.accepted;
    await ext.stopping!();
    const ends = published.filter((p) => p.record["phase"] === "end").map((p) => p.record);
    expect(ends.map((r) => [r["thread_id"], r["status"], r["reason"]])).toEqual([
      [THREAD, "ok", undefined],
      ["c".repeat(32), "error", "shutdown"],
    ]);
    expect(ends.map((r) => r["version"])).toEqual([1, 2]);
    expect(ends[0]!["ts"]).toBe(Math.floor(repliedAt / 1000));
    // The plugin's own promptEnded after stopping finds nothing to settle.
    await open.end("error");
    await ext.stopping!();
    expect(published.filter((p) => p.record["phase"] === "end")).toHaveLength(2);
  });

  it("publishes nothing when propagate-only", async () => {
    const { ext, published } = await started({ options: { edgeSubject: null } });
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.end("error");
    await ext.stopping!();
    expect(published).toEqual([]);
  });
});

describe("when Claude Code takes the prompt into a turn", () => {
  it("starts the pair at promptStarted, not at the accept, on the session the submit named", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(OTHER_SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await prompt.accepted;
    await settled();
    expect(published).toEqual([]);
    const takenAt = Date.now() - 4_000;
    // A `/clear` between the accept and the start: the submit's session wins.
    prompt.start(takenAt, SESSION);
    await settled();
    expect(published.map((p) => p.record)).toEqual([
      expect.objectContaining({
        phase: "start",
        thread_id: THREAD,
        harness_thread_id: SESSION,
        ts: Math.floor(takenAt / 1000),
      }),
    ]);
    // A second start does nothing.
    prompt.start(Date.now(), OTHER_SESSION);
    await prompt.end("error");
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "error"],
    ]);
  });

  it("without a session on the start, the one known at the accept", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await prompt.accepted;
    ext.events!.sessionStarted!(OTHER_SESSION, "clear");
    prompt.start();
    await prompt.end("error");
    await settled();
    expect(published.map((p) => p.record["harness_thread_id"])).toEqual([SESSION, SESSION]);
  });

  it("gives a prompt that ends while it waits, with no turn running, its pair at once at its end", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await prompt.accepted;
    const endedAt = Date.now() - 2_000;
    await prompt.end("timeout", endedAt, "expired");
    await settled();
    expect(published.map((p) => [p.record["phase"], p.record["ts"], p.record["reason"]])).toEqual([
      ["start", Math.floor(endedAt / 1000), undefined],
      ["end", Math.floor(endedAt / 1000), "expired"],
    ]);
  });
});

describe("a local turn", () => {
  it("publishes its root's pair: start at the turn's start, end at its end, the thread its own root", async () => {
    const { ext, published } = await started();
    const local = localTurn(ext, SESSION);
    const startAt = Date.now() - 9_000;
    local.start(startAt);
    await settled();
    const endAt = Date.now() - 1_000;
    local.end("ok", endAt);
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "ok"],
    ]);
    const [start, end] = published.map((p) => p.record);
    expect(start).toMatchObject({
      harness: "claude",
      harness_thread_id: SESSION,
      ts: Math.floor(startAt / 1000),
    });
    expect(end!["ts"]).toBe(Math.floor(endAt / 1000));
    expect(start!["thread_id"]).toBe(start!["root_id"]);
    expect(end!["thread_id"]).toBe(start!["thread_id"]);
    for (const p of published) expect(servedSchemaErrors(p.record)).toEqual([]);
    // Ended twice, or at stopping: nothing more.
    local.end("ok");
    await ext.stopping!();
    expect(published).toHaveLength(2);
  });

  it("ends with an error when the turn failed", async () => {
    const { ext, published } = await started();
    const local = localTurn(ext, SESSION);
    local.start();
    local.end("error");
    await settled();
    expect(phases(published)).toEqual([
      ["start", undefined],
      ["end", "error"],
    ]);
  });

  it("runs its agent-tool calls in its root: the edge's parent and root are the root, a new root per turn", async () => {
    const { ext, published } = await started();
    const first = localTurn(ext, SESSION);
    first.start();
    const [plan] = await first.toolCall("prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_local" }),
    );
    await settled();
    const root = published[0]!.record["thread_id"];
    expect(planOf(plan)).toMatchObject({ parentId: root, rootId: root, toolCallId: "toolu_local" });
    first.end();
    const second = localTurn(ext, SESSION);
    second.start();
    const [next] = await second.toolCall("prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_next" }),
    );
    expect(planOf(next).rootId).not.toBe(root);
    second.end();
    // After its end, no scope: the call runs as it is.
    expect(first.toolCall("prompt_agent", () => activeTrace())).toBeUndefined();
  });

  it("guards its root: a prompt of that root while a call is open is refused with 409, and admitted after", async () => {
    const { ext } = await started();
    const local = localTurn(ext, SESSION);
    local.start();
    let settle!: (r: unknown) => void;
    let sent!: (root: string) => void;
    const prompted = new Promise<string>((r) => (sent = r));
    const blocking = local.toolCall("prompt_agent", async () => {
      const [plan] = await phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_g" });
      sent(planOf(plan).rootId);
      return new Promise((r) => (settle = r));
    });
    const root = await prompted;
    await expect(serve(ext, { thread_id: THREAD, root_id: root }).accepted).rejects.toMatchObject({
      code: LOOP_GUARD_CODE,
      description: loopGuardDescription(root),
    });
    settle({ status: "completed", call_id: "c1", text: "done" });
    await blocking;
    local.end();
    const later = serve(ext, { thread_id: THREAD, root_id: root });
    await later.accepted;
    await later.end("error");
  });

  it("without a session: no pair, and the scope and the guard still work", async () => {
    const { ext, published } = await started();
    const local = localTurn(ext);
    local.start();
    const [plan] = await local.toolCall("prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_ns" }),
    );
    expect(planOf(plan).parentId).toBe(planOf(plan).rootId);
    local.end();
    await ext.stopping!();
    expect(published).toEqual([]);
  });

  it("a NATS prompt accepted during it starts at its own turn after it, its start after the local end", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const local = localTurn(ext, SESSION);
    const t0 = Date.now() - 20_000;
    local.start(t0);
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await prompt.accepted;
    local.end("ok", t0 + 9_000);
    prompt.start(t0 + 9_030, SESSION);
    await prompt.end("error", t0 + 9_500);
    await settled();
    const records = published.map((p) => p.record);
    expect(records.map((r) => [r["thread_id"] === THREAD ? "nats" : "local", r["phase"]])).toEqual([
      ["local", "start"],
      ["local", "end"],
      ["nats", "start"],
      ["nats", "end"],
    ]);
    expect(records[2]!["ts"]).toBe(Math.floor((t0 + 9_030) / 1000));
  });

  it("holds the pair of a prompt that ended while it waited behind the turn: both records at the turn's end, after it", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const local = localTurn(ext, SESSION);
    const t0 = Date.now() - 30_000;
    local.start(t0);
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await prompt.accepted;
    // Cancelled while it waited: nothing goes out inside the turn.
    await prompt.end("timeout", t0 + 3_000, "expired");
    await settled();
    expect(published.map((p) => p.record["thread_id"] === THREAD)).toEqual([false]);
    const endAt = t0 + 8_000;
    local.end("ok", endAt);
    await settled();
    const records = published.map((p) => p.record);
    expect(
      records.map((r) => [r["thread_id"] === THREAD ? "nats" : "local", r["phase"], r["ts"]]),
    ).toEqual([
      ["local", "start", Math.floor(t0 / 1000)],
      ["local", "end", Math.floor(endAt / 1000)],
      ["nats", "start", Math.floor(endAt / 1000)],
      ["nats", "end", Math.floor(endAt / 1000)],
    ]);
    expect(records[3]).toMatchObject({ status: "timeout", reason: "expired", version: 2 });
  });

  it("holds the pair until an answered prompt's turn has stopped, too", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const t0 = Date.now() - 30_000;
    const running = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await running.accepted;
    running.start(t0, SESSION);
    const waiting = serve(ext, { thread_id: "c".repeat(32), root_id: ROOT }, { start: false });
    await waiting.accepted;
    await waiting.end("error", t0 + 1_000, "no_reply");
    await running.end("ok", t0 + 2_000);
    await settled();
    expect(published.map((p) => p.record["thread_id"])).toEqual([THREAD]);
    ext.events!.turnStopped!(SESSION, t0 + 3_000);
    await settled();
    expect(
      published.map((p) => [p.record["thread_id"], p.record["phase"], p.record["ts"]]),
    ).toEqual([
      [THREAD, "start", Math.floor(t0 / 1000)],
      [THREAD, "end", Math.floor((t0 + 3_000) / 1000)],
      ["c".repeat(32), "start", Math.floor((t0 + 3_000) / 1000)],
      ["c".repeat(32), "end", Math.floor((t0 + 3_000) / 1000)],
    ]);
  });

  it("stopping: the local turn's end first, then the held pairs at the same instant, then the served ones", async () => {
    const { ext, published } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const local = localTurn(ext, SESSION);
    local.start(Date.now() - 10_000);
    const held = serve(ext, { thread_id: "c".repeat(32), root_id: ROOT }, { start: false });
    await held.accepted;
    await held.end("timeout", Date.now() - 5_000, "expired");
    const waiting = serve(ext, { thread_id: THREAD, root_id: ROOT }, { start: false });
    await waiting.accepted;
    await ext.stopping!();
    const records = published.map((p) => p.record);
    const name = (r: Record<string, unknown>): string =>
      r["thread_id"] === THREAD ? "waiting" : r["thread_id"] === "c".repeat(32) ? "held" : "local";
    expect(records.map((r) => [name(r), r["phase"], r["status"], r["reason"]])).toEqual([
      ["local", "start", undefined, undefined],
      ["local", "end", "ok", undefined],
      ["held", "start", undefined, undefined],
      ["held", "end", "timeout", "expired"],
      ["waiting", "start", undefined, undefined],
      ["waiting", "end", "error", "shutdown"],
    ]);
    expect(new Set(records.slice(1).map((r) => r["ts"])).size).toBe(1);
  });
});

describe("a tool call", () => {
  it("files the prompt Claude Code's model sends under the served thread, with the tool-call ID", async () => {
    const { ext } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await prompt.accepted;
    const [plan] = await prompt.toolCall("prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_01ABC" }),
    );
    expect(planOf(plan)).toMatchObject({
      parentId: THREAD,
      rootId: ROOT,
      toolCallId: "toolu_01ABC",
    });
    expect(planOf(plan).threadId).not.toBe(THREAD);
    await prompt.end("error");
  });

  it("binds the served scope even from a context that lost it", async () => {
    const { ext } = await started();
    const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
    await prompt.accepted;
    expect(activeTrace()).toBeUndefined();
    const [plan] = await ext.events!.aroundToolCall!(prompt.request, "prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_02" }),
    );
    expect(planOf(plan)).toMatchObject({ parentId: THREAD, rootId: ROOT });
    await prompt.end("error");
  });

  it("leaves a call outside any request alone, and calls run once with its own value", () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const own = Promise.resolve("done");
    let calls = 0;
    const returned = ext.events!.aroundToolCall!(undefined, "prompt_agent", () => {
      calls++;
      return own;
    });
    expect(calls).toBe(1);
    expect(returned).toBe(own);
    expect(
      ext.events!.aroundToolCall!({ id: "never-seen", extras: {} }, "prompt_agent", () =>
        activeTrace(),
      ),
    ).toBeUndefined();
  });
});

describe("the loop guard", () => {
  it("refuses a prompt of a tree Claude Code's model waits in with 409, and admits it after", async () => {
    const { ext } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await first.accepted;
    await first.toolCall("prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_03" }),
    );

    const back = serve(
      ext,
      { thread_id: "c".repeat(32), root_id: ROOT },
      {
        caller: "ACME.researcher",
      },
    );
    await expect(back.accepted).rejects.toMatchObject({
      name: "RequestRejectedError",
      code: LOOP_GUARD_CODE,
      description: loopGuardDescription(ROOT),
    });

    const other = serve(ext, { thread_id: "d".repeat(32), root_id: "e".repeat(32) });
    await other.accepted;
    await other.end("error");

    await first.end("ok");
    const later = serve(ext, { thread_id: "f".repeat(32), root_id: ROOT });
    await later.accepted;
    await later.end("error");
    await ext.stopping!();
  });
});

describe("the loop guard, once the calls have settled", () => {
  it("admits a prompt of the tree once the model's calls have settled, the request still open", async () => {
    const { ext } = await started();
    ext.events!.sessionStarted!(SESSION, "startup");
    const first = serve(ext, { thread_id: THREAD, root_id: ROOT }, { caller: CALLER });
    await first.accepted;
    const admitted = async (thread: string, root = ROOT): Promise<void> => {
      const p = serve(ext, { thread_id: thread.repeat(32), root_id: root });
      await p.accepted;
      await p.end("error");
    };
    const refused = (thread: string): Promise<void> =>
      expect(
        serve(ext, { thread_id: thread.repeat(32), root_id: ROOT }).accepted,
      ).rejects.toMatchObject({ code: LOOP_GUARD_CODE });

    // A blocking `prompt_agent`: refused while it runs, admitted once it returned.
    let settle!: (r: unknown) => void;
    let sent!: () => void;
    const prompted = new Promise<void>((r) => (sent = r));
    const blocking = first.toolCall("prompt_agent", async () => {
      await phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_11" });
      sent();
      return new Promise((r) => (settle = r));
    });
    await prompted;
    await refused("c");
    await admitted("d", "e".repeat(32));
    settle({ status: "completed", call_id: "c1", text: "done" });
    await blocking;
    await admitted("f");

    // A call with `wait: false`: refused while it is open, admitted after `cancel_agent` ended it.
    await first.toolCall("prompt_agent", async () => {
      await phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_12" });
      return { status: "running", call_id: "c2", open_calls: 1 };
    });
    await refused("1");
    await first.toolCall("cancel_agent", () => Promise.resolve({ cancelled: ["c2"] }));
    await admitted("2");
    await first.end("ok");
    await ext.stopping!();
  });
});

describe("identity off", () => {
  it("warns once at start, and every record owed counts as dropped", async () => {
    const before = traceRecordCounts();
    const { ext, published, lines } = await started({ senderIdentity: "off" });
    ext.events!.sessionStarted!(SESSION, "startup");
    for (let i = 0; i < 2; i++) {
      const prompt = serve(ext, { thread_id: THREAD, root_id: ROOT });
      await prompt.end("error");
    }
    await ext.stopping!();
    await ext.started!({ agents: fakeClient(false).agents, service: fakeService() });
    await ext.stopping!();

    expect(published).toEqual([]);
    const after = traceRecordCounts();
    expect(after.dropped - before.dropped).toBe(4);
    expect(after.published - before.published).toBe(0);
    const warnings = lines.filter((l) => l.level === "warn").map((l) => l.message);
    expect(warnings.filter((w) => w === IDENTITY_OFF_WARNING)).toHaveLength(1);
    expect(warnings.filter((w) => /no identity signer/.test(w))).toHaveLength(1);
  });
});

/**
 * Let the publisher's chain run without settling anything: `stopping()`
 * would end the turns, so wait for the records already due instead.
 */
async function settled(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}
