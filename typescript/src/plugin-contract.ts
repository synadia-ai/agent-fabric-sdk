// The extension contract of the harness plugins in `synadia-agents`
// (PI, OpenClaw, Claude Code), declared here so an add-on under `plugins/`
// imports nothing of any plugin or harness. The plugins' own declarations
// are `agents/pi/extensions/extensions.ts` and
// `agents/openclaw/src/extensions.ts`, one contract kept in step, and the
// contract an author reads is `agents/EXTENSIONS.md` there. The shapes are
// structural on both sides: a plugin type-checks what the factory returns
// against its declaration, and this file must say the same thing. Nothing
// here is specific to the fabric, and nothing here is wire: TypeScript
// only, since the plugins are, with no Python twin.

import type { Agents, AgentToolsExtension, Logger, PromptInterceptor } from "@synadia-ai/agents";
import type { AgentService, RequestInterceptor } from "@synadia-ai/agent-service";

/**
 * The harnesses that expose this extension point. Named apart from the
 * served record's `Harness` (`served.ts`), which is the proxy's word for a
 * harness, not the plugin's.
 */
export type PluginHarness = "pi" | "openclaw" | "claude-code";

/** The plugin's resolved settings, as the factory sees them before connect. */
export interface AgentExtensionSettings {
  /** The address tokens: `agents.prompt.<token>.<owner>.<name>`. */
  readonly owner: string;
  /**
   * The name token as configured. The plugin checks it for a collision once
   * on the bus and may suffix it; the definitive address is
   * `service.subject.prompt` in `started()`.
   */
  readonly name: string;
  readonly senderIdentity: "off" | "signed";
  readonly minSenderTrust: "any" | "signed";
  /** Where the plugin keeps its files, when it has such a directory. */
  readonly stateDir?: string;
  /** The plugin's configuration as read, unknown keys included; read-only. */
  readonly config: Readonly<Record<string, unknown>>;
}

/** What the plugin knows when it loads the module, before it connects. */
export interface AgentExtensionContext {
  readonly harness: PluginHarness;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly settings: AgentExtensionSettings;
  /** The `options` of this module's config entry, verbatim; `{}` when the variable named it. */
  readonly options: Readonly<Record<string, unknown>>;
  /** The plugin's logger, in the SDK's `Logger` shape. */
  readonly logger: Logger;
}

/** A served prompt, as the harness's events name it. */
export interface ServedRequest {
  /** The plugin's id for the request, unique in the process. */
  readonly id: string;
  /** The envelope's fields the protocol does not define (§5.6), as decoded. */
  readonly extras: Readonly<Record<string, unknown>>;
  /** The verified sender's id, when the signature verified. */
  readonly caller?: string;
  /** Claude Code only: the session the prompt was delivered to, when known. */
  readonly sessionId?: string;
}

export type Outcome = "ok" | "error" | "timeout";

/**
 * Claude Code: how a prompt ended when the model did not end it with its
 * own reply, `promptEnded`'s fourth argument; absent when it did.
 * `final_text`: the turn ended without a reply and the plugin sent the
 * turn's final text as the reply (outcome `ok`); `no_reply`: no reply and
 * no final text; `shutdown`: the plugin stopped with the prompt open;
 * `delivery`: the prompt could not be handed to the harness (all three
 * `error`); `expired`: the prompt outlived the plugin's limit (`timeout`).
 * The same values as the served record's `reason`.
 */
export type EndReason = "final_text" | "no_reply" | "shutdown" | "delivery" | "expired";

/**
 * The harness's events. A notification is called and forgotten; a wrapper
 * is called by the plugin around one of its own steps and must call `run`
 * once, synchronously, and return its value, a promise included. A wrapper
 * may be an async function: the plugin still takes `run`'s own value, and
 * the wrapper must call `run` once, before its first `await`, so the step
 * keeps its timing. Every harness calls the first three; PI also
 * `aroundInject` and `providerHeaders`, OpenClaw `aroundDispatch`, Claude
 * Code `sessionStarted` and `turnStopped`. One shape serves all three.
 */
export interface HarnessEvents {
  /** Inside the prompt handler, after every interceptor ran. */
  promptAccepted?(request: ServedRequest): void;
  /**
   * When the plugin settles the request. Claude Code passes `reason` when
   * the model did not end the prompt with its own reply.
   */
  promptEnded?(request: ServedRequest, outcome: Outcome, atMs: number, reason?: EndReason): void;
  /** Around every agent-tool call, with the request the model works in. */
  aroundToolCall?<T>(request: ServedRequest | undefined, toolName: string, run: () => T): T;
  /** PI: around the hand-over of the prompt to PI's loop (`pi.sendUserMessage()`). */
  aroundInject?<T>(request: ServedRequest, run: () => T): T;
  /** PI: headers to add to a provider request while `request` is PI's active turn. */
  providerHeaders?(request: ServedRequest): Readonly<Record<string, string>> | undefined;
  /**
   * OpenClaw: around the turn's dispatch
   * (`dispatchInboundDirectDmWithRuntime()`). Asynchronous: the extension
   * calls `run` once and returns its promise.
   */
  aroundDispatch?<T>(request: ServedRequest, run: () => Promise<T>): Promise<T>;
  /** Claude Code: a session started, from its hook. */
  sessionStarted?(sessionId: string, source: string): void;
  /** Claude Code: a turn stopped, from its hook. */
  turnStopped?(sessionId: string | undefined, atMs: number): void;
}

/** The live handles, once the plugin is on the bus. */
export interface AgentExtensionHandles {
  readonly agents: Agents;
  readonly service: AgentService;
}

/** What the factory returns. */
export interface AgentExtension {
  readonly name: string;
  /** For the plugin's `Agents` client: `new Agents({ interceptors })`. */
  readonly promptInterceptors?: ReadonlyArray<PromptInterceptor>;
  /** For the plugin's `AgentService`, before the plugin's own interceptors. */
  readonly requestInterceptors?: ReadonlyArray<RequestInterceptor>;
  /** For the plugin's `AgentService`: `heartbeatExtras`. */
  readonly heartbeatExtras?: () => Readonly<Record<string, unknown>>;
  /** For the plugin's `AgentTools`: `extensions`. */
  readonly toolExtensions?: ReadonlyArray<AgentToolsExtension>;
  /**
   * Keys for the service's registration metadata, read once before the
   * service starts. A key is one or more of `A-Z a-z 0-9 _ - .`, a value a
   * string; anything else fails the plugin's start. The plugin's own keys
   * and the protocol's registration keys win over an entry of the same name
   * (`agents/EXTENSIONS.md` in `synadia-agents`, from #218).
   */
  readonly metadata?: Readonly<Record<string, string>>;
  /** After the service started. Awaited, bounded by the plugin. */
  started?(handles: AgentExtensionHandles): void | Promise<void>;
  /** Before the plugin stops its service. Awaited, bounded by the plugin. */
  stopping?(): void | Promise<void>;
  /** The harness's events. */
  readonly events?: HarnessEvents;
}

/** The module's one default export. */
export type AgentExtensionFactory = (
  ctx: AgentExtensionContext,
) => AgentExtension | Promise<AgentExtension>;
