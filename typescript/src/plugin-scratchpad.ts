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
// removed with a note for any other (`ScratchPadHandOn`). And it answers
// grant requests for what it published, as an SDK-built agent does
// (`grant-request.ts`): the grants its model made through `scripts/sp`, which
// the extension does not see, are recorded by the wrapper in a file the
// add-on reads (`SP_GRANTS_FILE`, `withRecordedGrants`).
//
// Per served prompt, from when the harness starts working on it to its end:
// the prompt's trace (`SP_THREAD_ID`, `SP_ROOT_ID`) and its verified caller
// (`SP_CALLER_ACCOUNT`, `SP_CALLER_USER`), the one agent `scripts/sp grant`
// grants to (`ServedPromptEnv`). Process-wide variables are sound only for a
// harness that works on one served prompt at a time; each add-on says why
// its harness does.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import type {
  AgentService,
  RequestInterceptor,
  RequestInterceptorContext,
} from "@synadia-ai/agent-service";
import {
  readContextFile,
  SILENT_LOGGER,
  type Agent,
  type Agents,
  type AgentToolsExtension,
  type AgentToolsPromptContext,
  type AgentToolsPromptRewrite,
  type AgentToolsReplyContext,
  type Logger,
} from "@synadia-ai/agents";
import { grantRequestEndpoint } from "./grant-request.js";
import type { AgentExtensionContext, ServedRequest } from "./plugin-contract.js";
import {
  findReferences,
  granteeFromIdentity,
  readsReferences,
  type GrantKind,
  type Grantee,
  type ScratchPad,
  type TraceIds,
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
  grants: "SP_GRANTS_FILE",
} as const;

/** What ScratchPad was resolved to at start. */
export interface ScratchPadSettings {
  readonly url: string;
  readonly creds: string;
  readonly volume: string;
  /** Unset when neither a setting nor the plugin's state directory gives one. */
  readonly dir?: string;
  /**
   * The file `scripts/sp` records its grants in, beside the workspace:
   * `<dir>.grants`. Unset without a workspace, and then the grants the
   * model makes do not entitle anyone to a grant request.
   */
  readonly grants?: string;
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
  const grants = dir !== undefined ? `${dir}.grants` : undefined;
  if (grants !== undefined) pruneRecordedGrants(grants, log);
  return {
    url,
    creds: expandHome(creds),
    volume,
    ...(dir !== undefined ? { dir } : {}),
    ...(grants !== undefined ? { grants } : {}),
  };
}

/** Sets the start-time variables. */
export function exportScratchPad(settings: ScratchPadSettings, env: Env): void {
  env[SP_VARS.url] = settings.url;
  env[SP_VARS.creds] = settings.creds;
  env[SP_VARS.volume] = settings.volume;
  if (settings.dir !== undefined) env[SP_VARS.dir] = settings.dir;
  if (settings.grants !== undefined) env[SP_VARS.grants] = settings.grants;
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

  /**
   * Builds the extension, once the plugin's client is on the bus. Given the
   * plugin's service, also answers grant requests for what this agent
   * published, on the endpoint an SDK-built agent serves them on
   * (`grantRequestEndpoint`), added through the service's own
   * `addEndpoint`, since the plugin builds its service before the add-on
   * could name an extra endpoint. Several instances of one agent share the
   * work, as an SDK-built agent's do.
   */
  start(options: {
    readonly scratchPad: ScratchPad;
    readonly agents: Agents;
    readonly service?: AgentService;
    readonly logger?: Logger;
  }): void {
    const { scratchPad, agents, service } = options;
    this.#scratchPad = scratchPad;
    this.#inner = scratchPadExtension({ scratchPad, agents });
    for (const text of this.#early.splice(0)) this.#inner.remember(text);
    if (service === undefined) return;
    const logger = options.logger ?? SILENT_LOGGER;
    const ep = grantRequestEndpoint({
      promptAddress: service.subject.prompt,
      scratchPad,
      logger,
    });
    try {
      service.service.addEndpoint(ep.name, {
        subject: ep.subject,
        ...(ep.queue !== undefined ? { queue: ep.queue } : {}),
        handler: ep.handler,
      });
    } catch (err) {
      logger.warn(`agent-fabric: grant requests are not answered: ${String(err)}`);
    }
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

/**
 * The ScratchPad port over the add-on's packaged sp, for its own grants and
 * the grant requests it answers, with the grants `scripts/sp` recorded.
 */
export function spPort(
  settings: ScratchPadSettings,
  creator: string,
  env: Env,
  skillDir: string,
): ScratchPad | undefined {
  const bin = spBinary(env, skillDir);
  if (bin === undefined) return undefined;
  const port = spCliScratchPad({
    volume: settings.volume,
    nats: { url: settings.url, creds: settings.creds },
    bin,
    creator,
    ...(settings.dir !== undefined ? { dir: settings.dir } : {}),
  });
  return settings.grants !== undefined ? withRecordedGrants(port, settings.grants) : port;
}

// The grants `scripts/sp` made, one line each, appended by the wrapper after
// sp confirmed the grant: `<expires_at> <account> <user> <reference>`, the
// expiry in seconds since the epoch as sp reported it, the grantee the
// served prompt's verified caller, the reference as it was granted on.

/** One grant `scripts/sp` recorded. */
export interface RecordedGrant {
  readonly expiresAt: number;
  readonly grantee: Grantee;
  readonly reference: string;
}

const RECORDED_LINE = /^(\d+) (\S+) (\S+) (sp-(?:ref|r1):[A-Za-z0-9_-]+)$/;

/** The grants recorded in `file`; none when it does not exist. Malformed lines are skipped. */
export function readRecordedGrants(file: string): RecordedGrant[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const grants: RecordedGrant[] = [];
  for (const line of text.split("\n")) {
    const m = RECORDED_LINE.exec(line);
    if (m === null) continue;
    grants.push({
      expiresAt: Number(m[1]),
      grantee: { account: m[2] as string, user: m[3] as string },
      reference: m[4] as string,
    });
  }
  return grants;
}

// At start, before the model runs: the file keeps only what is still live.
function pruneRecordedGrants(file: string, log: Logger): void {
  const t = Math.floor(Date.now() / 1000);
  const live = readRecordedGrants(file).filter((g) => g.expiresAt > t);
  try {
    const staging = `${file}.${process.pid}.tmp`;
    writeFileSync(
      staging,
      live
        .map((g) => `${g.expiresAt} ${g.grantee.account} ${g.grantee.user} ${g.reference}\n`)
        .join(""),
      { mode: 0o600 },
    );
    renameSync(staging, file);
  } catch (err) {
    log.warn(`agent-fabric: ScratchPad grants file ${file} could not be written (${String(err)})`);
  }
}

/**
 * `port`, whose ledger also holds the grants `scripts/sp` recorded in `file`.
 * The wrapper grants only to the served prompt's caller, the agent the
 * harness's model handed its reply to, so each is first-hand, as an
 * SDK-built agent's grant to the caller of its reply is: its holder may ask
 * for one more agent. A first-hand grant of the port's own comes first;
 * the port's answer stands when nothing live is recorded. The reference
 * must be the one granted on, token for token, as the requester was given
 * it. `now` is seconds since the epoch.
 */
export function withRecordedGrants(
  port: ScratchPad,
  file: string,
  now: () => number = () => Date.now() / 1000,
): ScratchPad {
  return {
    ...(port.resolveReference
      ? {
          resolveReference: (reference: string, trace?: TraceIds) =>
            port.resolveReference!(reference, trace),
        }
      : {}),
    owns: (reference) => port.owns(reference),
    grantRead: (reference, grantee, trace, toolCallId, kind) =>
      port.grantRead(reference, grantee, trace, toolCallId, kind),
    async granted(reference, grantee): Promise<GrantKind | undefined> {
      const own = await port.granted(reference, grantee);
      if (own === "first-hand") return own;
      const t = now();
      const recorded = readRecordedGrants(file).some(
        (g) =>
          g.reference === reference &&
          g.grantee.account === grantee.account &&
          g.grantee.user === grantee.user &&
          g.expiresAt > t,
      );
      return recorded ? "first-hand" : own;
    },
  };
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
