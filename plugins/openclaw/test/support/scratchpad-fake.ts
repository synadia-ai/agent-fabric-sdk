// An in-memory ScratchPad behind the fabric package's port, for the add-on's
// tests: one volume, tokens that name it, every grant recorded. Adapted from
// the fabric package's `typescript/test/support/scratchpad.ts`.

import type { GrantKind, Grantee, ScratchPad, TraceIds } from "@synadia-ai/agent-fabric";

export interface RecordedGrant {
  readonly reference: string;
  readonly grantee: string;
  readonly trace: TraceIds | undefined;
  readonly toolCallId: string | undefined;
  readonly kind: GrantKind;
}

/** A reference token into `volume`, naming `creator`, in the shape `findReferences` finds. */
export function makeReference(volume: string, path: string, creator?: string): string {
  const made = { volume, path, ...(creator !== undefined ? { creator } : {}) };
  return "sp-ref:" + Buffer.from(JSON.stringify(made)).toString("base64url");
}

function volumeOf(reference: string): string | undefined {
  try {
    const made = JSON.parse(
      Buffer.from(reference.slice("sp-ref:".length), "base64url").toString("utf8"),
    ) as { volume?: string };
    return made.volume;
  } catch {
    return undefined;
  }
}

export class MemoryScratchPad implements ScratchPad {
  readonly grants: RecordedGrant[] = [];

  constructor(readonly volume: string) {}

  owns(reference: string): boolean {
    return volumeOf(reference) === this.volume;
  }

  grantRead(
    reference: string,
    grantee: Grantee,
    trace: TraceIds | undefined,
    toolCallId?: string,
    kind: GrantKind = "first-hand",
  ): void {
    if (!this.owns(reference)) throw new Error("not this volume");
    this.grants.push({
      reference,
      grantee: `${grantee.account}.${grantee.user}`,
      trace,
      toolCallId,
      kind,
    });
  }

  granted(reference: string, grantee: Grantee): GrantKind | undefined {
    const who = `${grantee.account}.${grantee.user}`;
    return this.grants.find((g) => g.reference === reference && g.grantee === who)?.kind;
  }
}
