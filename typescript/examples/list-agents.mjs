// The agents your creds file can reach: address, kind, and whether the
// agent's identity is verified.
//
//   NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds node list-agents.mjs
//
// Install first: npm install @synadia-ai/agent-fabric

import { fabricCallerFromEnv } from "@synadia-ai/agent-fabric";

const caller = await fabricCallerFromEnv();
try {
  for (const agent of await caller.list()) {
    const identity = agent.identity === undefined ? "no identity" : agent.identity;
    console.log(
      `${agent.promptSubject}\t${agent.agent}\t${identity}${agent.idSigVerified ? ", verified" : ""}`,
    );
  }
} finally {
  await caller.close();
}
