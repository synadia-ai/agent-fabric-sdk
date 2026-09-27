// ScratchPad for Claude Code's model (`docs/plugins.md` §9): the pieces every
// add-on shares, from the fabric package (`plugin-scratchpad.ts` there), with
// this package's copy of the skill (`skills/scratchpad`, installed by
// `npm run build:sp` from `plugins/scratchpad-skill`), and the one piece
// Claude Code needs of its own: the file the variables go to.
//
// This module runs in the NATS channel plugin's MCP server, a child of
// Claude Code and a sibling of the Bash tool's processes, so nothing it sets
// in its own environment reaches `scripts/sp` (§9.4). So it keeps the
// variables in a file, `<state dir>/agent-fabric/<CLAUDE_PID>.env`, rewritten
// whole on every change, and this package's own Claude Code hook
// (`hooks/session-start.sh`, at SessionStart) names that file to the Bash
// tool as `SP_ENV_FILE`, which `scripts/sp` reads on every call. So the
// served prompt's trace and caller reach each call, per turn, with nothing
// from the operator but loading this package as a plugin, which the skill
// needs anyway.

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spBinary as sharedSpBinary,
  spPort as sharedSpPort,
  SP_VARS,
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
export const SKILL_DIR = fileURLToPath(new URL("../skills/scratchpad", import.meta.url));

/** The variable that names the file to `scripts/sp`, set by the package's hook. */
export const SP_ENV_FILE_VAR = "SP_ENV_FILE";

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

/**
 * The file for the Claude Code process this server runs under:
 * `<stateDir>/agent-fabric/<pid>.env`, where the hook looks for it. The pid
 * is `CLAUDE_PID`, which Claude Code hands its hooks and its MCP servers
 * alike, else the parent's, as the plugin keys its own files.
 */
export function spEnvFilePath(
  stateDir: string,
  env: Record<string, string | undefined>,
  parentPid: number = process.ppid,
): string {
  const pid = env["CLAUDE_PID"];
  return join(
    stateDir,
    "agent-fabric",
    `${pid !== undefined && /^\d+$/.test(pid) ? pid : String(parentPid)}.env`,
  );
}

// The names `scripts/sp` takes from the file; nothing else is written.
const NAMES: ReadonlySet<string> = new Set(Object.values(SP_VARS));

/**
 * The variables `scripts/sp` reads, kept as a plain object (the one the
 * shared pieces set and clear) and written to the file after each change.
 */
export class SpEnvFile {
  /** What the shared pieces set and clear; `write()` puts it in the file. */
  readonly vars: Record<string, string | undefined> = {};

  constructor(readonly path: string) {}

  /**
   * The file, whole, through a rename, so `scripts/sp` reads one state or
   * the next. A value with a line break could not be read back, so it is
   * left out. Throws what the file system throws.
   */
  write(): void {
    let text = "";
    for (const [name, value] of Object.entries(this.vars)) {
      if (!NAMES.has(name) || value === undefined || /[\r\n]/.test(value)) continue;
      text += `${name}=${value}\n`;
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const staging = `${this.path}.${process.pid}.tmp`;
    writeFileSync(staging, text, { mode: 0o600 });
    renameSync(staging, this.path);
  }

  /** Removes the file, when the server stops; `scripts/sp` then finds no configuration. */
  remove(): void {
    rmSync(this.path, { force: true });
  }
}
