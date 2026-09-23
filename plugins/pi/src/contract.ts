// The extension contract of the PI channel plugin, declared here so this
// package imports nothing of the plugin or of PI. The plugin's own
// declaration is `agents/pi/extensions/extensions.ts` in `synadia-agents`,
// and the contract an author reads is `agents/EXTENSIONS.md` there. The
// shapes are structural on both sides: the plugin type-checks what the
// factory returns against its declaration, and this file must say the same
// thing. Nothing here is specific to the fabric.

import type { Agents, AgentToolsExtension, Logger, PromptInterceptor } from "@synadia-ai/agents";
import type { AgentService, RequestInterceptor } from "@synadia-ai/agent-service";

/** The harnesses that expose this extension point. */
export type Harness = "pi" | "openclaw" | "claude-code";

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
  readonly harness: Harness;
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
 * The harness's events. A notification is called and forgotten; a wrapper
 * is called by the plugin around one of its own steps and must call `run`
 * once, synchronously, and return its value, a promise included. PI calls
 * the first five; the rest are the other harnesses' and listed so one
 * shape serves all three.
 */
export interface HarnessEvents {
  /** Inside the prompt handler, after every interceptor ran. */
  promptAccepted?(request: ServedRequest): void;
  /** When the plugin settles the request. */
  promptEnded?(request: ServedRequest, outcome: Outcome, atMs: number): void;
  /** Around every agent-tool call, with the request the model works in. */
  aroundToolCall?<T>(request: ServedRequest | undefined, toolName: string, run: () => T): T;
  /** PI: around the hand-over of the prompt to PI's loop (`pi.sendUserMessage()`). */
  aroundInject?<T>(request: ServedRequest, run: () => T): T;
  /** PI: headers to add to a provider request while `request` is PI's active turn. */
  providerHeaders?(request: ServedRequest): Readonly<Record<string, string>> | undefined;
  /** OpenClaw: around the turn's dispatch. */
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
