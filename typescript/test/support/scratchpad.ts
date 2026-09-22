// An in-memory ScratchPad behind the package's port, for the tests: one
// volume, tokens in the reference agents' format, a ledger with expiries,
// and every grant recorded. `python/tests/scratchpad_fake.py` is its twin.

import type {
  Agent,
  AgentToolsPromptContext,
  AgentToolsReplyContext,
  Agents,
} from "@synadia-ai/agents";
import type { GrantKind, Grantee, ScratchPad, TraceIds } from "../../src/index.js";

/** One grant, as the fake saw it made. */
export interface RecordedGrant {
  readonly reference: string;
  readonly grantee: string;
  readonly trace: TraceIds | undefined;
  readonly toolCallId: string | undefined;
  readonly kind: GrantKind;
}

/** A reference token in the reference agents' format: `sp-ref:` + base64url(ref.make reply + creator). */
export function makeReference(volumeId: string, path: string, creator?: string): string {
  const made = {
    ref: {
      type: "handoff",
      handoff_id: `h-${volumeId}-${path}`,
      volume_id: volumeId,
      root: "r1",
      path,
      expires_at: 4_102_444_800,
    },
    source_sequence: 1,
    ...(creator !== undefined ? { creator } : {}),
  };
  return "sp-ref:" + Buffer.from(JSON.stringify(made)).toString("base64url");
}

function volumeOf(reference: string): string {
  const made = JSON.parse(
    Buffer.from(reference.slice("sp-ref:".length), "base64url").toString("utf8"),
  ) as { ref: { volume_id: string; path?: string } };
  return made.ref.volume_id;
}

function pathOf(reference: string): string {
  const made = JSON.parse(
    Buffer.from(reference.slice("sp-ref:".length), "base64url").toString("utf8"),
  ) as { ref: { path?: string } };
  return made.ref.path ?? "/";
}

export class MemoryScratchPad implements ScratchPad {
  readonly grants: RecordedGrant[] = [];
  /** Throw from `grantRead` with this message, when set. */
  failGrants: string | undefined;
  /** Seconds since the epoch; tests move it to expire grants. */
  now = 1_000_000;
  readonly #ttlS: number;
  // path → identity → kind → expiry
  readonly #ledger = new Map<string, Map<string, Partial<Record<GrantKind, number>>>>();
  #commits = 0;

  constructor(
    readonly volumeId: string,
    /** The prompt address written into every reference it makes. */
    readonly creator?: string,
    ttlS = 600,
  ) {
    this.#ttlS = ttlS;
  }

  /** "Commit" something and return its reference. */
  commit(path = `/replies/${++this.#commits}.md`): string {
    return makeReference(this.volumeId, path, this.creator);
  }

  owns(reference: string): boolean {
    try {
      return volumeOf(reference) === this.volumeId;
    } catch {
      return false;
    }
  }

  grantRead(
    reference: string,
    grantee: Grantee,
    trace: TraceIds | undefined,
    toolCallId?: string,
    kind: GrantKind = "first-hand",
  ): void {
    if (!this.owns(reference)) throw new Error("not this volume");
    if (this.failGrants !== undefined) throw new Error(this.failGrants);
    const who = `${grantee.account}.${grantee.user}`;
    this.grants.push({ reference, grantee: who, trace, toolCallId, kind });
    const path = pathOf(reference);
    const readers = this.#ledger.get(path) ?? new Map<string, Partial<Record<GrantKind, number>>>();
    readers.set(who, { ...readers.get(who), [kind]: this.now + this.#ttlS });
    this.#ledger.set(path, readers);
  }

  granted(reference: string, grantee: Grantee): GrantKind | undefined {
    if (!this.owns(reference)) return undefined;
    const until = this.#ledger.get(pathOf(reference))?.get(`${grantee.account}.${grantee.user}`);
    if ((until?.["first-hand"] ?? 0) > this.now) return "first-hand";
    if ((until?.["on-request"] ?? 0) > this.now) return "on-request";
    return undefined;
  }
}

/** A discovered agent, as far as the extension looks at one. */
export function stubAgent(opts: {
  readonly address: string;
  readonly identity?: string;
  readonly verified?: boolean;
  readonly readsReferences?: boolean;
}): Agent {
  return {
    promptSubject: opts.address,
    identity: opts.identity,
    idSigVerified: opts.verified ?? opts.identity !== undefined,
    metadata: opts.readsReferences === false ? {} : { scratchpad_refs_ok: "true" },
  } as unknown as Agent;
}

/** What a stub client was asked to send, and how it answers. */
export interface StubAgents {
  readonly agents: Agents;
  readonly requests: Array<{ subject: string; payload: string }>;
  discovered: Agent[];
  /** The creator's answer: JSON text, or an error to throw. */
  answer: string | Error;
}

/** An `Agents` stand-in: `discover()` returns `discovered`, `requestSigned()` answers `answer`. */
export function stubAgents(discovered: Agent[] = []): StubAgents {
  const stub: StubAgents = {
    requests: [],
    discovered,
    answer: '{"granted":true}',
    agents: undefined as unknown as Agents,
  };
  (stub as { agents: Agents }).agents = {
    discover: () => Promise.resolve(stub.discovered),
    requestSigned: (subject: string, payload: string) => {
      stub.requests.push({ subject, payload });
      const answer = stub.answer;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({ string: () => answer });
    },
  } as unknown as Agents;
  return stub;
}

/** A prompt rewrite's context, as `AgentTools` hands it over; `null`: no tool-call ID. */
export function promptContext(
  target: Agent,
  prompt: string,
  toolCallId: string | null = "toolu_1",
): AgentToolsPromptContext {
  return {
    address: target.promptSubject,
    prompt,
    attachments: [],
    target,
    callId: "call_000000000000",
    label: undefined,
    toolCallId: toolCallId ?? undefined,
    caller: undefined,
  };
}

/** A reply look's context. */
export function replyContext(
  target: Agent,
  kind: "reply" | "question",
  text: string,
): AgentToolsReplyContext {
  return {
    callId: "call_000000000000",
    address: target.promptSubject,
    target,
    kind,
    text,
    attachments: [],
  };
}
