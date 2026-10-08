// dotenv.ts — the agent's `.env`, read when there is one, as the Python
// agent reads its own. Values already in the environment win over the
// file's, so `eval "$(fabric env <name>)"` and a `.env` both work, and a
// variable exported by hand overrides the file. A file named with Node's
// `--env-file` replaces this one: `.env` is not read on top of it.
//
// Imported first by every entry point, before anything reads the
// environment.

import { existsSync } from "node:fs";

const named = process.execArgv.some((a) => a === "--env-file" || a.startsWith("--env-file="));
if (!named && existsSync(".env")) process.loadEnvFile(".env");
