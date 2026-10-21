// prompt.ts — prompt one agent on the fabric from the command line.
//
//   node --import tsx src/prompt.ts <address or kind> "<the prompt>"
//   npm run prompt -- assistant "say hello"
//
// A caller, not an agent: `fabricCaller()` from the fabric package connects
// with the creds file the environment names (`NATS_URL` and `NATS_CREDS`, as
// in `env.example`) and signs the prompt with it, so the agent sees a
// verified sender and can grant it read on what it hands back. Tracing is
// on: the prompt starts a tree of its own, which the console shows with the
// agent's model calls and everything the agent delegated; its root id is
// printed. The reply is printed as it streams; a ScratchPad reference at its
// end is repeated on its own line, to paste into the next prompt. The
// package's own command, `agent-fabric prompt`, does the same.
//
//   PROMPT_TIMEOUT_MS   how long to wait for the whole reply; default ten
//                       minutes, because a chain of agents takes minutes

import "./dotenv.js";
import {
  CANNOT_ANSWER,
  FabricCallerError,
  fabricCaller,
  findReferences,
  type FabricCaller,
} from "@synadia-ai/agent-fabric";

const [who, ...rest] = process.argv.slice(2);
const text = rest.join(" ");
if (who === undefined || text.length === 0) {
  console.error('usage: prompt.ts <address or agent kind> "<the prompt>"');
  process.exit(2);
}

const env = process.env;
const creds = env["NATS_CREDS"];
if (!creds) {
  console.error("set NATS_CREDS (with NATS_URL) to the caller's creds file; see env.example");
  process.exit(2);
}

let caller: FabricCaller;
try {
  caller = await fabricCaller({ creds, url: env["NATS_URL"] ?? "nats://127.0.0.1:4222" });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
try {
  // By address as discovery reports it, or by kind when there is one such agent.
  const target = await caller.find(who);
  // The agent's own registered identity, not this prompt's signature.
  const identity = target.identity === undefined ? "agent identity: none" : `agent ${target.identity}${target.idSigVerified ? ", verified" : ""}`;
  console.error(`→ ${target.promptSubject} (${identity})`);

  const started = Date.now();
  let reply = "";
  const maxWaitMs = Number(env["PROMPT_TIMEOUT_MS"] ?? 600_000);
  const { stream, rootId } = await caller.prompt(target, text, { maxWaitMs });
  // Printed when known; a prompt that never goes out has no root, and the
  // stream's own error says why.
  rootId.then(
    (root) => console.error(`root ${root}`),
    () => {},
  );
  for await (const msg of stream) {
    if (msg.type === "response") {
      process.stdout.write(msg.text);
      reply += msg.text;
    } else if (msg.type === "query") {
      // The agent asked something mid-reply; a command line has no one to ask.
      await msg.reply(CANNOT_ANSWER);
    }
  }
  process.stdout.write("\n");
  const reference = findReferences(reply).at(-1);
  if (reference !== undefined) console.error(`reference: ${reference}`);
  console.error(`${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (err) {
  if (err instanceof FabricCallerError) {
    // No such agent, or more than one of that kind: the message names what is there.
    console.error(err.message);
  } else {
    // The agent refused the prompt or failed while serving it. The protocol
    // carries a code and a few words; the reason is in the agent's own log.
    console.error(`\nno reply: ${err instanceof Error ? err.message : String(err)}; the agent's own output says why`);
  }
  process.exitCode = 1;
} finally {
  await caller.close();
}
