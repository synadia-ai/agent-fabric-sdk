// An agent may ask a question before it answers. onQuery answers it: here
// from the terminal, one line per question.
//
//   NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds node answer-questions.mjs writer "Write me a poem."
//
// Install first: npm install @synadia-ai/agent-fabric

import { createInterface } from "node:readline";
import { fabricCallerFromEnv } from "@synadia-ai/agent-fabric";

const [who, ...words] = process.argv.slice(2);
if (who === undefined || words.length === 0) {
  console.error('usage: node answer-questions.mjs <address or kind> "<text>"');
  process.exit(2);
}

// One line per answer, read as it comes: stdin may be a terminal or a pipe.
const terminal = createInterface({ input: process.stdin });
const lines = terminal[Symbol.asyncIterator]();
const caller = await fabricCallerFromEnv();
try {
  const { text } = await caller.ask(who, words.join(" "), {
    onQuery: async (query) => {
      process.stderr.write(`${query.prompt}\n> `);
      const next = await lines.next();
      return next.done ? "" : next.value;
    },
  });
  console.log(text);
} finally {
  terminal.close();
  await caller.close();
}
