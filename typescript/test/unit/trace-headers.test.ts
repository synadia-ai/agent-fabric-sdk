import { describe, expect, it } from "vitest";
import {
  activeTrace,
  bindActiveTrace,
  isThreadId,
  ROOT_ID_HEADER,
  rootTraceScope,
  THREAD_ID_HEADER,
  traceHeaders,
  type TraceScope,
} from "../../src/index.js";

const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);

/**
 * `traceHeaders()` is what a handler stamps on every model request: the
 * two headers the model proxy files the call under, and a turn counted
 * against the execution for the edges of the threads it spawns later.
 */
describe("traceHeaders", () => {
  it("is empty outside a traced handler, so harness code degrades to nothing", () => {
    expect(activeTrace()).toBeUndefined();
    expect(traceHeaders()).toEqual({});
  });

  it("returns the two X-Synadia headers of the bound scope", () => {
    const scope: TraceScope = { threadId: THREAD, rootId: ROOT, turnCountHint: 0 };
    const headers = bindActiveTrace(scope, () => traceHeaders());
    expect(headers).toEqual({ "X-Synadia-Thread-ID": THREAD, "X-Synadia-Root-ID": ROOT });
    expect(THREAD_ID_HEADER).toBe("X-Synadia-Thread-ID");
    expect(ROOT_ID_HEADER).toBe("X-Synadia-Root-ID");
  });

  it("counts every call as a turn of the execution", () => {
    const scope: TraceScope = { threadId: THREAD, rootId: ROOT, turnCountHint: 0 };
    bindActiveTrace(scope, () => {
      traceHeaders();
      traceHeaders();
      traceHeaders();
    });
    expect(scope.turnCountHint).toBe(3);
  });

  it("counts a turn taken in work spawned inside the scope against the same execution", async () => {
    const scope: TraceScope = { threadId: THREAD, rootId: ROOT, turnCountHint: 0 };
    await bindActiveTrace(scope, async () => {
      traceHeaders();
      await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, 1));
          traceHeaders();
        })(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            traceHeaders();
            resolve();
          }, 2),
        ),
      ]);
    });
    expect(scope.turnCountHint).toBe(3);
  });

  it("leaves no scope behind once the binding returns", async () => {
    const scope: TraceScope = { threadId: THREAD, rootId: ROOT, turnCountHint: 0 };
    await bindActiveTrace(scope, async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
    expect(activeTrace()).toBeUndefined();
    expect(traceHeaders()).toEqual({});
  });

  it("keeps concurrent executions apart", async () => {
    const scopes: TraceScope[] = ["1", "2", "3"].map((d) => ({
      threadId: d.repeat(32),
      rootId: d.repeat(32),
      turnCountHint: 0,
    }));
    const seen = await Promise.all(
      scopes.map((scope, i) =>
        bindActiveTrace(scope, async () => {
          const before = activeTrace();
          await new Promise((r) => setTimeout(r, 10 - i * 3));
          for (let n = 0; n <= i; n++) traceHeaders();
          return [before, activeTrace()] as const;
        }),
      ),
    );
    seen.forEach(([before, after], i) => {
      expect(before).toBe(scopes[i]);
      expect(after).toBe(scopes[i]);
    });
    expect(scopes.map((s) => s.turnCountHint)).toEqual([1, 2, 3]);
  });
});

/**
 * `rootTraceScope()` is the root a receiver mints for an envelope that
 * names no thread, and the one a harness add-on binds around a local turn.
 */
describe("rootTraceScope", () => {
  it("mints a thread that is its own root, with no call counted", () => {
    const scope = rootTraceScope();
    expect(isThreadId(scope.threadId)).toBe(true);
    expect(scope.rootId).toBe(scope.threadId);
    expect(scope.turnCountHint).toBe(0);
  });

  it("mints a fresh root and a fresh object each time", () => {
    const a = rootTraceScope();
    const b = rootTraceScope();
    expect(a).not.toBe(b);
    expect(a.threadId).not.toBe(b.threadId);
  });

  it("is what its model calls are filed under, once bound", () => {
    const scope = rootTraceScope();
    expect(bindActiveTrace(scope, traceHeaders)).toEqual({
      [THREAD_ID_HEADER]: scope.threadId,
      [ROOT_ID_HEADER]: scope.threadId,
    });
    expect(scope.turnCountHint).toBe(1);
  });
});
