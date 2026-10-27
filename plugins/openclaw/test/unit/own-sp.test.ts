// The add-on's own sp, for its own ScratchPad steps (the references its
// model hands on, the grant requests it answers): `SCRATCHPAD_BIN`, else the
// binary the package ships, the first that is an executable file. Without
// one nothing is granted: references are removed with a note, one warning
// says so, and no prompt fails for it.
// OpenClaw may load the add-on's module from a copy of its own that has no
// `skill/`, or whose files lost their mode; the tests lay out the shipped
// binary in a directory of their own, the fabric package's lookup pointed
// at it.

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolsPromptContext, Agent } from "@synadia-ai/agents";
import type { AgentService } from "@synadia-ai/agent-service";
import { READS_REFERENCES_KEY } from "@synadia-ai/agent-fabric";
import type * as AgentFabric from "@synadia-ai/agent-fabric";

const skill = vi.hoisted(() => ({ dir: "" }));

vi.mock("@synadia-ai/agent-fabric", async (importOriginal) => {
  const real = await importOriginal<typeof AgentFabric>();
  return {
    ...real,
    // The package's skill directory, as each test lays it out.
    findSp: (env: Record<string, string | undefined>) => real.findSp(env, skill.dir),
    spPort: (
      settings: Parameters<typeof real.spPort>[0],
      creator: string,
      env: Record<string, string | undefined>,
    ) => real.spPort(settings, creator, env, skill.dir),
  };
});

import createExtension from "../../src/index.js";
import type { ScratchPadHandOn } from "../../src/index.js";
import { extensionContext, fakeClient, recordingLogger, serve } from "../support/fake-plugin.js";
import { makeReference } from "../support/scratchpad-fake.js";

const ADDRESS = "agents.prompt.oc.team.summarizer";
const SHIPPED = `sp-${platform() === "darwin" ? "darwin" : "linux"}-${arch() === "arm64" ? "arm64" : "amd64"}`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fabric-openclaw-own-sp-"));
  skill.dir = join(root, "skill", "scratchpad");
});

/** An sp at `path` with `mode`: a script that is never run here. */
function sp(path: string, mode: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, mode);
  return path;
}

const shipped = (mode: number): string => sp(join(skill.dir, "bin", SHIPPED), mode);

const configured = (more: Record<string, string | undefined> = {}) => ({
  SCRATCHPAD_VOLUME: "OcVol",
  NATS_URL: "nats://127.0.0.1:4222",
  NATS_CREDS: "/keys/oc.creds",
  ...more,
});

/** The plugin's service, with the endpoint route the add-on answers grant requests on. */
function service(): { service: AgentService; endpoints: string[] } {
  const endpoints: string[] = [];
  const svc = {
    subject: { prompt: ADDRESS },
    service: {
      addEndpoint: (name: string) => {
        endpoints.push(name);
      },
    },
  };
  return { service: svc as unknown as AgentService, endpoints };
}

async function started(env: Record<string, string | undefined>) {
  const { logger, lines } = recordingLogger();
  const ext = await createExtension(extensionContext({ logger, stateDir: root }), env);
  const { service: svc, endpoints } = service();
  await ext.started!({ agents: fakeClient().agents, service: svc });
  const warnings = (): string[] => lines.filter((l) => l.level === "warn").map((l) => l.message);
  return { ext, endpoints, warnings };
}

const reader = {
  promptSubject: "agents.prompt.r.team.reader",
  identity: "AREADER.UREADER",
  idSigVerified: true,
  metadata: { [READS_REFERENCES_KEY]: "true" },
} as unknown as Agent;

const promptTo = (prompt: string): AgentToolsPromptContext =>
  ({
    address: reader.promptSubject,
    target: reader,
    prompt,
    arguments: {},
  }) as unknown as AgentToolsPromptContext;

describe("the add-on's own sp", () => {
  it("is SCRATCHPAD_BIN when that is an executable file: grant requests are answered, no warning", async () => {
    const own = sp(join(root, "elsewhere", "sp"), 0o755);
    const { endpoints, warnings } = await started(configured({ SCRATCHPAD_BIN: own }));
    expect(endpoints).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it("is the shipped binary when SCRATCHPAD_BIN is not set", async () => {
    shipped(0o755);
    const { endpoints, warnings } = await started(configured());
    expect(endpoints).toHaveLength(1);
    expect(warnings()).toEqual([]);
  });

  it("is the shipped binary when SCRATCHPAD_BIN names no file, with one warning: the skill's scripts/sp takes it as it is", async () => {
    const bin = shipped(0o755);
    const missing = join(root, "missing");
    const { endpoints, warnings } = await started(configured({ SCRATCHPAD_BIN: missing }));
    expect(endpoints).toHaveLength(1);
    expect(warnings()).toEqual([
      `agent-fabric: SCRATCHPAD_BIN ${missing} does not exist, so it is passed over and the add-on runs ${bin}; ` +
        "the skill's scripts/sp takes SCRATCHPAD_BIN as it is and refuses every call until it names an executable sp or is unset",
    ]);
  });

  it("passes over a file without the execute bit, as a copy may leave it: one warning says what was tried and how to fix it", async () => {
    const own = sp(join(root, "elsewhere", "sp"), 0o600);
    const bin = shipped(0o600);
    const { endpoints, warnings } = await started(configured({ SCRATCHPAD_BIN: own }));
    expect(endpoints).toEqual([]);
    expect(warnings()).toEqual([
      `agent-fabric: SCRATCHPAD_BIN ${own} is not executable, so it is passed over; the skill's scripts/sp ` +
        "takes SCRATCHPAD_BIN as it is and refuses every call until it names an executable sp or is unset",
      `agent-fabric: no sp for the add-on's own ScratchPad steps (SCRATCHPAD_BIN ${own} is not executable; ` +
        `${bin} is not executable); set SCRATCHPAD_BIN to the path of an sp binary. Until then nothing ` +
        "is granted: references in prompt_agent are removed with a note, and grant requests are not answered",
    ]);
  });

  it("is none when the copy has no skill directory: nothing is granted, references are removed with a note, prompts end ok", async () => {
    const { ext, endpoints, warnings } = await started(configured());
    expect(warnings()).toEqual([
      "agent-fabric: no sp for the add-on's own ScratchPad steps (SCRATCHPAD_BIN is not set; " +
        `${join(skill.dir, "bin", SHIPPED)} does not exist); set SCRATCHPAD_BIN to the path of an sp ` +
        "binary. Until then nothing is granted: references in prompt_agent are removed with a note, and grant " +
        "requests are not answered",
    ]);
    // No grant requests answered: no endpoint for them.
    expect(endpoints).toEqual([]);
    // Still a reader of references: the model reads with the skill's scripts/sp.
    expect(ext.metadata).toEqual({ [READS_REFERENCES_KEY]: "true" });
    // A reference the model hands on is removed with a note: nothing can be granted.
    const handOn = ext.toolExtensions![0] as ScratchPadHandOn;
    const prompt = `see ${makeReference("OcVol", "/out/a.txt", ADDRESS)}`;
    expect(await handOn.beforePrompt(promptTo(prompt))).toEqual({
      prompt: "see",
      fields: {
        references_removed: 1,
        note:
          "this agent has no sp of its own to grant read with (SCRATCHPAD_BIN names one): 1 reference(s) were " +
          `removed from your prompt, "${reader.promptSubject}" got only the text, and nothing was granted`,
      },
    });
    // A served prompt is served and ends ok, and the warning is not repeated.
    const served = serve(ext, {}, "ACALLER.UCALLER");
    await served.dispatched;
    await served.end("ok");
    await expect(served.done).resolves.toBeUndefined();
    expect(warnings()).toHaveLength(1);
  });
});
