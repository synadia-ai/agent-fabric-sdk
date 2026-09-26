// prompt.ts — prompt one agent on the fabric from the command line.
//
//   node --env-file=.env --import tsx src/prompt.ts <address or kind> "<the prompt>"
//   npm run prompt -- assistant "say hello"
//
// A caller, not an agent: it connects with the credentials the environment
// names (`NATS_URL` and `NATS_CREDS`, or `NATS_CONTEXT`, or
// `NATS_NKEY_SEED_FILE`, as in `env.example`) and signs the prompt with them,
// so the agent sees a verified sender and can grant it read on what it hands
// back. Tracing is on: the prompt starts a tree of its own, which the
// console shows with the agent's model calls and everything the agent
// delegated. The reply is printed as it streams; a ScratchPad reference at
// its end is repeated on its own line, to paste into the next prompt.
//
//   PROMPT_TIMEOUT_MS   how long to wait for the whole reply; default ten
//                       minutes, because a chain of agents takes minutes

import { connect } from "@nats-io/transport-node";
import { fabricTracing } from "@synadia-ai/agent-fabric";
import { Agents, resolveNatsConnectionBundle, type NatsConnectionSource } from "@synadia-ai/agents";

const [who, ...rest] = process.argv.slice(2);
const text = rest.join(" ");
if (who === undefined || text.length === 0) {
  console.error('usage: prompt.ts <address or agent kind> "<the prompt>"');
  process.exit(2);
}

const env = process.env;
const url = env["NATS_URL"] ?? "nats://127.0.0.1:4222";
let nats: NatsConnectionSource;
if (env["NATS_CONTEXT"]) nats = { context: env["NATS_CONTEXT"] };
else if (env["NATS_CREDS"]) nats = { url, creds: env["NATS_CREDS"] };
else if (env["NATS_NKEY_SEED_FILE"]) nats = { url, nkey: env["NATS_NKEY_SEED_FILE"] };
else {
  console.error("set NATS_CONTEXT, or NATS_CREDS or NATS_NKEY_SEED_FILE (with NATS_URL); see env.example");
  process.exit(2);
}

const bundle = await resolveNatsConnectionBundle(nats, { identity: "signed" });
const nc = await connect(bundle.connectionOptions);
// Tracing on, from the fabric package: outside any served prompt, the
// prompt starts a tree of its own.
const agents = new Agents({ nc, identity: { signer: bundle.signer }, interceptors: [fabricTracing().promptInterceptor] });
try {
  // By address as discovery reports it, or by kind when there is one such agent.
  const found = await agents.discover({ timeoutMs: 1000 });
  const target = found.find((a) => a.promptSubject === who) ?? found.find((a) => a.agent === who);
  if (target === undefined) {
    console.error(`no agent "${who}" on the fabric; there: ${found.map((a) => a.promptSubject).join(", ") || "nobody"}`);
    process.exit(1);
  }
  console.error(`→ ${target.promptSubject} (${target.identity ?? "no identity"}${target.idSigVerified ? ", verified" : ""})`);

  const started = Date.now();
  let reply = "";
  const maxWaitMs = Number(env["PROMPT_TIMEOUT_MS"] ?? 600_000);
  for await (const msg of await target.prompt(text, { maxWaitMs })) {
    if (msg.type === "response") {
      process.stdout.write(msg.text);
      reply += msg.text;
    } else if (msg.type === "query") {
      // The agent asked something mid-reply; a command line has no one to ask.
      await msg.reply("The caller is a command line and cannot answer; continue with your best judgement.");
    }
  }
  process.stdout.write("\n");
  const reference = reply.match(/sp-ref:[A-Za-z0-9_-]+/g)?.at(-1);
  if (reference !== undefined) console.error(`reference: ${reference}`);
  console.error(`${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (err) {
  // The agent refused the prompt or failed while serving it. The protocol
  // carries a code and a few words; the reason is in the agent's own log.
  console.error(`\nno reply: ${err instanceof Error ? err.message : String(err)}; the agent's own output says why`);
  process.exitCode = 1;
} finally {
  await agents.close();
  await nc.close();
  bundle.wipe();
}
