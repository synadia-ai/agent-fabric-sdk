// ScratchPad for PI's model (`docs/plugins.md` §9): the pieces every add-on
// shares, from the fabric package (`plugin-scratchpad.ts` there), with this
// package's copy of the skill (`skill/scratchpad`, installed by
// `npm run build:sp` from `plugins/scratchpad-skill`). PI's bash tool passes
// PI's process environment to every command it runs (measured on PI 0.85.1,
// §9.4), and the plugin hands PI one prompt at a time, so the per-prompt
// variables are sound; a command PI runs for local typing during a remote
// turn gets the served prompt's (§7, "PI's turn boundaries").

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
