// The cross-language CLI fixture has a fake sp store and no native service.
// Select its public adapter explicitly through the reference agent's test hook.
import { AgentSubject } from "@synadia-ai/agents";
import { scratchPadFromEnv } from "@synadia-ai/agent-fabric";
import { startAgent } from "../../src/agent.js";
import { loadConfig } from "../../src/config.js";

const config = loadConfig(process.env);
const creator = AgentSubject.new(config.agent.kind, config.agent.owner, config.agent.name).prompt;
const scratchpad = scratchPadFromEnv(process.env, { creator, nats: config.nats });
if (scratchpad === undefined) throw new Error("CLI fixture requires explicit ScratchPad configuration");
const agent = await startAgent(config, console.log, { scratchpad });
console.log(`CLI fixture agent listening on ${agent.address}`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await agent.stop();
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
