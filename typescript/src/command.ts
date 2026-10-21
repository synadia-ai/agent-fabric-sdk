// The `agent-fabric` command: list the agents and prompt one, with the creds
// file the console gave you and nothing else. `cli.ts` runs it; the tests
// call `runCommand` with their own input and output. Mirrors
// `synadia_ai/agent_fabric/cli.py`: the same subcommands, flags, lines and
// exit codes.

import type { Agent } from "@synadia-ai/agents";
import {
  CANNOT_ANSWER,
  FabricCallerError,
  NATS_CREDS_VAR,
  NATS_URL_VAR,
  fabricCaller,
  type FabricCaller,
} from "./caller.js";
import { findReferences } from "./scratchpad.js";

/** Success. */
export const EXIT_OK = 0;
/** No such agent, a refused or failed prompt, or no connection. */
export const EXIT_FAILED = 1;
/** A usage error: a wrong argument, or no creds file or URL. */
export const EXIT_USAGE = 2;

/** How long `prompt` waits for the whole reply, by default, in seconds. */
export const DEFAULT_TIMEOUT_S = 600;

export const USAGE = `usage: agent-fabric agents [options]
       agent-fabric prompt <address or kind> "<text>" [options]

List the agents on the Synadia Agent Fabric, or prompt one, with the creds
file the console gave you. The reply streams to stdout; the server's URL,
the agent, the task's root id and a ScratchPad reference go to stderr. A
question the agent asks is printed on stderr and answered from stdin.

options:
  --creds <file>    the creds file (default: $${NATS_CREDS_VAR})
  --url <url>       the URL the console showed next to your creds file
                    (default: $${NATS_URL_VAR})
  --timeout <s>     how long to wait for the whole reply, in seconds
                    (default: ${DEFAULT_TIMEOUT_S})
  --json            one JSON object on stdout instead of the stream
  -h, --help        this help
  --                the rest is the text, even what starts with -

exit codes: 0 done, 1 no such agent or a refused prompt, 2 usage`;

/** Where the command reads and writes; the process's own in `cli.ts`. */
export interface CommandIO {
  /** Write to stdout. */
  out(text: string): void;
  /** Write to stderr. */
  err(text: string): void;
  /** One line from stdin, without its newline; `null` at its end. */
  readLine(): Promise<string | null>;
  /** The environment: `NATS_CREDS`, `NATS_URL`. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A parsed command line. */
export type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly message: string }
  | {
      readonly kind: "agents" | "prompt";
      readonly who?: string;
      readonly text?: string;
      readonly creds?: string;
      readonly url?: string;
      readonly timeoutS: number;
      readonly json: boolean;
    };

/** Parse the arguments after the command's name. */
export function parseCommand(argv: ReadonlyArray<string>): ParsedCommand {
  const positional: string[] = [];
  let creds: string | undefined;
  let url: string | undefined;
  let timeoutS = DEFAULT_TIMEOUT_S;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      // Everything after it is the text, even what looks like an option.
      positional.push(...argv.slice(i + 1));
      break;
    }
    const [flag, inline] = arg.startsWith("--") ? splitFlag(arg) : [arg, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--json":
        json = true;
        break;
      case "--creds":
      case "--url":
      case "--timeout": {
        const v = value();
        if (v === undefined || v === "") return usage(`${flag} needs a value`);
        if (flag === "--creds") creds = v;
        else if (flag === "--url") url = v;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) {
            return usage(`--timeout must be a positive number of seconds, not "${v}"`);
          }
          timeoutS = n;
        }
        break;
      }
      default:
        if (arg.startsWith("-") && arg !== "-") return usage(`unknown option ${arg}`);
        positional.push(arg);
    }
  }
  const [sub, ...rest] = positional;
  const common = {
    ...(creds !== undefined ? { creds } : {}),
    ...(url !== undefined ? { url } : {}),
    timeoutS,
    json,
  };
  if (sub === undefined) return usage("name a command: agents or prompt");
  if (sub === "help") return { kind: "help" };
  if (sub === "agents") {
    if (rest.length > 0) return usage(`agents takes no arguments, not "${rest.join(" ")}"`);
    return { kind: "agents", ...common };
  }
  if (sub === "prompt") {
    const [who, ...words] = rest;
    const text = words.join(" ");
    if (who === undefined || text.length === 0) {
      return usage('prompt needs an agent and a text: prompt <address or kind> "<text>"');
    }
    return { kind: "prompt", who, text, ...common };
  }
  return usage(`unknown command "${sub}"`);
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function usage(message: string): ParsedCommand {
  return { kind: "usage", message };
}

/** Run the command; resolves with its exit code. */
export async function runCommand(argv: ReadonlyArray<string>, io: CommandIO): Promise<number> {
  const parsed = parseCommand(argv);
  if (parsed.kind === "help") {
    io.out(`${USAGE}\n`);
    return EXIT_OK;
  }
  if (parsed.kind === "usage") {
    io.err(`agent-fabric: ${parsed.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  const creds = parsed.creds ?? io.env[NATS_CREDS_VAR] ?? "";
  const url = parsed.url ?? io.env[NATS_URL_VAR] ?? "";
  if (creds === "") {
    io.err(`agent-fabric: no creds file: pass --creds, or set ${NATS_CREDS_VAR}\n`);
    return EXIT_USAGE;
  }
  if (url === "") {
    io.err(
      `agent-fabric: no server URL: pass --url, or set ${NATS_URL_VAR} to the URL the console showed next to your creds file\n`,
    );
    return EXIT_USAGE;
  }

  io.err(`url ${url}\n`);
  let caller: FabricCaller;
  try {
    caller = await fabricCaller({ creds, url, name: "agent-fabric" });
  } catch (err) {
    io.err(`agent-fabric: ${message(err)}\n`);
    return err instanceof FabricCallerError && err.reason === "config" ? EXIT_USAGE : EXIT_FAILED;
  }
  try {
    if (parsed.kind === "agents") return await listAgents(caller, parsed.json, io);
    return await prompt(caller, parsed.who!, parsed.text!, parsed, io);
  } catch (err) {
    if (err instanceof FabricCallerError) {
      io.err(`agent-fabric: ${err.message}\n`);
    } else {
      // The agent refused the prompt or failed while serving it. The
      // protocol carries a code and a few words; the reason is in the
      // agent's own output.
      io.err(`agent-fabric: no reply: ${message(err)}\n`);
    }
    return EXIT_FAILED;
  } finally {
    await caller.close();
  }
}

/** The JSON shape of one agent in `agents --json`. */
export interface AgentLine {
  readonly address: string;
  readonly kind: string;
  readonly identity: string | null;
  readonly verified: boolean;
  readonly description: string;
}

function agentLine(a: Agent): AgentLine {
  return {
    address: a.promptSubject,
    kind: a.agent,
    identity: a.identity ?? null,
    verified: a.idSigVerified,
    description: a.description,
  };
}

async function listAgents(caller: FabricCaller, json: boolean, io: CommandIO): Promise<number> {
  const seen = new Set<string>();
  const lines: AgentLine[] = [];
  for (const a of await caller.list()) {
    if (seen.has(a.promptSubject)) continue;
    seen.add(a.promptSubject);
    lines.push(agentLine(a));
  }
  lines.sort((x, y) => x.address.localeCompare(y.address));
  if (json) {
    io.out(`${JSON.stringify(lines)}\n`);
    return EXIT_OK;
  }
  if (lines.length === 0) io.err("no agents\n");
  for (const l of lines) io.out(`${l.address}\t${l.kind}\t${describeIdentity(l)}\n`);
  return EXIT_OK;
}

function describeIdentity(l: AgentLine): string {
  if (l.identity === null) return "no identity";
  return l.verified ? `${l.identity}, verified` : l.identity;
}

async function prompt(
  caller: FabricCaller,
  who: string,
  text: string,
  opts: { readonly timeoutS: number; readonly json: boolean },
  io: CommandIO,
): Promise<number> {
  const target = await caller.find(who);
  io.err(`→ ${target.promptSubject} (${describeIdentity(agentLine(target))})\n`);
  const { stream, rootId } = await caller.prompt(target, text, {
    maxWaitMs: Math.round(opts.timeoutS * 1000),
  });
  void rootId.then((root) => io.err(`root ${root}\n`));
  let reply = "";
  for await (const msg of stream) {
    if (msg.type === "response") {
      reply += msg.text;
      if (!opts.json) io.out(msg.text);
    } else if (msg.type === "query") {
      io.err(`? ${msg.prompt}\n`);
      const answer = await io.readLine();
      await msg.reply(answer === null || answer === "" ? CANNOT_ANSWER : answer);
    }
  }
  const root = await rootId;
  const references = findReferences(reply);
  if (opts.json) {
    io.out(`${JSON.stringify({ root, text: reply, references })}\n`);
  } else {
    io.out("\n");
  }
  const last = references.at(-1);
  if (last !== undefined) io.err(`reference: ${last}\n`);
  return EXIT_OK;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
