// config.ts — everything the agent is told, from the environment.
//
// One process, one agent, one set of variables; the file that holds them
// is one `.env` per agent (see `env.example`), read by `dotenv.ts` or by
// Node's `--env-file`, or none when `fabric env` exported them.
// Nothing here is a secret the repository tracks: the credentials file and
// the virtual key are paths and values in that untracked file.

import { readFileSync } from "node:fs";
import type { NatsConnectionSource } from "@synadia-ai/agents";
import { cleanDescription, DESCRIPTION_LIMIT } from "./description.js";

/**
 * Which of the agent tools the model is offered (`tools.ts` has the
 * names):
 *
 * - `blocking`, the default: `discover_agents`, `prompt_agent` and
 *   `answer_agent`. Every prompt to another agent waits for its reply.
 * - `all`: the six, for a model that runs prompts side by side and
 *   collects them later.
 * - `none`: no tools, for a role that must answer itself (a researcher
 *   or a writer another agent delegates to) on a model that would rather
 *   delegate whatever it is asked, even back to its caller. The agent
 *   still has the capability; the operator has taken it off the table.
 */
export type ToolsSetting = "blocking" | "all" | "none";

export interface AgentConfig {
  /** Where and as whom to connect; the same credentials sign the agent's identity. */
  readonly nats: NatsConnectionSource;
  readonly agent: {
    /** `metadata.agent`, the kind of agent: `assistant`, `researcher`, `writer`. */
    readonly kind: string;
    readonly owner: string;
    /** The instance name; several agents of one kind and owner differ here. */
    readonly name: string;
    /**
     * What the agent does, as discovery shows it to the other agents, which
     * choose whom to ask by it (`AGENT_DESCRIPTION`): one line of plain text
     * (`description.ts`), or `<kind> agent (<model>)` when none is given.
     */
    readonly description: string;
    readonly systemPrompt: string;
    /** `any` serves everyone; `signed` refuses prompts without a verified signature. */
    readonly minSenderTrust: "any" | "signed";
    /** Which of the agent tools the model is offered (`AGENT_TOOLS`; see {@link ToolsSetting}). */
    readonly tools: ToolsSetting;
    readonly heartbeatIntervalS: number | undefined;
    /** How many user/assistant exchanges the agent remembers for each verified caller; 0 for none. */
    readonly maxHistoryExchanges: number;
    /** When set, a JSON line about the running instance is written here once the service is up. */
    readonly readyFile: string | undefined;
  };
  readonly model: {
    readonly proxyUrl: string;
    readonly virtualKey: string;
    readonly model: string;
    /** The provider the virtual key names (`MODEL_PROVIDER`); `anthropic` selects Anthropic's Messages API. */
    readonly provider: string | undefined;
    /** Anthropic's `max_tokens` (`MODEL_MAX_TOKENS`); unset, the client's default. */
    readonly maxTokens: number | undefined;
    readonly timeoutMs: number | undefined;
  };
  readonly tools: {
    /** How long one prompt to another agent may run before it is given up (the tools' `maxWaitMs`). */
    readonly replyTimeoutMs: number;
  };
  /**
   * `AGENT_DURABLE=1`: the agent hosts durable workflows, the demo
   * `durable-task`, and offers the model `start_workflow` (`durable.ts`).
   * Off when absent.
   */
  readonly durable?: boolean;
}

const DEFAULTS = {
  natsUrl: "nats://127.0.0.1:4222",
  kind: "assistant",
  name: "main",
  // Plain about the tools without inviting a model to act them out: a
  // small model told "use the tools" tends to write tool results as text.
  systemPrompt:
    "You are a helpful agent on the Synadia Agent Fabric. Answer briefly and clearly, in plain text. " +
    "Your tools reach the other agents: discover_agents lists them, prompt_agent asks one of them to do something. " +
    "Choose an agent by what its description says it does. " +
    "Answer yourself unless the task asks for another agent or clearly needs one; never invent a tool result.",
  minSenderTrust: "any",
  tools: "blocking",
  maxHistoryExchanges: 20,
  replyTimeoutMs: 300_000,
} as const;

/**
 * Read the configuration from `env`. Throws one error naming every
 * variable that is missing, so a first start fails once with the whole
 * list rather than once per variable. `log` gets a line when a value is
 * used changed: a description that had to be cleaned.
 */
export function loadConfig(env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): AgentConfig {
  const missing: string[] = [];
  const need = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing.push(name);
      return "";
    }
    return value;
  };
  const optional = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const number = (name: string, fallback: number): number => {
    const value = optional(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
    return n;
  };
  // A whole number above 0, such as a token count.
  const wholeNumber = (name: string): number => {
    const value = optional(name) ?? "";
    const n = Number(value);
    if (value.trim() === "" || !Number.isInteger(n) || n <= 0) {
      throw new Error(`${name} must be a whole number above 0, got "${value}"`);
    }
    return n;
  };
  // A count that may be 0.
  const count = (name: string, fallback: number): number => {
    const value = optional(name);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (value.trim() === "" || !Number.isInteger(n) || n < 0) {
      throw new Error(`${name} must be a whole number, 0 or more, got "${value}"`);
    }
    return n;
  };

  const proxyUrl = need("MODEL_PROXY_URL");
  const virtualKey = need("MODEL_VIRTUAL_KEY");
  const model = need("MODEL_NAME");

  // Connection: a NATS context by name, or a URL with a credentials file
  // (or an nkey seed file). One of the two credential sources is required,
  // because the agent signs its identity with it.
  let nats: NatsConnectionSource;
  const context = optional("NATS_CONTEXT");
  const creds = optional("NATS_CREDS");
  const nkey = optional("NATS_NKEY_SEED_FILE");
  if (context !== undefined) {
    nats = { context };
  } else if (creds !== undefined) {
    nats = { url: optional("NATS_URL") ?? DEFAULTS.natsUrl, creds };
  } else if (nkey !== undefined) {
    nats = { url: optional("NATS_URL") ?? DEFAULTS.natsUrl, nkey };
  } else {
    missing.push("NATS_CONTEXT, or NATS_CREDS or NATS_NKEY_SEED_FILE (with NATS_URL)");
    nats = { url: DEFAULTS.natsUrl };
  }

  const minSenderTrust = optional("AGENT_MIN_SENDER_TRUST") ?? DEFAULTS.minSenderTrust;
  if (minSenderTrust !== "any" && minSenderTrust !== "signed") {
    throw new Error(`AGENT_MIN_SENDER_TRUST must be "any" or "signed", got "${minSenderTrust}"`);
  }
  const durable = optional("AGENT_DURABLE") ?? "0";
  if (durable !== "0" && durable !== "1") {
    throw new Error(`AGENT_DURABLE must be "0" or "1", got "${durable}"`);
  }
  const toolsSetting = optional("AGENT_TOOLS") ?? DEFAULTS.tools;
  if (toolsSetting !== "blocking" && toolsSetting !== "all" && toolsSetting !== "none") {
    throw new Error(`AGENT_TOOLS must be "blocking", "all" or "none", got "${toolsSetting}"`);
  }

  if (missing.length > 0) {
    throw new Error(`missing configuration: ${missing.join(", ")} (see env.example)`);
  }

  const kind = optional("AGENT_KIND") ?? DEFAULTS.kind;
  const owner = optional("AGENT_OWNER") ?? env["USER"] ?? "anon";
  const name = optional("AGENT_NAME") ?? DEFAULTS.name;
  // The persona: one line in the environment, or a file for a longer one
  // (a role worth a page of instructions).
  const promptFile = optional("AGENT_SYSTEM_PROMPT_FILE");
  const systemPrompt =
    promptFile !== undefined
      ? readFileSync(promptFile, "utf8").trim()
      : (optional("AGENT_SYSTEM_PROMPT") ?? DEFAULTS.systemPrompt);
  // The description: what the other agents read when they choose whom to
  // ask. It is one line of plain text (`description.ts`), so a text that
  // is not is used cleaned, and the log says so. Unset, or with nothing
  // left of it, the agent registers the default.
  const described = optional("AGENT_DESCRIPTION");
  const cleaned = described !== undefined ? cleanDescription(described) : "";
  if (described !== undefined && cleaned !== described) {
    log(
      cleaned === ""
        ? "AGENT_DESCRIPTION holds no text: the default description is used."
        : `AGENT_DESCRIPTION was cleaned: a description is one line of plain text of at most ${DESCRIPTION_LIMIT} characters. ` +
            "A line break, a tab, a control or an invisible character becomes a space (the zero width joiner and non-joiner stay), " +
            `runs of spaces become one, and a longer text is cut to its first ${DESCRIPTION_LIMIT} characters.`,
    );
  }
  const description = cleaned !== "" ? cleaned : `${kind} agent (${model})`;

  return {
    nats,
    agent: {
      kind,
      owner,
      name,
      description,
      systemPrompt,
      minSenderTrust,
      tools: toolsSetting,
      heartbeatIntervalS: optional("AGENT_HEARTBEAT_S") !== undefined ? number("AGENT_HEARTBEAT_S", 30) : undefined,
      maxHistoryExchanges: count("AGENT_MAX_HISTORY", DEFAULTS.maxHistoryExchanges),
      readyFile: optional("AGENT_READY_FILE"),
    },
    model: {
      proxyUrl,
      virtualKey,
      model,
      provider: optional("MODEL_PROVIDER")?.trim().toLowerCase(),
      maxTokens: optional("MODEL_MAX_TOKENS") !== undefined ? wholeNumber("MODEL_MAX_TOKENS") : undefined,
      timeoutMs: optional("MODEL_TIMEOUT_MS") !== undefined ? number("MODEL_TIMEOUT_MS", 120_000) : undefined,
    },
    tools: {
      replyTimeoutMs: number("AGENT_REPLY_TIMEOUT_MS", DEFAULTS.replyTimeoutMs),
    },
    durable: durable === "1",
  };
}
