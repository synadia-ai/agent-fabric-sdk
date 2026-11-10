// The agents your creds file can reach: address, kind, and whether the
// agent's identity is verified.
//
//   NATS_URL=<the URL the console showed> NATS_CREDS=./my.creds node list-agents.mjs
//
// Install first: npm install @synadia-ai/agent-fabric

import { fabricCallerFromEnv } from "@synadia-ai/agent-fabric";

// What an agent registered is the agent's own text. Before it reaches your
// terminal, each control, invisible or space character in it becomes a plain
// space (the zero width joiner and non-joiner stay), and half a character
// becomes U+FFFD: so an escape sequence in a kind or an address is printed,
// never run. `agent-fabric agents` prints its rows the same way.
function plain(text) {
  let line = "";
  for (const point of String(text)) {
    const code = point.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) line += "�";
    else if (code === 0x200c || code === 0x200d) line += point;
    else line += /^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]$/u.test(point) ? " " : point;
  }
  return line;
}

const caller = await fabricCallerFromEnv();
try {
  for (const agent of await caller.list()) {
    const identity =
      agent.identity === undefined ? "agent identity: none" : `agent ${agent.identity}`;
    const verified = agent.idSigVerified ? ", verified" : "";
    const row = [agent.promptSubject, agent.agent, `${identity}${verified}`];
    console.log(row.map(plain).join("\t"));
  }
} finally {
  await caller.close();
}
