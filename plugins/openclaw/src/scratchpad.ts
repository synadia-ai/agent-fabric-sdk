// ScratchPad for OpenClaw's model (`docs/plugins.md` §9): the pieces every
// add-on shares, from the fabric package (`plugin-scratchpad.ts` there), with
// this package's copy of the skill (`skill/scratchpad`, installed by
// `npm run build:sp` from `plugins/scratchpad-skill`).
//
// OpenClaw's exec tool builds each command's environment from the gateway's
// `process.env` on the gateway host, the default with the sandbox off
// (§9.4), so the variables set here reach `scripts/sp`. The plugin
// dispatches one turn at a time (§3.1), so the per-prompt variables, set
// around the dispatch, are the served prompt's. They are process-wide: with
// ScratchPad configured on two accounts of one gateway, the last one set
// wins, so configure it on one.

import { fileURLToPath } from "node:url";
import {
  resolveScratchPad as sharedResolveScratchPad,
  findSp as sharedFindSp,
  spBinary as sharedSpBinary,
  spPort as sharedSpPort,
  type AgentExtensionContext,
  type ScratchPad,
  type ScratchPadSettings,
  type SpLookup,
} from "@synadia-ai/agent-fabric";

export {
  exportScratchPad,
  SCRATCHPAD_OPTION,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  type ScratchPadSettings,
} from "@synadia-ai/agent-fabric";

/**
 * ScratchPad's settings, with the connection OpenClaw's channel takes: the
 * shared resolver, the credentials variables read as the channel reads
 * them, `NATS_CREDENTIALS` winning over `NATS_CREDS`
 * (`agents/openclaw/src/accounts.ts` in `synadia-agents`).
 *
 * Stated honestly: OpenClaw's channel keeps its account's `context` when
 * `NATS_CONTEXT` is set but empty, and counts a set-but-empty `NATS_URL` as
 * set. The add-on reads neither so: with `NATS_CONTEXT=""`, no variables and
 * an account that names only a context, the gateway connects by that context
 * and ScratchPad is off with its warning. No shipped way starts OpenClaw so.
 */
export function resolveScratchPad(
  ctx: AgentExtensionContext,
  env: Record<string, string | undefined>,
): Promise<ScratchPadSettings | undefined> {
  return sharedResolveScratchPad(ctx, env, { credsVariables: ["NATS_CREDENTIALS", "NATS_CREDS"] });
}

/** This package's skill directory: `src/` in the tests, `dist/` when installed, one level below it. */
export const SKILL_DIR = fileURLToPath(new URL("../skill/scratchpad", import.meta.url));

/**
 * The sp the add-on runs for its own ScratchPad steps: `SCRATCHPAD_BIN`, else
 * the binary this package ships for this machine, the first that is an
 * executable file, with what was passed over and why.
 */
export function findSp(env: Record<string, string | undefined>): SpLookup {
  return sharedFindSp(env, SKILL_DIR);
}

/** The sp of `findSp`, or `undefined` when there is none. */
export function spBinary(env: Record<string, string | undefined>): string | undefined {
  return sharedSpBinary(env, SKILL_DIR);
}

/** The ScratchPad port over this package's sp, for the extension's grants. */
export function spPort(
  settings: ScratchPadSettings,
  creator: string,
  env: Record<string, string | undefined>,
): ScratchPad | undefined {
  return sharedSpPort(settings, creator, env, SKILL_DIR);
}
