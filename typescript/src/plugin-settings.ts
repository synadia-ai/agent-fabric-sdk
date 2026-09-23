// The harness add-ons' one setting, the edge subject, read the same way by
// every add-on under `plugins/` (`docs/plugins.md` §3.1). TypeScript only,
// like the plugins; the subject itself is validated where tracing takes it
// (`assertValidTraceOptions`).

import { DEFAULT_EDGE_SUBJECT } from "./trace.js";

/** The one setting: the edge subject, in the config entry's `options`. */
export const EDGE_SUBJECT_OPTION = "edgeSubject";

/** The same setting as a variable, read when the option is not given. */
export const EDGE_SUBJECT_VAR = "SYNADIA_FABRIC_EDGE_SUBJECT";

/**
 * The edge subject an add-on runs with: the config entry's
 * `options.edgeSubject` when the key is there (`null` is propagate-only:
 * lineage without records), else `SYNADIA_FABRIC_EDGE_SUBJECT` when set,
 * else the fabric's default. The value is returned as given; the package
 * validates it (`assertValidTraceOptions`) and throws for one that can
 * never be published to, which stops the add-on's factory — the plugin
 * then logs the error and starts plain, so a misconfigured subject is
 * visible at start rather than as a warning on every prompt.
 */
export function resolveEdgeSubject(
  options: Readonly<Record<string, unknown>>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (Object.hasOwn(options, EDGE_SUBJECT_OPTION)) {
    // The runtime type is the package's to check, so the cast claims nothing.
    return options[EDGE_SUBJECT_OPTION] as string | null;
  }
  const fromEnv = env[EDGE_SUBJECT_VAR];
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_EDGE_SUBJECT;
}
