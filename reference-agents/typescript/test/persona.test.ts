// The default persona, what the agent's model is told when
// `AGENT_SYSTEM_PROMPT` is unset: plain about the tools, and about how an
// agent is chosen, by what its description says it does.

import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("the default persona", () => {
  const env = { MODEL_PROXY_URL: "http://proxy", MODEL_VIRTUAL_KEY: "vk", MODEL_NAME: "m", NATS_CREDS: "/dev/null" };

  // Word for word the Python agent's (`python/tests/test_persona.py` holds
  // the same text): a model is told the same whichever agent runs it.
  it("names the tools and says how an agent is chosen: by its description", () => {
    expect(loadConfig(env).agent.systemPrompt).toBe(
      "You are a helpful agent on the Synadia Agent Fabric. Answer briefly and clearly, in plain text. " +
        "Your tools reach the other agents: discover_agents lists them, prompt_agent asks one of them to do something. " +
        "Choose an agent by what its description says it does. " +
        "Answer yourself unless the task asks for another agent or clearly needs one; never invent a tool result.",
    );
  });

  it("gives way to AGENT_SYSTEM_PROMPT", () => {
    expect(loadConfig({ ...env, AGENT_SYSTEM_PROMPT: "You are a careful librarian." }).agent.systemPrompt).toBe(
      "You are a careful librarian.",
    );
  });
});
