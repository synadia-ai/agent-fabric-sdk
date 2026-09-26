// echo.ts — the smallest agent on the fabric: it answers every prompt with
// "echo: <the prompt>". No model, no tools, no ScratchPad.
//
//   node --env-file=.env --import tsx src/echo.ts      (or: npm run echo)
//
// The first step of the getting-started walkthrough
// (`docs/getting-started/typescript.md`). It shows the first of the four
// behaviours on its own: the agent receives prompts through the SDK's host
// side, with a signed identity. Everything else `agent.ts` does is this,
// plus more. It reads four variables of the agent's `.env`: NATS_URL,
// NATS_CREDS, AGENT_OWNER, AGENT_NAME.

import { connect } from "@nats-io/transport-node";
import { activeTrace, fabricTracing } from "@synadia-ai/agent-fabric";
import { AgentService } from "@synadia-ai/agent-service";
import { formatSender, resolveNatsConnectionBundle } from "@synadia-ai/agents";

const url = process.env["NATS_URL"] ?? "nats://127.0.0.1:4222";
const creds = process.env["NATS_CREDS"];
if (creds === undefined) throw new Error("NATS_CREDS: the agent's credentials file is required");

// One credentials file gives both the connection and the signer, so the
// identity the agent registers is the identity the connection logged in with.
const bundle = await resolveNatsConnectionBundle({ url, creds }, { identity: "signed" });
const nc = await connect(bundle.connectionOptions);

// Tracing on, from the fabric package: a prompt from a tracing caller is a
// thread in the console.
const tracing = fabricTracing();

const service = new AgentService({
  nc,
  // The three parts of the address: agents.prompt.echo.<owner>.<name>.
  agent: "echo",
  owner: process.env["AGENT_OWNER"] ?? process.env["USER"] ?? "anon",
  name: process.env["AGENT_NAME"] ?? "main",
  description: "Answers every prompt with the prompt",
  // Signed: discovery shows this agent's identity as verified, and the
  // console lists the agent under it.
  identity: { signer: bundle.signer },
  interceptors: [tracing.requestInterceptor],
  heartbeatExtras: tracing.heartbeatExtras,
});

// The whole agent. Every prompt runs this handler; what it sends is streamed
// back to the caller.
service.onPrompt(async (envelope, response) => {
  const thread = activeTrace()?.threadId.slice(0, 8) ?? "untraced";
  console.log(`[${thread}] prompt from ${formatSender(response.sender)}: ${envelope.prompt}`);
  await response.send(`echo: ${envelope.prompt}`);
});

await service.start();
console.log(`echo agent listening on ${service.subject.prompt}`);
console.log(`identity: ${service.identity ?? "none"}`);
console.log("press Ctrl+C to stop");

const shutdown = async (): Promise<void> => {
  await service.stop();
  await nc.close();
  bundle.wipe();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
