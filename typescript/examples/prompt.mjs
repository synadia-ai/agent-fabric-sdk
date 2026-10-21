// One prompt: the reply streamed as it comes, then the root id of the task
// it started, which is how the console finds that task.
//
//   NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds node prompt.mjs writer "Say hello."
//
// Install first: npm install @synadia-ai/agent-fabric

import { fabricCallerFromEnv } from "@synadia-ai/agent-fabric";

const [who, ...words] = process.argv.slice(2);
if (who === undefined || words.length === 0) {
  console.error('usage: node prompt.mjs <address or kind> "<text>"');
  process.exit(2);
}

const caller = await fabricCallerFromEnv();
try {
  const { stream, rootId } = await caller.prompt(who, words.join(" "));
  for await (const msg of stream) {
    if (msg.type === "response") process.stdout.write(msg.text);
  }
  console.log(`\nroot ${await rootId}`);
} finally {
  await caller.close();
}
