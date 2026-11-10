// durable-main.ts — start the durable agent from the environment and run
// until told to stop.
//
//   node --import tsx src/durable-main.ts   (or: npm run start:durable)
//
// The same variables as `main.ts` (`env.example`). The connection must reach a
// durable engine on `de.api.v1.*` (on the fabric, the tenant's import); the
// agent creates nothing.

import "./dotenv.js";
import { scratchpadLine } from "./agent.js";
import { startDurableAgent } from "./durable-agent.js";
import { loadConfig } from "./config.js";
import { apiOf } from "./model.js";

const cfg = loadConfig(process.env);
const agent = await startDurableAgent(cfg);
console.log(`${cfg.agent.kind} durable agent listening on ${agent.address}`);
// What discovery shows the other agents, which choose whom to ask by it.
console.log(`description: ${cfg.agent.description}`);
console.log(`identity: ${agent.identity ?? "none"}`);
console.log(`model: ${cfg.model.model} through ${cfg.model.proxyUrl}, on ${apiOf(cfg.model.provider)}`);
console.log(`scratchpad: ${scratchpadLine(agent.scratchpad, process.env)}`);
console.log("the model loop is the workflow agent-loop: a run survives a restart of this process");

let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  console.log("\nshutting down…");
  await agent.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
