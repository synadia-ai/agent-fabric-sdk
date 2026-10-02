// ScratchPad references — the vocabulary of handing content over by
// reference on the fabric, and the port the agent's own ScratchPad client
// plugs into. Mirrors `synadia_ai/agent_fabric/scratchpad.py`.
//
// A reference is one opaque token: service-issued `sp-r1:` or the existing
// expanded `sp-ref:` form. Models copy it unchanged; clients resolve metadata.
// Neither form grants authority. ScratchPad authenticates every reader and
// checks current grants. The creator is a routing claim that discovery verifies.
//
// The rules the fabric keeps around references (the reference agents'
// `tools/README.md`, `agent-fabric` `docs/agent-tools.md` §2.2):
//
//   - who reads references says so, with `scratchpad_refs_ok: "true"` in its
//     service metadata; a reference goes to no other agent;
//   - an agent hands on only a reference it was given: it committed it, or
//     it arrived in a prompt it served or a reply it received;
//   - least authority: one grantee, one path, read only, a short expiry,
//     granted immediately before the reference goes out;
//   - being allowed to read is not being allowed to pass on: only a
//     volume's owner grants, so an agent that wants to hand on another
//     agent's reference asks its creator (`grant-request.ts`).
//
// This package holds that policy. It does not talk to ScratchPad: the
// agent brings its own client, behind the {@link ScratchPad} port.

/** Prefix of the expanded reference token. */
export const REFERENCE_PREFIX = "sp-ref:";

export const SHORT_REFERENCE_PREFIX = "sp-r1:";

const REFERENCE_RE = /sp-(?:ref|r1):[A-Za-z0-9_-]+/g;

/**
 * The service metadata key an agent that reads the references it is handed
 * registers, with the value `"true"` (the SDK's `extraMetadata`). A caller
 * hands a reference, and grants read on it, only to an agent that says so.
 * In the style of the protocol's `attachments_ok`.
 */
export const READS_REFERENCES_KEY = "scratchpad_refs_ok";

/** The served prompt's thread and root, as `activeTrace()` reports them. */
export interface TraceIds {
  readonly threadId: string;
  readonly rootId: string;
}

/**
 * The principal ScratchPad grants to: the two halves of an agent identity,
 * `<account>.<user>`, both public NKEYs on the fabric.
 */
export interface Grantee {
  readonly account: string;
  readonly user: string;
}

/**
 * How a grant came about. `first-hand`: the agent granted an agent it
 * handed the reference itself — the verified caller of its reply, or the
 * agent it prompted with a reference of its own. `on-request`: the agent
 * granted an agent because another agent asked it to (`grant-request.ts`).
 * Only a first-hand grant entitles its holder to ask for another agent, or
 * access could be relayed from agent to agent without end.
 */
export type GrantKind = "first-hand" | "on-request";

type MaybePromise<T> = T | Promise<T>;

/**
 * What the policy needs of the agent's ScratchPad: its own volume, and a
 * ledger of the read grants it made. ScratchPad knows the grants but not
 * how they came about; that is the agent's own knowledge, so the
 * implementation keeps the ledger.
 */
export interface ScratchPad {
  /** Resolve reference metadata through the implementation's authenticated client. */
  resolveReference?(
    reference: string,
    trace?: TraceIds,
  ): MaybePromise<{ readonly creator: string }>;
  /** Whether `reference` points into this agent's own volume, where it may grant. */
  owns(reference: string): MaybePromise<boolean>;
  /**
   * Grant `grantee` read on the one path `reference` names, until the
   * grant's expiry, and note it in the ledger as `kind` (`first-hand` when
   * not given). Only for a reference into this agent's own volume. `trace`
   * and `toolCallId` label the grant, so it shows under the served prompt
   * and the tool call that caused it.
   */
  grantRead(
    reference: string,
    grantee: Grantee,
    trace: TraceIds | undefined,
    toolCallId?: string,
    kind?: GrantKind,
  ): MaybePromise<void>;
  /**
   * The live grant this agent made to `grantee` on what `reference` points
   * at, by kind; `undefined` when there is none or it has expired. A
   * first-hand grant still running is not hidden by a later one made on
   * request.
   */
  granted(reference: string, grantee: Grantee): MaybePromise<GrantKind | undefined>;
}

/** Every reference token in `text`, in order, repeats included. */
export function findReferences(text: string): string[] {
  return text.match(REFERENCE_RE) ?? [];
}

/**
 * `text` with reference tokens taken out — every one, or only those in
 * `only` — and the trailing spaces and extra blank lines that leaves
 * behind tidied away.
 */
export function removeReferences(text: string, only?: ReadonlyArray<string>): string {
  return text
    .replace(REFERENCE_RE, (token) => (only === undefined || only.includes(token) ? "" : token))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The prompt address of the agent that made `reference`, as the token says;
 * `undefined` for a token that names none or does not decode.
 */
export function referenceCreator(reference: string): string | undefined {
  if (!reference.startsWith(REFERENCE_PREFIX)) return undefined;
  let made: unknown;
  try {
    made = JSON.parse(
      Buffer.from(reference.slice(REFERENCE_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    return undefined;
  }
  if (typeof made !== "object" || made === null) return undefined;
  const creator = (made as Record<string, unknown>)["creator"];
  return typeof creator === "string" && creator !== "" ? creator : undefined;
}

/** Whether an agent's registration metadata says it reads references. */
export function readsReferences(metadata: Readonly<Record<string, string>>): boolean {
  return metadata[READS_REFERENCES_KEY] === "true";
}

/**
 * The grantee behind an identity as discovery or a verified sender reports
 * it. Throws for anything that is not `<account>.<user>`.
 */
export function granteeFromIdentity(identity: string): Grantee {
  // The account half never contains a dot (an NKEY, a config-file account
  // name, or `$G`), so the first dot is the split.
  const dot = identity.indexOf(".");
  if (dot <= 0 || dot === identity.length - 1) {
    throw new Error(`not an agent identity: ${identity}`);
  }
  return { account: identity.slice(0, dot), user: identity.slice(dot + 1) };
}
