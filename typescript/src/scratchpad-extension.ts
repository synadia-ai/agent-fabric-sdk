// The ScratchPad extension of the agent tools: the fabric's rules for
// references, on the three hooks of the protocol SDK's `AgentTools`
// (`docs/agent-tools.md` §6.3 there; `agent-fabric` `docs/agent-tools.md`
// §2.2). Mirrors `synadia_ai/agent_fabric/scratchpad_extension.py`.
//
//   discovery fields  `reads_scratchpad_references`, from the agent's
//                     registration (`scratchpad_refs_ok: "true"`)
//   prompt rewrite    checks each `sp-ref:` token in the prompt and gets the
//                     target read on it before the prompt goes out:
//                       - a token this agent was not given refuses the prompt;
//                       - a target that reads no references gets the text
//                         without them;
//                       - on this agent's own content it grants read itself,
//                         first-hand, and a grant that fails refuses the prompt;
//                       - on another agent's content it asks the creator
//                         (`grant-request.ts`), and a refusal or no answer takes
//                         that reference out;
//                     removals add `references_removed` and `note` to the
//                     call's results; a prompt that was nothing but removed
//                     references is refused
//   reply look        remembers the references that arrive in a reply or a
//                     question, so the agent may hand them on
//
// Every grant, made here or asked of a creator, carries the served prompt's
// thread and root (`activeTrace()`) and the model's tool-call ID, so it
// shows under the tool call that caused it.
//
// What the agent was given is what it may hand on: the references it
// committed (`remember`, or `grantCaller` on the reply side), the ones in
// the prompts it serves (`requestInterceptor`), and the ones in the replies
// and questions its calls bring back (the reply look).

import type { RequestInterceptor } from "@synadia-ai/agent-service";
import type {
  Agent,
  Agents,
  AgentToolsExtension,
  AgentToolsPromptContext,
  AgentToolsPromptRewrite,
  AgentToolsReplyContext,
  SenderInfo,
} from "@synadia-ai/agents";
import { requestGrant, type GrantReply, type GrantRequest } from "./grant-request.js";
import {
  findReferences,
  granteeFromIdentity,
  readsReferences,
  referenceCreator,
  removeReferences,
  type ScratchPad,
  type TraceIds,
} from "./scratchpad.js";
import { activeTrace, validToolCallId } from "./trace.js";

/** The field `discover_agents` entries get. */
export const READS_SCRATCHPAD_REFERENCES_FIELD = "reads_scratchpad_references";

export interface ScratchPadExtensionOptions {
  /** The agent's own ScratchPad, behind the port. */
  readonly scratchPad: ScratchPad;
  /**
   * The client grant requests are signed and sent with, and creators are
   * looked up through: the one `AgentTools` runs on, with the agent's
   * signer.
   */
  readonly agents: Agents;
  /** How long a lookup of a creator waits; unset, the SDK's discovery default. */
  readonly discoverTimeoutMs?: number;
  /** How long a creator's answer is waited for. Default 10 seconds. */
  readonly grantRequestTimeoutMs?: number;
}

/** The extension; build it with {@link scratchPadExtension}. */
export class ScratchPadExtension implements AgentToolsExtension {
  /**
   * For the agent's `AgentService` (`interceptors: [...]`): remembers the
   * references in every prompt it serves.
   */
  readonly requestInterceptor: RequestInterceptor;

  readonly #scratchPad: ScratchPad;
  readonly #agents: Agents;
  readonly #discoverTimeoutMs: number | undefined;
  readonly #grantRequestTimeoutMs: number | undefined;
  // Every reference this agent was given, exactly as it came.
  readonly #given = new Set<string>();
  // Live handles by address, from discovery: a creator is asked only when
  // it is on the fabric with a verified identity.
  readonly #known = new Map<string, Agent>();

  constructor(options: ScratchPadExtensionOptions) {
    this.#scratchPad = options.scratchPad;
    this.#agents = options.agents;
    this.#discoverTimeoutMs = options.discoverTimeoutMs;
    this.#grantRequestTimeoutMs = options.grantRequestTimeoutMs;
    this.requestInterceptor = {
      aroundRequest: (ctx, next) => {
        this.remember(ctx.envelope.prompt);
        return next();
      },
    };
  }

  /**
   * Note the references in `text` as given to this agent: what it
   * committed, or received some way the hooks do not see.
   */
  remember(text: string): void {
    for (const reference of findReferences(text)) this.#given.add(reference);
  }

  /**
   * The reply side: before a reply carrying `reference`, this agent's own,
   * goes out, remember it and grant the served prompt's sender read on it,
   * first-hand — only a sender whose signature verified, since a grant
   * names a principal and an unsigned claim proves none. `true` when
   * granted, so the reference may go into the reply; `false` for a sender
   * that did not verify. Throws when the reference is not this agent's own
   * or the grant fails. The commit itself stays the agent's.
   */
  async grantCaller(reference: string, sender: SenderInfo | undefined): Promise<boolean> {
    this.remember(reference);
    if (sender?.trust !== "verified") return false;
    if (!(await this.#scratchPad.owns(reference))) {
      throw new Error("the reference points into another agent's volume; only its creator grants");
    }
    await this.#scratchPad.grantRead(
      reference,
      granteeFromIdentity(sender.id),
      servedTrace(),
      undefined,
      "first-hand",
    );
    return true;
  }

  /** The discovery fields hook. */
  discoveryFields(agent: Agent): Record<string, unknown> {
    this.#note(agent);
    return { [READS_SCRATCHPAD_REFERENCES_FIELD]: readsReferences(agent.metadata) };
  }

  /** The prompt rewrite hook. */
  async beforePrompt(ctx: AgentToolsPromptContext): Promise<AgentToolsPromptRewrite | void> {
    const { address, target } = ctx;
    const found = findReferences(ctx.prompt);
    if (found.length === 0) return;

    // Only to an agent that reads references. Any other gets the text
    // without them, and nothing is asked or granted for it.
    if (!readsReferences(target.metadata)) {
      const prompt = removeReferences(ctx.prompt);
      if (prompt === "") {
        return {
          error:
            `the prompt was not sent: "${address}" does not read ScratchPad references ` +
            "(discover_agents: reads_scratchpad_references is false), and the prompt held nothing but references; " +
            "put the content they point at into the prompt itself",
        };
      }
      return {
        prompt,
        fields: {
          references_removed: found.length,
          note:
            `"${address}" does not read ScratchPad references: ${found.length} reference(s) were removed ` +
            "from your prompt, it got only the text, and nothing was granted",
        },
      };
    }

    // Only a reference this agent was given, exactly as it came.
    const references = [...new Set(found)];
    const unknown = references.filter((reference) => !this.#given.has(reference));
    if (unknown.length > 0) {
      return {
        error:
          `the prompt was not sent: ${unknown.length} of its ScratchPad references (${unknown[0]!.slice(0, 24)}…) ` +
          "is not one you were given. Copy each reference exactly as you received it, the whole token, or leave it out.",
      };
    }

    // And be allowed to read: one grant per reference, to this one agent,
    // right before the prompt goes out, and only to an identity discovery
    // verified.
    if (target.identity === undefined || !target.idSigVerified) {
      return {
        error:
          `cannot hand a ScratchPad reference to "${address}": its identity is not verified, ` +
          "so no read grant can be issued; put the content in the prompt instead",
      };
    }
    const grantee = granteeFromIdentity(target.identity);
    const trace = servedTrace();
    const toolCallId =
      ctx.toolCallId !== undefined && validToolCallId(ctx.toolCallId) ? ctx.toolCallId : undefined;
    const refused: string[] = [];
    let reason = "";
    for (const reference of references) {
      // On its own content the agent grants itself; a grant that fails
      // means the prompt is not sent.
      try {
        if (await this.#scratchPad.owns(reference)) {
          await this.#scratchPad.grantRead(reference, grantee, trace, toolCallId, "first-hand");
          continue;
        }
      } catch (err) {
        return {
          error: `could not grant "${address}" read on ${reference.slice(0, 32)}…: ${describe(err)}; the prompt was not sent`,
        };
      }
      // On anyone else's content only the creator can, so it is asked.
      const answer = await this.#askCreator(reference, address, target.identity, trace, toolCallId);
      if (!answer.granted) {
        refused.push(reference);
        reason = answer.reason;
      }
    }
    if (refused.length === 0) return;

    const removed = found.filter((reference) => refused.includes(reference)).length;
    const prompt = removeReferences(ctx.prompt, refused);
    if (prompt === "") {
      return {
        error:
          `the prompt was not sent: it held nothing but references, and their creator did not grant ` +
          `"${address}" read (${reason}); put the content they point at into the prompt itself`,
      };
    }
    return {
      prompt,
      fields: {
        references_removed: removed,
        note:
          `${removed} reference(s) were removed from your prompt, and "${address}" got only the text: ` +
          `you did not create that content, and its creator did not grant "${address}" read (${reason}). ` +
          "If it needs the content, put the content itself in a prompt",
      },
    };
  }

  /** The reply look hook. */
  afterReply(ctx: AgentToolsReplyContext): void {
    this.remember(ctx.text);
  }

  // Ask the creator of a reference this agent was handed to grant the
  // target read on it. The creator is the address the token names, and it
  // must be on the fabric with a verified identity: a request to anyone
  // else could not be answered with a grant anyway. A target that is the
  // creator reads its own volume and needs no grant.
  async #askCreator(
    reference: string,
    targetAddress: string,
    targetIdentity: string,
    trace: TraceIds | undefined,
    toolCallId: string | undefined,
  ): Promise<GrantReply> {
    const address = referenceCreator(reference);
    if (address === undefined) {
      return { granted: false, reason: "the reference does not name its creator" };
    }
    if (address === targetAddress) return { granted: true };
    const creator = await this.#lookup(address);
    if (creator === undefined || !creator.idSigVerified) {
      return {
        granted: false,
        reason: `its creator, ${address}, is not on the fabric with a verified identity`,
      };
    }
    const request: GrantRequest = {
      reference,
      grantee: targetIdentity,
      ...(trace !== undefined
        ? {
            trace: {
              thread_id: trace.threadId,
              root_id: trace.rootId,
              ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
            },
          }
        : {}),
    };
    return requestGrant(
      this.#agents,
      address,
      request,
      this.#grantRequestTimeoutMs !== undefined ? { timeoutMs: this.#grantRequestTimeoutMs } : {},
    );
  }

  // The handle for an address: from discovery so far, else from a fresh one.
  async #lookup(address: string): Promise<Agent | undefined> {
    const known = this.#known.get(address);
    if (known !== undefined) return known;
    try {
      const found = await this.#agents.discover(
        this.#discoverTimeoutMs !== undefined ? { timeoutMs: this.#discoverTimeoutMs } : {},
      );
      for (const handle of found) this.#note(handle);
    } catch {
      // Not found, as far as the caller can tell.
    }
    return this.#known.get(address);
  }

  // Remember a handle, preferring one whose identity verifies.
  #note(handle: Agent): void {
    const known = this.#known.get(handle.promptSubject);
    if (known === undefined || handle.idSigVerified || !known.idSigVerified) {
      this.#known.set(handle.promptSubject, handle);
    }
  }
}

/** The ScratchPad extension for `AgentTools` (`extensions: [...]`). */
export function scratchPadExtension(options: ScratchPadExtensionOptions): ScratchPadExtension {
  return new ScratchPadExtension(options);
}

function servedTrace(): TraceIds | undefined {
  const scope = activeTrace();
  return scope !== undefined ? { threadId: scope.threadId, rootId: scope.rootId } : undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
