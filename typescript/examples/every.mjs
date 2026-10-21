// A list of topics, prompted one after another on an interval: each prompt
// a task of its own, its root id printed with the topic.
//
//   NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds node every.mjs writer 60 "the sea" "the moon"
//
// Install first: npm install @synadia-ai/agent-fabric

import { setTimeout as sleep } from "node:timers/promises";
import { fabricCallerFromEnv } from "@synadia-ai/agent-fabric";

const [who, seconds, ...topics] = process.argv.slice(2);
if (who === undefined || !(Number(seconds) > 0) || topics.length === 0) {
  console.error('usage: node every.mjs <address or kind> <seconds> "<topic>" ...');
  process.exit(2);
}

const caller = await fabricCallerFromEnv();
process.on("SIGINT", () => void caller.close().then(() => process.exit(0)));
for (let i = 0; ; i++) {
  const topic = topics[i % topics.length];
  try {
    const { text, rootId } = await caller.ask(who, `Write two lines about ${topic}.`);
    console.log(`[${topic}] root ${rootId}\n${text}\n`);
  } catch (err) {
    console.error(`[${topic}] no reply: ${err.message}`);
  }
  await sleep(Number(seconds) * 1000);
}
