// ScratchPad for PI's model (`docs/plugins.md` §9): the environment the
// skill's `scripts/sp` reads, set in PI's process, which PI's bash tool
// passes to every command it runs (measured on PI 0.85.1, §9.4).
//
// At start, once: the connection, the workspace and the volume, from the
// config entry's `options.scratchpad`, else the variables of the same names
// the fabric package reads (`SCRATCHPAD_VOLUME`, `SCRATCHPAD_DIR`,
// `NATS_URL`, `NATS_CREDS`), else, for the connection, the plugin's own NATS
// context, which `sp` cannot read: its URL and credentials file. `sp` must
// connect as the plugin does, since a caller grants read to the agent it
// prompted. Without a volume ScratchPad is off and nothing is set.
//
// When the service is up: `SP_CREATOR`, this agent's prompt address, which
// every reference it publishes names as its creator.
//
// Per served prompt, from its hand-over to PI's loop to its end: the prompt's
// trace (`SP_THREAD_ID`, `SP_ROOT_ID`) and its verified caller
// (`SP_CALLER_ACCOUNT`, `SP_CALLER_USER`), the one agent `scripts/sp grant`
// grants to. Process-wide variables are sound here because the plugin hands
// PI one prompt at a time; a command PI runs for local typing during a
// remote turn gets the served prompt's (§7, "PI's turn boundaries").

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  granteeFromIdentity,
  SCRATCHPAD_DIR_VAR,
  SCRATCHPAD_VOLUME_VAR,
  type AgentExtensionContext,
  type ServedRequest,
  type TraceScope,
} from "@synadia-ai/agent-fabric";
import { readContextFile } from "@synadia-ai/agents";

/** The config entry's option that holds ScratchPad's settings. */
export const SCRATCHPAD_OPTION = "scratchpad";

/** The variables `scripts/sp` reads. */
export const SP_VARS = {
  url: "NATS_URL",
  creds: "NATS_CREDS",
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

  let url = pick("url", SP_VARS.url);
  let creds = pick("creds", SP_VARS.creds);
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
  if (url === undefined || creds === undefined) {
    log.warn(
      "agent-fabric: ScratchPad is off: sp needs a NATS URL and a credentials file " +
        "(options.scratchpad, NATS_URL and NATS_CREDS, or a NATS context with both)",
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

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
