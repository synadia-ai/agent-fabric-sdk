// The factory and the extension, driven by a fake of the PI plugin: no
// server, no PI. What the plugin does with each hook is the plugin's
// tests' business; here is what the add-on gives it.

import { describe, expect, it } from "vitest";
import { NatsAgentError } from "@synadia-ai/agents";
import {
  activeTrace,
  bindActiveTrace,
  DEFAULT_EDGE_SUBJECT,
  isThreadId,
  ROOT_ID_HEADER,
  THREAD_ID_HEADER,
  traceRecordCounts,
  type TraceScope,
} from "@synadia-ai/agent-fabric";
import defaultExport, {
  createFabricExtension,
  fabricExtension,
  EDGE_SUBJECT_VAR,
  EXTENSION_NAME,
  IDENTITY_OFF_WARNING,
  resolveEdgeSubject,
} from "../../src/index.js";
import {
  extensionContext,
  phaseOne,
  planOf,
  recordingLogger,
  serve,
  servedRequest,
} from "../support/fake-plugin.js";

const THREAD = "a".repeat(32);
const ROOT = "b".repeat(32);
const NO_ENV: NodeJS.ProcessEnv = {};

describe("the factory", () => {
  it("is the default export, and the named one, resolving ScratchPad first", async () => {
    expect(defaultExport).toBe(fabricExtension);
    const ext = await defaultExport(extensionContext(), NO_ENV);
    expect(ext.name).toBe(EXTENSION_NAME);
    expect(ext.toolExtensions).toBeUndefined();
  });

  it("returns the extension of the contract: tracing's hooks, the guard, no tool extensions", () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    expect(ext.name).toBe(EXTENSION_NAME);
    expect(ext.requestInterceptors).toHaveLength(2);
    expect(ext.promptInterceptors).toHaveLength(2);
    expect(typeof ext.heartbeatExtras).toBe("function");
    expect(ext.toolExtensions).toBeUndefined();
    expect(Object.keys(ext)).not.toContain("stopping");
    expect(Object.keys(ext)).toContain("started");
    expect(Object.keys(ext.events!).sort()).toEqual([
      "aroundInject",
      "aroundToolCall",
      "promptAccepted",
      "promptEnded",
      "providerHeaders",
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
});

describe("the one setting, the edge subject", () => {
  it("defaults to the fabric's subject", () => {
    expect(resolveEdgeSubject({}, NO_ENV)).toBe(DEFAULT_EDGE_SUBJECT);
  });

  it("reads the variable when the option is not given", () => {
    expect(resolveEdgeSubject({}, { [EDGE_SUBJECT_VAR]: "TRACE.staging.edges" })).toBe(
      "TRACE.staging.edges",
    );
  });

  it("lets the config entry's option win over the variable", () => {
    expect(
      resolveEdgeSubject({ edgeSubject: "TRACE.mine" }, { [EDGE_SUBJECT_VAR]: "TRACE.theirs" }),
    ).toBe("TRACE.mine");
  });

  it("takes null as propagate-only: lineage, no records, no counts on the heartbeat", () => {
    expect(resolveEdgeSubject({ edgeSubject: null }, NO_ENV)).toBeNull();
    const ext = createFabricExtension(extensionContext({ options: { edgeSubject: null } }), NO_ENV);
    expect(ext.heartbeatExtras!()).toEqual({});
  });

  it.each([
    ["a wildcard", "TRACE.*"],
    ["an empty subject", ""],
    ["an empty token", "TRACE..edges"],
    ["a number", 42],
  ])("refuses %s at construction, so the plugin starts plain and says why", (_what, value) => {
    expect(() =>
      createFabricExtension(extensionContext({ options: { edgeSubject: value } }), NO_ENV),
    ).toThrow(NatsAgentError);
    expect(() => createFabricExtension(extensionContext(), { [EDGE_SUBJECT_VAR]: "" })).toThrow(
      NatsAgentError,
    );
  });
});

describe("a served request with the pair in its envelope", () => {
  it("gives PI's provider requests the two headers of the served thread, the hint rising per call", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT });
    await served.accepted;

    // `before_provider_headers` fires in PI's own context, not the handler's.
    expect(activeTrace()).toBeUndefined();
    const first = ext.events!.providerHeaders!(served.request);
    const second = ext.events!.providerHeaders!(served.request);
    expect(first).toEqual({ [THREAD_ID_HEADER]: THREAD, [ROOT_ID_HEADER]: ROOT });
    expect(second).toEqual(first);

    // An edge PI's model spawns now says two calls came before it.
    const plan = ext.events!.aroundToolCall!(served.request, "prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_pi_1" }).then(([tracing]) =>
        planOf(tracing),
      ),
    );
    expect(await plan).toMatchObject({
      parentId: THREAD,
      rootId: ROOT,
      toolCallId: "toolu_pi_1",
      turnCountHint: 2,
    });
    await served.end();
  });

  it("runs the injected turn inside the served scope, replacing whatever context injects it", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT });
    await served.accepted;

    // The plugin injects the next queued prompt from the previous turn's
    // settle hook, whose context is the previous request's.
    const previous: TraceScope = {
      threadId: "c".repeat(32),
      rootId: "d".repeat(32),
      turnCountHint: 7,
    };
    const seen = bindActiveTrace(previous, () =>
      ext.events!.aroundInject!(served.request, () => activeTrace()),
    );
    expect(seen).toMatchObject({ threadId: THREAD, rootId: ROOT });
    expect(seen).not.toBe(previous);
    await served.end();
  });

  it("writes the edge of a prompt sent from the tool call under the served thread, with the tool-call ID", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT }, "ACME.caller");
    await served.accepted;

    const [tracing] = await ext.events!.aroundToolCall!(served.request, "prompt_agent", () =>
      phaseOne(ext.promptInterceptors!, { toolCallId: "toolu_pi_2" }),
    );
    expect(tracing?.fields).toEqual({
      thread_id: expect.stringMatching(/^[0-9a-f]{32}$/) as string,
      root_id: ROOT,
    });
    expect(planOf(tracing)).toMatchObject({
      parentId: THREAD,
      rootId: ROOT,
      toolCallId: "toolu_pi_2",
      turnCountHint: 0,
    });
    expect(planOf(tracing).threadId).not.toBe(THREAD);
    await served.end();
  });

  it("forgets the request when the plugin settles it", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const served = serve(ext, "r1", { thread_id: THREAD, root_id: ROOT });
    await served.accepted;
    expect(ext.events!.providerHeaders!(served.request)).toBeDefined();
    await served.end();
    expect(ext.events!.providerHeaders!(served.request)).toBeUndefined();
  });
});

describe("a served request without the pair", () => {
  it("gets a root minted for it, which its provider requests carry", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const served = serve(ext, "r2", {});
    await served.accepted;
    const headers = ext.events!.providerHeaders!(served.request)!;
    expect(isThreadId(headers[THREAD_ID_HEADER]!)).toBe(true);
    expect(headers[ROOT_ID_HEADER]).toBe(headers[THREAD_ID_HEADER]);
    await served.end();
  });

  it("is refused with 400 on a half pair, before the add-on sees it", async () => {
    const ext = createFabricExtension(extensionContext(), NO_ENV);
    const served = serve(ext, "r3", { thread_id: THREAD });
    await expect(served.accepted).rejects.toMatchObject({
      name: "RequestRejectedError",
      code: 400,
    });
    expect(ext.events!.providerHeaders!(served.request)).toBeUndefined();
  });
});

describe("a request the add-on never saw", () => {
  const ext = createFabricExtension(extensionContext(), NO_ENV);
  const unknown = servedRequest("never", {});

  it("gets no headers", () => {
    expect(ext.events!.providerHeaders!(unknown)).toBeUndefined();
  });

  it("is injected and its tools run as they are, in the ambient context, with run's value", () => {
    const outer: TraceScope = { threadId: THREAD, rootId: ROOT, turnCountHint: 0 };
    expect(
      bindActiveTrace(outer, () => ext.events!.aroundInject!(unknown, () => activeTrace())),
    ).toBe(outer);
    expect(ext.events!.aroundInject!(unknown, () => 42)).toBe(42);
    expect(
      ext.events!.aroundToolCall!(unknown, "discover_agents", () => activeTrace()),
    ).toBeUndefined();
    expect(ext.events!.aroundToolCall!(undefined, "discover_agents", () => "value")).toBe("value");
  });

  it("is forgotten without complaint", () => {
    expect(() => ext.events!.promptEnded!(unknown, "ok", Date.now())).not.toThrow();
  });
});

describe("started", () => {
  const handles = { service: { subject: { prompt: "agents.prompt.pi.team.editor-2" } } };

  it("warns once, and only once, when the plugin's identity is off", async () => {
    const { logger, lines } = recordingLogger();
    const ext = createFabricExtension(extensionContext({ senderIdentity: "off", logger }), NO_ENV);
    await ext.started!(handles as never);
    await ext.started!(handles as never);
    const warnings = lines.filter((l) => l.level === "warn");
    expect(warnings).toEqual([{ level: "warn", message: IDENTITY_OFF_WARNING }]);
  });

  it("does not warn when the identity is signed, and logs the definitive address", async () => {
    const { logger, lines } = recordingLogger();
    const ext = createFabricExtension(
      extensionContext({ senderIdentity: "signed", logger }),
      NO_ENV,
    );
    await ext.started!(handles as never);
    expect(lines.filter((l) => l.level === "warn")).toEqual([]);
    expect(lines.filter((l) => l.level === "info").map((l) => l.message)).toEqual([
      `${EXTENSION_NAME}: tracing agents.prompt.pi.team.editor-2, edge records on TRACE.edges`,
    ]);
  });
});
