// The caller's rules without a server: which agent `find` picks, and what
// the options and the environment must give before anything connects.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@synadia-ai/agents";
import {
  FabricCallerError,
  fabricCaller,
  fabricCallerFromEnv,
  pickAgent,
} from "../../src/index.js";
import { identityFixture } from "../harness/nats-server.js";

const ERIN = identityFixture("operator/erin.creds");

function agent(kind: string, name: string): Agent {
  return { agent: kind, promptSubject: `agents.prompt.${kind}.acme.${name}` } as Agent;
}

describe("pickAgent", () => {
  const writer = agent("writer", "w1");
  const reviewerA = agent("reviewer", "r1");
  const reviewerB = agent("reviewer", "r2");
  const found = [writer, reviewerA, reviewerB];

  it("takes the agent at that address", () => {
    expect(pickAgent(found, "agents.prompt.reviewer.acme.r2")).toBe(reviewerB);
  });

  it("takes the one agent of a kind", () => {
    expect(pickAgent(found, "writer")).toBe(writer);
  });

  it("counts two instances behind one address as one agent", () => {
    const twin = agent("writer", "w1");
    expect(pickAgent([writer, twin], "writer")).toBe(writer);
  });

  it("refuses a kind two agents have, naming both", () => {
    expect(() => pickAgent(found, "reviewer")).toThrow(
      '2 agents of kind "reviewer": agents.prompt.reviewer.acme.r1, agents.prompt.reviewer.acme.r2; name one by its address',
    );
    try {
      pickAgent(found, "reviewer");
    } catch (err) {
      expect((err as FabricCallerError).reason).toBe("ambiguous");
    }
  });

  it("names what is there when nothing matches", () => {
    expect(() => pickAgent([writer], "nobody")).toThrow(
      'no agent "nobody"; there: agents.prompt.writer.acme.w1',
    );
    expect(() => pickAgent([], "nobody")).toThrow('no agent "nobody"; there: nobody');
  });
});

describe("options and environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const failure = (p: Promise<unknown>): Promise<FabricCallerError> =>
    p.then(
      () => {
        throw new Error("expected a failure");
      },
      (err: unknown) => err as FabricCallerError,
    );

  it("needs a URL, and says where it comes from", async () => {
    vi.stubEnv("NATS_URL", "");
    const err = await failure(fabricCaller({ creds: ERIN }));
    expect(err).toBeInstanceOf(FabricCallerError);
    expect(err.reason).toBe("config");
    expect(err.message).toContain("the URL the console showed next to your creds file");
  });

  it("needs a creds file", async () => {
    const err = await failure(fabricCaller({ creds: "", url: "nats://127.0.0.1:1" }));
    expect(err.reason).toBe("config");
    expect(err.message).toContain("NATS_CREDS");
  });

  it("takes the URL from NATS_URL when none is given", async () => {
    vi.stubEnv("NATS_URL", "nats://127.0.0.1:1");
    const err = await failure(fabricCaller({ creds: ERIN }));
    expect(err.reason).toBe("connect");
    expect(err.message).toContain("could not connect to nats://127.0.0.1:1");
  });

  it("prefers the option to NATS_URL", async () => {
    vi.stubEnv("NATS_URL", "nats://127.0.0.1:1");
    const err = await failure(fabricCaller({ creds: ERIN, url: "nats://127.0.0.1:2" }));
    expect(err.message).toContain("could not connect to nats://127.0.0.1:2");
  });

  it("reads NATS_CREDS and NATS_URL from the environment", async () => {
    vi.stubEnv("NATS_CREDS", "");
    vi.stubEnv("NATS_URL", "nats://127.0.0.1:1");
    expect((await failure(fabricCallerFromEnv())).reason).toBe("config");
    vi.stubEnv("NATS_CREDS", ERIN);
    const err = await failure(fabricCallerFromEnv());
    expect(err.reason).toBe("connect");
    expect(err.message).toContain("nats://127.0.0.1:1");
  });

  it("refuses an edge subject that can never be published to, before connecting", async () => {
    await expect(
      fabricCaller({ creds: ERIN, url: "nats://127.0.0.1:1", edgeSubject: "a..b" }),
    ).rejects.toThrow(/edgeSubject/);
  });
});
