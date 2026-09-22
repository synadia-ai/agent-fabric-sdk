// The grant request — asking a reference's creator to let one more agent
// read it. Mirrors `synadia_ai/agent_fabric/grant_request.py`; the two send
// and answer the same bytes.
//
// An agent handed a reference may read it; it may not let a third agent
// read it. In ScratchPad only a volume's owner grants, and being allowed to
// read is not being allowed to pass on (ScratchPad v1 has no delegation, on
// purpose). So before an agent hands on a reference it did not create, it
// asks the creator, which the token names, to grant that agent read. The
// creator decides, and if it agrees it makes the grant itself, on its own
// volume.
//
// Code to code: no model sees the request or decides the answer, on either
// side. The creator's rule:
//
//   - the request is signed and the signature verifies: the requester is an
//     identity, not a claim (the SDK's `SenderGate`, which also refuses a
//     replay);
//   - the reference points into the creator's own volume;
//   - the creator itself granted that requester read on that reference
//     first-hand, and the grant has not expired: only an agent the creator
//     chose to hand the content to may ask for it to be handed on, and only
//     while its own access lasts;
//   - a grant made on request confers no right to ask, or access would be
//     relayed from agent to agent without end;
//   - the requester asks for another agent, never for itself: a grant that
//     renews itself would never expire.
//
// Then it grants what every grant is — one agent, the one path, read only,
// its usual expiry — and records it as made on request. So content travels
// at most one hop beyond the agents its creator chose.
//
// The wire: one signed NATS request (the SDK's `requestSigned`) and one
// JSON reply, on the creator's prompt address with the verb changed:
//
//   agents.prompt.<agent>.<owner>.<name>      where it takes prompts
//   agents.sp-grant.<agent>.<owner>.<name>    where it takes grant requests
//
// The shapes are `test-fixtures/schemas/scratchpad_grant.{request,reply}.json`.
// A stopgap until ScratchPad has delegation of its own; then this goes.

import { SenderGate, type AgentServiceExtraEndpoint } from "@synadia-ai/agent-service";
import { SILENT_LOGGER, type Agents, type Logger } from "@synadia-ai/agents";
import {
  granteeFromIdentity,
  type GrantKind,
  type Grantee,
  type ScratchPad,
  type TraceIds,
} from "./scratchpad.js";
import { isThreadId, validToolCallId } from "./trace.js";

/** What the requester sends (`scratchpad_grant.request.json`). */
export interface GrantRequest {
  /** The reference, exactly as the requester was given it. */
  readonly reference: string;
  /** The identity, `<account>.<user>`, of the agent that should be able to read it. */
  readonly grantee: string;
  /**
   * The requester's served thread and the tool call the handoff belongs to,
   * so the creator's grant shows under the call that caused it. Labels
   * only, never authority.
   */
  readonly trace?: {
    readonly thread_id: string;
    readonly root_id: string;
    readonly tool_call_id?: string;
  };
}

/** What the creator answers (`scratchpad_grant.reply.json`). */
export type GrantReply =
  { readonly granted: true } | { readonly granted: false; readonly reason: string };

/** The name of the creator's extra endpoint, and the verb of its subject. */
export const GRANT_REQUEST_ENDPOINT = "sp-grant";

/**
 * How long the requester waits for the creator's answer. The creator runs
 * one ScratchPad operation before it answers, so longer than the SDK's two
 * seconds for a signed request.
 */
export const DEFAULT_GRANT_REQUEST_TIMEOUT_MS = 10_000;

const PROMPT_PREFIX = "agents.prompt.";
const GRANT_PREFIX = `agents.${GRANT_REQUEST_ENDPOINT}.`;

/**
 * Where the agent at `promptAddress` takes grant requests: the same subject
 * with the verb changed. Derived, never taken from what another agent says,
 * so a request only ever goes to the creator's own subject. Throws for a
 * subject that is not a prompt address.
 */
export function grantSubject(promptAddress: string): string {
  if (!promptAddress.startsWith(PROMPT_PREFIX) || promptAddress === PROMPT_PREFIX) {
    throw new Error(`not a prompt address: ${promptAddress}`);
  }
  return GRANT_PREFIX + promptAddress.slice(PROMPT_PREFIX.length);
}

/** A request's bytes, as both packages write them: the schema's key order. */
export function encodeGrantRequest(request: GrantRequest): string {
  const { trace } = request;
  return JSON.stringify({
    reference: request.reference,
    grantee: request.grantee,
    ...(trace !== undefined
      ? {
          trace: {
            thread_id: trace.thread_id,
            root_id: trace.root_id,
            ...(trace.tool_call_id !== undefined ? { tool_call_id: trace.tool_call_id } : {}),
          },
        }
      : {}),
  });
}

/** A reply's bytes, as both packages write them. */
export function encodeGrantReply(reply: GrantReply): string {
  return JSON.stringify(
    reply.granted ? { granted: true } : { granted: false, reason: reply.reason },
  );
}

export interface RequestGrantOptions {
  /** How long to wait for the answer. Default {@link DEFAULT_GRANT_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * The requester's side: ask the agent at `creatorAddress` to grant what
 * `request` names, signed as `agents`' identity. Never throws: no answer,
 * or an answer that is not a grant, is a refusal with its reason in words.
 */
export async function requestGrant(
  agents: Agents,
  creatorAddress: string,
  request: GrantRequest,
  options: RequestGrantOptions = {},
): Promise<GrantReply> {
  let answer: unknown;
  try {
    const msg = await agents.requestSigned(
      grantSubject(creatorAddress),
      encodeGrantRequest(request),
      { timeoutMs: options.timeoutMs ?? DEFAULT_GRANT_REQUEST_TIMEOUT_MS },
    );
    answer = JSON.parse(msg.string());
  } catch (err) {
    // Nobody listening there (an agent without ScratchPad, a harness, an
    // agent that has left), no answer in time, or no JSON.
    return refusal(`no answer from ${creatorAddress}: ${describe(err)}`);
  }
  if (typeof answer !== "object" || answer === null) {
    return refusal("refused without a reason");
  }
  const { granted, reason } = answer as Record<string, unknown>;
  if (granted === true) return { granted: true };
  return refusal(typeof reason === "string" ? reason : "refused without a reason");
}

/**
 * The creator's rule, for a requester whose signature verified. `requester`
 * is that verified sender ID; `payload` the request's body. Never throws.
 * {@link grantRequestEndpoint} runs it after the SDK's `SenderGate`; a host
 * that takes grant requests some other way must verify the sender first.
 */
export async function answerGrantRequest(
  requester: string,
  payload: string,
  scratchPad: ScratchPad,
  logger: Logger = SILENT_LOGGER,
): Promise<GrantReply> {
  const request = parseGrantRequest(payload);
  if (request === undefined) return refusal("not a grant request");
  let from: Grantee;
  let to: Grantee;
  try {
    from = granteeFromIdentity(requester);
    to = granteeFromIdentity(request.grantee);
  } catch {
    return refusal("grantee is not an agent identity");
  }
  const labels = request.trace;
  const trace: TraceIds | undefined =
    labels !== undefined ? { threadId: labels.thread_id, rootId: labels.root_id } : undefined;

  // The rule. Each refusal says which line refused.
  let own = false;
  try {
    own = await scratchPad.owns(request.reference);
  } catch {
    // A token that does not decode is nobody's.
  }
  if (!own) return refusal("the reference does not point into this agent's volume");
  let held: GrantKind | undefined;
  try {
    held = await scratchPad.granted(request.reference, from);
  } catch (err) {
    logger.error("grant request: the ledger could not be read", { error: describe(err) });
    return refusal("the grant could not be made");
  }
  if (held === undefined) {
    return refusal(
      "this agent holds no live read grant it made to the requester on that reference",
    );
  }
  if (held !== "first-hand") {
    return refusal(
      "the requester's own grant was made at another agent's request; " +
        "only an agent this agent handed the reference itself may ask for another",
    );
  }
  if (to.account === from.account && to.user === from.user) {
    return refusal("a grant request is for another agent, not for the requester");
  }
  try {
    await scratchPad.grantRead(request.reference, to, trace, labels?.tool_call_id, "on-request");
  } catch (err) {
    logger.error("grant request: the grant failed", { error: describe(err) });
    return refusal("the grant could not be made");
  }
  logger.info("grant request: granted", { grantee: request.grantee, requester });
  return { granted: true };
}

export interface GrantRequestEndpointOptions {
  /** This agent's own prompt address; the endpoint sits next to it. */
  readonly promptAddress: string;
  /** This agent's ScratchPad: the volume it may grant on, and its ledger. */
  readonly scratchPad: ScratchPad;
  /** Refusals at `info`, failures at `error`. Default: silent. */
  readonly logger?: Logger;
}

type ServiceMsg = Parameters<AgentServiceExtraEndpoint["handler"]>[1];

/**
 * The creator's side, as an extra endpoint for the agent's `AgentService`
 * (`extraEndpoints: [grantRequestEndpoint({ ... })]`): it answers every
 * grant request by the rule at the top of this file. Several instances of
 * one agent share the work, in the `agents` queue group.
 */
export function grantRequestEndpoint(
  options: GrantRequestEndpointOptions,
): AgentServiceExtraEndpoint {
  const { scratchPad } = options;
  const logger = options.logger ?? SILENT_LOGGER;
  // The SDK's admission of a signed message, the one its prompt endpoint
  // runs: parse the `Agent-Sender` header, verify the signature over this
  // subject and payload, check the timestamp, and record the nonce so a
  // captured request cannot be played again.
  const gate = new SenderGate({ minSenderTrust: "signed", logger });

  async function decide(msg: ServiceMsg): Promise<GrantReply> {
    const admission = await gate.admitPrompt(msg);
    if (!admission.ok) return refusal(admission.description);
    const sender = admission.sender;
    if (sender?.trust !== "verified") return refusal("a grant request must be signed");
    return answerGrantRequest(sender.id, msg.string(), scratchPad, logger);
  }

  return {
    name: GRANT_REQUEST_ENDPOINT,
    subject: grantSubject(options.promptAddress),
    queue: "agents",
    handler: (err, msg) => {
      if (err) return;
      void decide(msg)
        .catch((e: unknown): GrantReply => {
          logger.error("grant request failed", { error: describe(e) });
          return refusal("the grant could not be made");
        })
        .then((reply) => {
          if (!reply.granted) logger.info("grant request refused", { reason: reply.reason });
          msg.respond(encodeGrantReply(reply));
        });
    },
  };
}

// A request is taken only with the two strings; the trace labels only when
// they look like what the fabric mints, and otherwise left off.
function parseGrantRequest(text: string): GrantRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { reference, grantee, trace } = value as Record<string, unknown>;
  if (typeof reference !== "string" || typeof grantee !== "string") return undefined;
  if (typeof trace !== "object" || trace === null) return { reference, grantee };
  const { thread_id, root_id, tool_call_id } = trace as Record<string, unknown>;
  if (
    typeof thread_id !== "string" ||
    typeof root_id !== "string" ||
    !isThreadId(thread_id) ||
    !isThreadId(root_id)
  ) {
    return { reference, grantee };
  }
  return {
    reference,
    grantee,
    trace: {
      thread_id,
      root_id,
      ...(typeof tool_call_id === "string" && validToolCallId(tool_call_id)
        ? { tool_call_id }
        : {}),
    },
  };
}

function refusal(reason: string): GrantReply {
  return { granted: false, reason };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
