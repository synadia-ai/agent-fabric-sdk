// ScratchPad for a harness's model (`docs/plugins.md` §9), what every add-on
// under `plugins/` shares: the environment the skill's `scripts/sp` reads,
// set in the harness's process, which its shell tool passes to every command
// it runs (PI's measured, OpenClaw's read in its code; §9.4), and the
// ScratchPad extension for the plugin's agent tools. TypeScript only, like
// the rest of the plugins' contract: none of it is wire.
//
// At start, once: the connection, the workspace and the volume, from the
// config entry's `options.scratchpad`, else the variables of the same names
// the package reads (`SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR`, `NATS_URL`,
// `NATS_CREDS`), else, for the connection, the plugin's own: its NATS
// context, which `sp` cannot read (PI's, Claude Code's), or the `url` and
// `credentials` of its configuration (OpenClaw's account block). `sp` must
// connect as the plugin does, since a caller grants read to the agent it
// prompted.
// Without a volume ScratchPad is off and nothing is set.
//
// When the service is up: `SP_CREATOR`, the agent's prompt address, which
// every reference it publishes names as its creator.
//
// The registration says the harness reads references (`scratchpad_refs_ok`),
// so a caller's `prompt_agent` hands them to it. And references its model
// puts into its own `prompt_agent` go through the ScratchPad extension, as
// an SDK-built agent's do: granted to a receiver that reads references,
// removed with a note for any other (`ScratchPadHandOn`).
//
// Per served prompt, from when the harness starts working on it to its end:
// the prompt's trace (`SP_THREAD_ID`, `SP_ROOT_ID`) and its verified caller
// (`SP_CALLER_ACCOUNT`, `SP_CALLER_USER`), the one agent `scripts/sp grant`
// grants to (`ServedPromptEnv`). Process-wide variables are sound only for a
// harness that works on one served prompt at a time; each add-on says why
// its harness does.

import { mkdirSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type { RequestInterceptor, RequestInterceptorContext } from "@synadia-ai/agent-service";
import {
  readContextFile,
  type Agent,
  type Agents,
  type AgentToolsExtension,
  type AgentToolsPromptContext,
  type AgentToolsPromptRewrite,
  type AgentToolsReplyContext,
} from "@synadia-ai/agents";
import type { AgentExtensionContext, ServedRequest } from "./plugin-contract.js";
import {
  findReferences,
  granteeFromIdentity,
  readsReferences,
  type ScratchPad,
} from "./scratchpad.js";
import {
  SCRATCHPAD_BIN_VAR,
  SCRATCHPAD_DIR_VAR,
  SCRATCHPAD_VOLUME_VAR,
  spCliScratchPad,
} from "./scratchpad-cli.js";
import {
  READS_SCRATCHPAD_REFERENCES_FIELD,
  scratchPadExtension,
  type ScratchPadExtension,
} from "./scratchpad-extension.js";
import type { TraceScope } from "./trace.js";

/** The config entry's option that holds ScratchPad's settings. */
export const SCRATCHPAD_OPTION = "scratchpad";

/**
 * The variables `scripts/sp` reads. The connection has names of its own,
 * not `NATS_URL` and `NATS_CREDS`, which a plugin may read as its own
 * connection (OpenClaw's does) and which the add-on therefore never sets.
 */
export const SP_VARS = {
  url: "SP_NATS_URL",
  creds: "SP_NATS_CREDS",
  dir: SCRATCHPAD_DIR_VAR,
  volume: SCRATCHPAD_VOLUME_VAR,
  creator: "SP_CREATOR",
  threadId: "SP_THREAD_ID",
  rootId: "SP_ROOT_ID",
  callerAccount: "SP_CALLER_ACCOUNT",
  callerUser: "SP_CALLER_USER",
} as const;

/** What ScratchPad was resolved to at start. */
export interface ScratchPadSettings {
  readonly url: string;
  readonly creds: string;
  readonly volume: string;
  /** Unset when neither a setting nor the plugin's state directory gives one. */
  readonly dir?: string;
}

type Env = Record<string, string | undefined>;

/**
 * ScratchPad's settings as the options, the environment and the plugin's
 * NATS context give them, or `undefined` when ScratchPad is off: no volume,
 * or a connection `sp` cannot use, which is logged.
 */
export async function resolveScratchPad(
  ctx: AgentExtensionContext,
  env: Env,
): Promise<ScratchPadSettings | undefined> {
  const log = ctx.logger;
  const raw = ctx.options[SCRATCHPAD_OPTION];
  const options: Readonly<Record<string, unknown>> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pick = (option: string, variable: string): string | undefined => {
    const fromOptions = options[option];
    if (typeof fromOptions === "string" && fromOptions !== "") return fromOptions;
    const fromEnv = env[variable];
    return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
  };

  const volume = pick("volume", SP_VARS.volume);
  if (volume === undefined) return undefined;

  let url = pick("url", "NATS_URL");
  let creds = pick("creds", "NATS_CREDS");
  if (url === undefined || creds === undefined) {
    const context = env["NATS_CONTEXT"] || stringOf(ctx.settings.config["context"]);
    if (context !== undefined) {
      try {
        const { fields } = await readContextFile(context);
        url ??= stringOf(fields["url"]);
        creds ??= stringOf(fields["creds"]);
      } catch (err) {
        log.warn(
          `agent-fabric: ScratchPad is off: the NATS context "${context}" could not be read (${String(err)})`,
        );
        return undefined;
      }
    }
  }
  // A plugin that connects without a context names the two in its own
  // configuration: OpenClaw's account block has `url` and `credentials`.
  url ??= stringOf(ctx.settings.config["url"]);
  creds ??= stringOf(ctx.settings.config["credentials"]);
  if (url === undefined || creds === undefined) {
    log.warn(
      "agent-fabric: ScratchPad is off: sp needs a NATS URL and a credentials file " +
        "(options.scratchpad, NATS_URL and NATS_CREDS, a NATS context with both, " +
        "or url and credentials in the plugin's configuration)",
    );
    return undefined;
  }

  let dir = pick("dir", SP_VARS.dir);
  if (dir === undefined && ctx.settings.stateDir !== undefined) {
    dir = join(ctx.settings.stateDir, "scratchpad");
  }
  if (dir !== undefined) {
    dir = resolve(expandHome(dir));
    try {
      // sp requires the workspace directory to exist.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      log.warn(`agent-fabric: ScratchPad workspace ${dir} could not be created (${String(err)})`);
    }
  }
  return { url, creds: expandHome(creds), volume, ...(dir !== undefined ? { dir } : {}) };
}

/** Sets the start-time variables. */
export function exportScratchPad(settings: ScratchPadSettings, env: Env): void {
  env[SP_VARS.url] = settings.url;
  env[SP_VARS.creds] = settings.creds;
  env[SP_VARS.volume] = settings.volume;
  if (settings.dir !== undefined) env[SP_VARS.dir] = settings.dir;
}

/**
 * The per-prompt variables, keyed to one request at a time: `enter` sets
 * them for a request, `leave` clears them only if that request still holds
 * them, so the end of a prompt never clears the next one's.
 */
export class ServedPromptEnv {
  #holder: string | undefined;

  constructor(private readonly env: Env) {}

  enter(request: ServedRequest, scope: TraceScope | undefined): void {
    this.#clear();
    this.#holder = request.id;
    if (scope !== undefined) {
      this.env[SP_VARS.threadId] = scope.threadId;
      this.env[SP_VARS.rootId] = scope.rootId;
    }
    if (request.caller !== undefined) {
      try {
        const grantee = granteeFromIdentity(request.caller);
        this.env[SP_VARS.callerAccount] = grantee.account;
        this.env[SP_VARS.callerUser] = grantee.user;
      } catch {
        // Not an `<account>.<user>` identity: no grant for this caller.
      }
    }
  }

  leave(request: ServedRequest): void {
    if (this.#holder === request.id) {
      this.#clear();
      this.#holder = undefined;
    }
  }

  #clear(): void {
    delete this.env[SP_VARS.threadId];
    delete this.env[SP_VARS.rootId];
    delete this.env[SP_VARS.callerAccount];
    delete this.env[SP_VARS.callerUser];
  }
}

/**
 * The sp binary an add-on ships for this machine in `skillDir` (its
 * `skill/scratchpad`), or `SCRATCHPAD_BIN`; `undefined` on a platform it is
 * not built for. The add-on's own grants run it directly, with the flags
 * `scripts/sp` would add.
 */
export function spBinary(env: Env, skillDir: string): string | undefined {
  const own = env[SCRATCHPAD_BIN_VAR];
  if (own !== undefined && own !== "") return own;
  const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : undefined;
  const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "amd64" : undefined;
  if (os === undefined || cpu === undefined) return undefined;
  return join(skillDir, "bin", `sp-${os}-${cpu}`);
}

/**
 * The fabric package's ScratchPad extension, for the plugin's `AgentTools`
 * and its service, before it can exist: it needs the plugin's `Agents`
 * client and this agent's address, which arrive in `started()`, after the
 * factory returned its hooks. Until then it keeps the prompts it serves, to
 * remember their references once it is built.
 *
 * One addition to the extension: the harness's model publishes with
 * `scripts/sp`, which the extension does not see, and the extension hands on
 * only what the agent was given. So a reference into its own volume is remembered as
 * given before the prompt rewrite looks, exactly as an SDK-built agent
 * remembers what it commits.
 */
export class ScratchPadHandOn implements AgentToolsExtension {
  #inner: ScratchPadExtension | undefined;
  #scratchPad: ScratchPad | undefined;
  readonly #early: string[] = [];

  readonly requestInterceptor: RequestInterceptor = {
    aroundRequest: (ctx: RequestInterceptorContext, next: () => Promise<void>) => {
      if (this.#inner === undefined) this.#early.push(ctx.envelope.prompt);
      else this.#inner.remember(ctx.envelope.prompt);
      return next();
    },
  };

  /** Builds the extension, once the plugin's client is on the bus. */
  start(options: { readonly scratchPad: ScratchPad; readonly agents: Agents }): void {
    this.#scratchPad = options.scratchPad;
    this.#inner = scratchPadExtension(options);
    for (const text of this.#early.splice(0)) this.#inner.remember(text);
  }

  discoveryFields(agent: Agent): Record<string, unknown> {
    return (
      this.#inner?.discoveryFields(agent) ?? {
        [READS_SCRATCHPAD_REFERENCES_FIELD]: readsReferences(agent.metadata),
      }
    );
  }

  async beforePrompt(ctx: AgentToolsPromptContext): Promise<AgentToolsPromptRewrite | void> {
    const inner = this.#inner;
    const scratchPad = this.#scratchPad;
    if (inner === undefined || scratchPad === undefined) {
      if (findReferences(ctx.prompt).length === 0) return;
      return {
        error: "the prompt was not sent: ScratchPad is not ready yet; try again in a moment",
      };
    }
    for (const reference of new Set(findReferences(ctx.prompt))) {
      if (await scratchPad.owns(reference)) inner.remember(reference);
    }
    return inner.beforePrompt(ctx);
  }

  afterReply(ctx: AgentToolsReplyContext): void {
    this.#inner?.afterReply(ctx);
  }
}

/** The ScratchPad port over the add-on's packaged sp, for its own grants. */
export function spPort(
  settings: ScratchPadSettings,
  creator: string,
  env: Env,
  skillDir: string,
): ScratchPad | undefined {
  const bin = spBinary(env, skillDir);
  if (bin === undefined) return undefined;
  return spCliScratchPad({
    volume: settings.volume,
    nats: { url: settings.url, creds: settings.creds },
    bin,
    creator,
    ...(settings.dir !== undefined ? { dir: settings.dir } : {}),
  });
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
