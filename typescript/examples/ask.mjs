// A reply as a string, for a script: ask() waits for the whole reply and
// returns it with the task's root id.
//
//   NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds node ask.mjs writer "Name three rivers."
//
// Install first: npm install @synadia-ai/agent-fabric

import { fabricCallerFromEnv } from "@synadia-ai/agent-fabric";

const [who, ...words] = process.argv.slice(2);
if (who === undefined || words.length === 0) {
  console.error('usage: node ask.mjs <address or kind> "<text>"');
  process.exit(2);
}

const caller = await fabricCallerFromEnv();
try {
  const { text, rootId } = await caller.ask(who, words.join(" "));
  console.log(JSON.stringify({ root: rootId, words: text.split(/\s+/).length, text }));
} finally {
  await caller.close();
}
