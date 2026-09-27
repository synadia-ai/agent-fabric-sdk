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
  spBinary as sharedSpBinary,
  spPort as sharedSpPort,
  type ScratchPad,
  type ScratchPadSettings,
} from "@synadia-ai/agent-fabric";

export {
  exportScratchPad,
  resolveScratchPad,
  SCRATCHPAD_OPTION,
  ScratchPadHandOn,
  ServedPromptEnv,
  SP_VARS,
  type ScratchPadSettings,
} from "@synadia-ai/agent-fabric";

/** This package's skill directory: `src/` in the tests, `dist/` when installed, one level below it. */
export const SKILL_DIR = fileURLToPath(new URL("../skill/scratchpad", import.meta.url));

/** The sp binary this package ships for this machine, or `SCRATCHPAD_BIN`. */
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
