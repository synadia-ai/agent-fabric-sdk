// main.ts — start one agent from the environment and run until told to stop.
//
//   node --env-file=.env --import tsx src/main.ts      (or: npm start)
//
// `env.example` lists every variable.

import { startAgent } from "./agent.js";
import { loadConfig } from "./config.js";

const cfg = loadConfig(process.env);
const agent = await startAgent(cfg);
console.log(`${cfg.agent.kind} agent listening on ${agent.address}`);
console.log(`identity: ${agent.identity ?? "none"}`);
console.log(`model: ${cfg.model.model} through ${cfg.model.proxyUrl}`);
console.log(`scratchpad: ${process.env["SCRATCHPAD_VOLUME"] || "off"}`);
console.log("press Ctrl+C to stop (the conversation lives in memory and is gone on restart)");

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
