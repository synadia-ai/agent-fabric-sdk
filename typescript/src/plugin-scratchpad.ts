// ScratchPad for a harness's model (`docs/plugins.md` §9), what every add-on
// under `plugins/` shares: the environment the skill's `scripts/sp` reads,
// set in the harness's process, which its shell tool passes to every command
// it runs (PI's measured, OpenClaw's read in its code; §9.4), and the
// ScratchPad extension for the plugin's agent tools. TypeScript only, like
// the rest of the plugins' contract: none of it is wire.
//
// At start, once: the connection, the workspace and the volume. The volume
// and the workspace from the config entry's `options.scratchpad`, else the
// variables of the same names the package reads (`SCRATCHPAD_VOLUME`,
// `SCRATCHPAD_DIR`). The connection is the one the plugin's channel takes,
// since `sp` must connect as the plugin does (a caller grants read to the
// agent it prompted): `options.scratchpad`'s `url` and `creds` first, field
// by field; then a non-empty `NATS_CONTEXT`'s context; with `NATS_CONTEXT`
// set but empty, or `NATS_URL` or the credentials variable set, the
// variables and never a context; otherwise the context in the plugin's
// config, which `sp` cannot read (PI's, Claude Code's); and last, for what
// is still missing, the `url` and `credentials` of the plugin's
// configuration (OpenClaw's account block).
// Without a volume ScratchPad is off and nothing is set.
//
// When the service is up: `SP_CREATOR`, the agent's prompt address, which
// every reference it publishes names as its creator.
//
// The registration says the harness reads references (`scratchpad_refs_ok`),
// so a caller's `prompt_agent` hands them to it. And references its model
// puts into its own `prompt_agent` go through the ScratchPad extension, as
// an SDK-built agent's do: granted to a receiver that reads references,
// removed with a note for any other, and for every receiver while the add-on
// has no sp (`ScratchPadHandOn`). And it answers
// grant requests for what it published, as an SDK-built agent does
// (`grant-request.ts`): the grants its model made through `scripts/sp`, which
// the extension does not see, are recorded by the wrapper in a file the
// add-on reads (`SP_GRANTS_FILE`, `withRecordedGrants`). Both run the
// add-on's own sp (`findSp`). Without one, nothing can be granted: a
// reference in `prompt_agent` is removed with a note, grant requests go
// unanswered, and one warning says so.
//
// Per served prompt, from when the harness starts working on it to its end:
// the prompt's trace (`SP_THREAD_ID`, `SP_ROOT_ID`) and its verified caller
// (`SP_CALLER_ACCOUNT`, `SP_CALLER_USER`), the one agent `scripts/sp grant`
// grants to (`ServedPromptEnv`). Process-wide variables are sound only for a
// harness that works on one served prompt at a time; each add-on says why
// its harness does.

import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
import type { AgentExtensionContext } from "./plugin-contract.js";
import {
  findReferences,
  granteeFromIdentity,
  readsReferences,
  removeReferences,
  type GrantKind,
  type Grantee,
  type ScratchPad,
  type TraceIds,
} from "./scratchpad.js";
import {
  SCRATCHPAD_BIN_VAR,
  SCRATCHPAD_BOOTSTRAP_FILE_VAR,
  SCRATCHPAD_DIR_VAR,
  SCRATCHPAD_VOLUME_VAR,
  spCliScratchPad,
} from "./scratchpad-cli.js";
import { readScratchPadBootstrapFile } from "./scratchpad-native/bootstrap";
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
  bootstrapFile: SCRATCHPAD_BOOTSTRAP_FILE_VAR,
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
  readonly bootstrapFile?: string;
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

/** How {@link resolveScratchPad} reads the connection's variables. */
export interface ResolveScratchPadOptions {
  /**
   * The credentials file's variables in the order the plugin's channel reads
   * them, the first set and non-empty winning, so `sp` never takes another
   * credentials file than the agent. Default `NATS_CREDS`, then
   * `NATS_CREDENTIALS` (PI's and Claude Code's channels); OpenClaw's channel
   * lets `NATS_CREDENTIALS` win.
   */
  readonly credsVariables?: readonly string[];
}

/** The credentials variables as PI's and Claude Code's channels read them. */
const CREDS_VARIABLES: readonly string[] = ["NATS_CREDS", "NATS_CREDENTIALS"];

/**
 * ScratchPad's settings as the options, the environment and the plugin's
 * NATS context give them, or `undefined` when ScratchPad is off: no volume,
 * or a connection `sp` cannot use, which is logged.
 *
 * The connection, field by field: `options.scratchpad`'s `url` and `creds`;
 * then the connection the plugin's channel takes, in order:
 *
 * 1. `NATS_CONTEXT` set and non-empty: that context's `url` and `creds`.
 * 2. `NATS_CONTEXT` set but empty: no context at all, neither the variable's
 *    nor the config's; `NATS_URL` and the credentials variable.
 * 3. `NATS_URL` or the credentials variable set and non-empty: the
 *    variables, never a context.
 * 4. Otherwise the plugin's config's `context`.
 *
 * Then the `url` and `credentials` of the plugin's configuration fill what
 * is still missing. Where a channel fails (credentials without a URL), the
 * add-on is off with its warning.
 */
export async function resolveScratchPad(
  ctx: AgentExtensionContext,
  env: Env,
  resolveOptions: ResolveScratchPadOptions = {},
): Promise<ScratchPadSettings | undefined> {
  const log = ctx.logger;
  const raw = ctx.options[SCRATCHPAD_OPTION];
  const options: Readonly<Record<string, unknown>> =
    raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const option = (name: string): string | undefined => {
    const value = options[name];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const variable = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const pick = (name: string, variableName: string): string | undefined =>
    option(name) ?? variable(variableName);

  const configuredBootstrap = pick("bootstrapFile", SP_VARS.bootstrapFile);
  const bootstrapFile =
    configuredBootstrap === undefined ? undefined : resolve(expandHome(configuredBootstrap));
  const bootstrap =
    bootstrapFile === undefined ? undefined : readScratchPadBootstrapFile(bootstrapFile);
  const volume = pick("volume", SP_VARS.volume) ?? bootstrap?.volume;
  if (volume === undefined) return undefined;
  if (bootstrap && bootstrap.volume !== volume)
    throw new Error("ScratchPad bootstrap differs from the configured volume");

  let url = option("url");
  let creds = option("creds");
  if (url === undefined || creds === undefined) {
    const envUrl = variable("NATS_URL");
    let envCreds: string | undefined;
    for (const name of resolveOptions.credsVariables ?? CREDS_VARIABLES) {
      envCreds = variable(name);
      if (envCreds !== undefined) break;
    }
    // Step 1, a non-empty NATS_CONTEXT; steps 2 and 3, the variables and
    // never a context; step 4, the plugin's config's context.
    const envContext = env["NATS_CONTEXT"];
    const direct = envContext !== undefined || envUrl !== undefined || envCreds !== undefined;
    const context = envContext
      ? envContext
      : direct
        ? undefined
        : stringOf(ctx.settings.config["context"]);
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
    } else if (direct) {
      url ??= envUrl;
      creds ??= envCreds;
    }
  }
  // A plugin that connects without a context names the two in its own
  // configuration: OpenClaw's account block has `url` and `credentials`.
  url ??= stringOf(ctx.settings.config["url"]);
  creds ??= stringOf(ctx.settings.config["credentials"]);
  if (url === undefined || creds === undefined) {
    log.warn(
      "agent-fabric: ScratchPad is off: sp needs a NATS URL and a credentials file " +
        "(options.scratchpad; else NATS_CONTEXT naming a context with both; else " +
        "NATS_URL and NATS_CREDS or NATS_CREDENTIALS; else the plugin's NATS context " +
        "with both; or url and credentials in the plugin's configuration)",
    );
    return undefined;
  }

  let dir = pick("dir", SP_VARS.dir);
  if (dir === undefined && ctx.settings.stateDir !== undefined) {
    dir = join(ctx.settings.stateDir, "scratchpad");
  }
  if (bootstrap && dir === undefined)
    throw new Error("ScratchPad bootstrap requires a persistent workspace directory");
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
    ...(bootstrapFile === undefined ? {} : { bootstrapFile }),
    ...(dir !== undefined ? { dir } : {}),
    ...(grants !== undefined ? { grants } : {}),
  };
}

/** Sets the start-time variables. */
export function exportScratchPad(settings: ScratchPadSettings, env: Env): void {
  env[SP_VARS.url] = settings.url;
  env[SP_VARS.creds] = settings.creds;
  if (settings.bootstrapFile !== undefined) {
    env[SP_VARS.bootstrapFile] = settings.bootstrapFile;
    delete env[SP_VARS.volume];
  } else {
    env[SP_VARS.volume] = settings.volume;
    delete env[SP_VARS.bootstrapFile];
  }
  if (settings.dir !== undefined) env[SP_VARS.dir] = settings.dir;
  if (settings.grants !== undefined) env[SP_VARS.grants] = settings.grants;
}

/**
 * What holds the per-prompt variables: a served request, or a local turn,
 * which has no caller. Ids are the plugin's, distinct between the two.
 */
export interface PromptEnvHolder {
  readonly id: string;
  readonly caller?: string;
}

/**
 * The per-prompt variables, keyed to one holder at a time: `enter` sets
 * them for a served request or a local turn, `leave` clears them only if
 * that holder still has them, so the end of a prompt never clears the next
 * one's.
 */
export class ServedPromptEnv {
  #holder: string | undefined;

  constructor(private readonly env: Env) {}

  enter(request: PromptEnvHolder, scope: TraceScope | undefined): void {
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

  leave(request: PromptEnvHolder): void {
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

/** Where an add-on looked for its own sp, and what it found. */
export interface SpLookup {
  /** The first candidate that is an executable file; `undefined` when none is. */
  readonly bin: string | undefined;
  /** Each candidate passed over, in order, and why. */
  readonly tried: ReadonlyArray<string>;
  /** A `SCRATCHPAD_BIN` that is set but passed over: its path and why; absent otherwise. */
  readonly passedOver?: string;
}

/**
 * The sp binary an add-on runs for its own ScratchPad steps, directly, with
 * the flags `scripts/sp` would add: the first of these that is an executable
 * file. `SCRATCHPAD_BIN`, a path; then the binary the add-on ships for this
 * machine in `skillDir` (its `skill/scratchpad`), found from the add-on's
 * module. A harness that loads the module from a copy of its own may leave
 * the skill directory out of that copy, so the shipped path is looked at,
 * not assumed.
 */
export function findSp(env: Env, skillDir: string): SpLookup {
  const tried: string[] = [];
  let passedOver: string | undefined;
  const own = env[SCRATCHPAD_BIN_VAR];
  if (own === undefined || own === "") {
    tried.push(`${SCRATCHPAD_BIN_VAR} is not set`);
  } else {
    const why = notExecutable(own);
    if (why === undefined) return { bin: own, tried };
    passedOver = `${own} ${why}`;
    tried.push(`${SCRATCHPAD_BIN_VAR} ${passedOver}`);
  }
  const found = (bin: string | undefined): SpLookup => ({
    bin,
    tried,
    ...(passedOver !== undefined ? { passedOver } : {}),
  });
  const os = platform() === "darwin" ? "darwin" : platform() === "linux" ? "linux" : undefined;
  const cpu = arch() === "arm64" ? "arm64" : arch() === "x64" ? "amd64" : undefined;
  if (os === undefined || cpu === undefined) {
    tried.push(`no sp is shipped for ${platform()} ${arch()}`);
    return found(undefined);
  }
  const shipped = join(skillDir, "bin", `sp-${os}-${cpu}`);
  const why = notExecutable(shipped);
  if (why === undefined) return found(shipped);
  tried.push(`${shipped} ${why}`);
  return found(undefined);
}

/** Why `path` is not an executable file, or `undefined` when it is one. */
function notExecutable(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return "is not a file";
  } catch {
    return "does not exist";
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return "is not executable";
  }
  return undefined;
}

/** The sp binary of `findSp`, or `undefined` when there is none. */
export function spBinary(env: Env, skillDir: string): string | undefined {
  return findSp(env, skillDir).bin;
}

/**
 * The warning an add-on logs once at start when `SCRATCHPAD_BIN` is set
 * but `findSp` passed it over, missing or not executable; `undefined`
 * otherwise. The add-on may run another sp, but the skill's `scripts/sp`,
 * which the model runs, takes `SCRATCHPAD_BIN` as it is, with no
 * fallback, and refuses every call.
 */
export function spBinPassedOverWarning(
  extensionName: string,
  lookup: SpLookup,
): string | undefined {
  if (lookup.passedOver === undefined) return undefined;
  return (
    `${extensionName}: ${SCRATCHPAD_BIN_VAR} ${lookup.passedOver}, so it is passed over` +
    (lookup.bin !== undefined ? ` and the add-on runs ${lookup.bin}` : "") +
    `; the skill's scripts/sp takes ${SCRATCHPAD_BIN_VAR} as it is and refuses every call ` +
    "until it names an executable sp or is unset"
  );
}

/**
 * The warning an add-on logs once at start when `findSp` found no sp: what
 * it tried, how to fix it, and what the add-on leaves out until then.
 */
export function noSpWarning(extensionName: string, lookup: SpLookup): string {
  return (
    `${extensionName}: no sp for the add-on's own ScratchPad steps (${lookup.tried.join("; ")}); ` +
    `set ${SCRATCHPAD_BIN_VAR} to the path of an sp binary. Until then nothing is granted: ` +
    "references in prompt_agent are removed with a note, and grant requests are not answered"
  );
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
  #without = false;
  readonly #early: string[] = [];

  readonly requestInterceptor: RequestInterceptor = {
    aroundRequest: (ctx: RequestInterceptorContext, next: () => Promise<void>) => {
      if (this.#inner !== undefined) this.#inner.remember(ctx.envelope.prompt);
      else if (!this.#without) this.#early.push(ctx.envelope.prompt);
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

  /**
   * Instead of `start`, when the add-on has no ScratchPad port of its own
   * (no sp, `findSp`): nothing can be granted from here on. Every reference
   * in a prompt is removed with a note, as for a receiver that reads none,
   * and a prompt that held nothing but references is refused in the same
   * words; no grant request is answered.
   */
  startWithoutScratchPad(): void {
    this.#without = true;
    this.#early.length = 0;
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
      const found = findReferences(ctx.prompt);
      if (found.length === 0) return;
      if (this.#without) return withoutSp(ctx.address, ctx.prompt, found.length);
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
 * A prompt's references, when the add-on has no sp to grant read with: all
 * removed with a note, or the prompt refused when it held nothing else, in
 * the words of the extension's rule for a receiver that reads none.
 */
function withoutSp(address: string, text: string, found: number): AgentToolsPromptRewrite {
  const why = `this agent has no sp of its own to grant read with (${SCRATCHPAD_BIN_VAR} names one)`;
  const prompt = removeReferences(text);
  if (prompt === "") {
    return {
      error:
        `the prompt was not sent: ${why}, and the prompt held nothing but references; ` +
        "put the content they point at into the prompt itself",
    };
  }
  return {
    prompt,
    fields: {
      references_removed: found,
      note:
        `${why}: ${found} reference(s) were removed from your prompt, "${address}" got only ` +
        "the text, and nothing was granted",
    },
  };
}

/**
 * The ScratchPad port over the add-on's sp (`findSp`), for its own grants and
 * the grant requests it answers, with the grants `scripts/sp` recorded;
 * `undefined` when there is no sp.
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
    ...(settings.bootstrapFile === undefined ? {} : { bootstrapFile: settings.bootstrapFile }),
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
