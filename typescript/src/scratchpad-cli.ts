// The ready implementation of the ScratchPad port, through the `sp` command
// line. Mirrors `synadia_ai/agent_fabric/scratchpad_cli.py`.
//
// ScratchPad is the fabric's store for what agents produce: durable,
// permissioned, versioned volumes, every commit, grant and read written to
// the agent's timeline. There is no ScratchPad client for TypeScript yet,
// so this drives the `sp` CLI from the ScratchPad repository
// (`go build ./cmd/sp`), which is the Go client kit with a command per API
// verb. The binary must be on the machine; it connects with the agent's own
// credentials. Five operations are all an agent needs:
//
//   commit(text, path)     put the text into this agent's volume, commit it,
//                          make a reference to it, and return that reference
//                          as one token that fits in a prompt
//   read(reference)        resolve the token (which records the read) and
//                          fetch the content
//   owns(reference)        whether the token points into this agent's own
//                          volume, the only one it may grant on
//   grantRead(reference,   let one agent read what the reference points at,
//             grantee)     for a short while — the last thing done before a
//                          reference leaves this agent
//   granted(reference,     whom this agent granted read, and how: the
//           grantee)       ledger a grant request is decided by
//
// The last three are the {@link ScratchPad} port the extension and the
// grant request run on; the first two are the agent's own. Together they
// are {@link ScratchPadClient}, which a later implementation speaking NATS
// directly will satisfy as well, once a TypeScript ScratchPad client exists.
//
// Every call carries the served prompt's thread and root ids, so the
// commit, the grant and the read show up on the thread in the console next
// to the model calls that produced and consumed the content.
//
// The token: `sp-ref:` followed by the `ref.make` reply, base64url-encoded:
// the ref record ScratchPad mints for a handoff (the volume, the immutable
// root, the path, its expiry) and the source sequence the CLI wants back
// when resolving it — plus `creator`, the prompt address of the agent that
// committed the content, so an agent handed the reference knows whom to ask
// when it wants to hand it on (`referenceCreator`). A model copies the token
// from one reply into the next prompt without understanding it; the
// receiving agent decodes it. The Python package writes and reads the same
// token.
//
// Who may read: nobody but the volume's owner, until the owner grants it.
// The token is application data, not a credential (ScratchPad's ADR-0001);
// ScratchPad authenticates the reader as the `(account, user)` the server
// stamped on its connection and checks the grants on the volume. So a
// reference is handed over in two moves: a grant to the one agent that is
// about to receive it, then the prompt or reply that carries it. Least
// authority: one grantee, one path, read only, a short expiry; nothing is
// granted when content is committed, and never to everyone discovered.
//
// Being allowed to read is not being allowed to pass on. An agent handed a
// reference cannot let a third agent read it: ScratchPad v1 has no
// delegation, on purpose. It does not copy the content into its own volume
// to get around that either; it asks the creator, and the creator decides
// (`grant-request.ts`). For that decision this keeps a ledger of whom this
// agent granted what, and how: first-hand, to an agent it handed the
// reference itself, or on request, to an agent someone else wanted to hand
// it to. Only the first kind entitles its holder to ask for another agent.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { NatsConnectionSource } from "@synadia-ai/agents";
import { REFERENCE_PREFIX, type GrantKind, type ScratchPad, type TraceIds } from "./scratchpad.js";
import { activeTrace } from "./trace.js";

const run = promisify(execFile);

/**
 * The agent's ScratchPad: the {@link ScratchPad} port, which the rules for
 * references run on, and the commit and read the agent makes itself.
 */
export interface ScratchPadClient extends ScratchPad {
  /** Put `text` at `path` in this agent's volume, commit, and return the reference token. */
  commit(text: string, path: string, trace: TraceIds | undefined): Promise<string>;
  /** Resolve a reference token (recording the read) and return the content. */
  read(reference: string, trace: TraceIds | undefined): Promise<string>;
}

export interface SpCliScratchPadOptions {
  /** The volume this agent writes to, by name; created on first commit. */
  readonly volume: string;
  /**
   * The agent's own connection source: `sp` authenticates the same way. It
   * takes a NATS context or a URL with a credentials file; an nkey seed
   * alone is not a form it accepts.
   */
  readonly nats: NatsConnectionSource;
  /** The `sp` binary. Default `sp` on PATH. */
  readonly bin?: string;
  /**
   * A private directory for the CLI's saved replies; created if missing,
   * and used by its real path. Default `scratchpad-<volume>` under the
   * temp directory.
   */
  readonly dir?: string;
  /** How long a read grant lasts, in seconds. Default ten minutes. */
  readonly grantTtlS?: number;
  /**
   * This agent's prompt address, written into every reference it makes, so
   * an agent handed one knows whom to ask before passing it on.
   */
  readonly creator?: string;
}

/** The `sp` binary when none is given: the one on PATH. */
export const DEFAULT_SP_BIN = "sp";
/** How long a handoff reference stays resolvable: a week. */
const REFERENCE_TTL_S = 7 * 24 * 3600;
/** How long a write session stays open. */
const SESSION_LEASE_S = 600;
/**
 * How long a read grant lasts: long enough for the receiving agent to read
 * what it was handed when it starts on the prompt, short enough that the
 * access does not outlive the task. The reference itself lasts a week; the
 * grant is what actually opens the door.
 */
export const DEFAULT_GRANT_TTL_S = 600;

// What ScratchPad's `ref.make` returns: the ref record and the sequence the
// CLI checks the projection against when resolving. `creator` is the
// fabric's addition to the token, not ScratchPad's.
interface RefMakeReply {
  readonly ref: Ref;
  readonly source_sequence: number;
  readonly creator?: string;
}

interface Ref {
  readonly type: string;
  readonly handoff_id: string;
  readonly volume_id: string;
  readonly root: string;
  readonly path?: string;
  readonly expires_at: number;
  readonly [key: string]: unknown;
}

function decodeReference(reference: string): RefMakeReply {
  if (!reference.startsWith(REFERENCE_PREFIX)) {
    throw new Error(`not a ScratchPad reference: ${reference.slice(0, 20)}`);
  }
  try {
    return JSON.parse(
      Buffer.from(reference.slice(REFERENCE_PREFIX.length), "base64url").toString(),
    ) as RefMakeReply;
  } catch {
    throw new Error("malformed ScratchPad reference");
  }
}

/**
 * Commit, read and grant by reference, through one `sp` binary and one
 * volume: the {@link ScratchPadClient} an agent hands to
 * `scratchPadExtension()` and `grantRequestEndpoint()` and commits and reads
 * with itself.
 */
export function spCliScratchPad(options: SpCliScratchPadOptions): ScratchPadClient {
  // `sp` takes a NATS context or a credentials file; an nkey seed alone is
  // not a form it accepts.
  const connection: string[] =
    "context" in options.nats && options.nats.context !== undefined
      ? ["-context", options.nats.context]
      : "creds" in options.nats && options.nats.creds !== undefined
        ? ["-url", options.nats.url, "-creds", options.nats.creds]
        : [];
  if (connection.length === 0) {
    throw new Error("ScratchPad: the sp CLI needs NATS_CREDS or NATS_CONTEXT to authenticate");
  }
  const bin = options.bin ?? DEFAULT_SP_BIN;
  const configuredDir = options.dir ?? join(tmpdir(), `scratchpad-${options.volume}`);
  const grantTtlS = options.grantTtlS ?? DEFAULT_GRANT_TTL_S;

  // The volume's id and current root, learned on first use and advanced by
  // every commit.
  let volume: { id: string; root: string } | undefined;
  let ready = false;
  // Where the CLI's saved replies go: the configured directory with every
  // symlink resolved. `sp` refuses to save under a path with a symlink in
  // it, and on macOS both `/tmp` and `$TMPDIR` are symlinks.
  let dir = configuredDir;
  // One commit at a time. Each starts a session on the volume's current
  // root and advances it, and the host serves several prompts at once, so
  // two commits side by side would both start from the same root.
  let commits: Promise<unknown> = Promise.resolve();

  // Whom this agent granted read, by path: identity to the expiry, in unix
  // seconds, of its latest grant of each kind. ScratchPad knows the grants
  // but not how they came about; that is this agent's own knowledge. In
  // memory, so one ledger per process: after a restart, or in another
  // instance behind the same address, the answer is "not granted", which is
  // the safe one.
  const ledger = new Map<string, Map<string, Partial<Record<GrantKind, number>>>>();

  async function sp<T>(
    args: string[],
    trace: TraceIds | undefined,
    stdin?: string,
    toolCallId?: string,
  ): Promise<T> {
    const traceFlags = trace ? ["-thread-id", trace.threadId, "-root-id", trace.rootId] : [];
    if (trace && toolCallId !== undefined) traceFlags.push("-tool-call-id", toolCallId);
    const full = [...args, ...connection, ...traceFlags, "-json"];
    try {
      const child = run(bin, full, { maxBuffer: 64 * 1024 * 1024 });
      if (stdin !== undefined) {
        child.child.stdin?.end(stdin);
      }
      const { stdout } = await child;
      return JSON.parse(stdout) as T;
    } catch (err) {
      // A failure is JSON on stderr (`{"error": {"code": "permission_denied", …}}`)
      // with exit 13; the code is what the log line should say.
      const e = err as { stderr?: string; message?: string };
      throw new Error(`sp ${args.slice(0, 2).join(" ")}: ${(e.stderr ?? e.message ?? "").trim()}`);
    }
  }

  async function ensureDir(): Promise<void> {
    if (ready) return;
    await mkdir(configuredDir, { recursive: true, mode: 0o700 });
    dir = await realpath(configuredDir);
    ready = true;
  }

  // This agent's volume if it has one already; looking never creates it.
  async function findVolume(
    trace: TraceIds | undefined,
  ): Promise<{ id: string; root: string } | undefined> {
    if (volume !== undefined) return volume;
    await ensureDir();
    const listed = await sp<{ volumes?: { id: string; name?: string; root: string }[] }>(
      ["volume", "list"],
      trace,
    );
    const found = listed.volumes?.find((v) => v.name === options.volume);
    if (found !== undefined) volume = { id: found.id, root: found.root };
    return volume;
  }

  async function ensureVolume(trace: TraceIds | undefined): Promise<{ id: string; root: string }> {
    const found = await findVolume(trace);
    if (found !== undefined) return found;
    const created = await sp<{ volume: { id: string; root: string } }>(
      ["volume", "create", "-name", options.volume, "-operation-id", randomUUID()],
      trace,
    );
    volume = { id: created.volume.id, root: created.volume.root };
    return volume;
  }

  async function commit(text: string, path: string, trace: TraceIds | undefined): Promise<string> {
    const v = await ensureVolume(trace);
    const stem = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}`);
    // A write session on the current root, one put, one commit: the
    // receipt names the new root, which is what a reference points at.
    await sp(
      [
        "session",
        "open",
        "-volume-id",
        v.id,
        "-base-root",
        v.root,
        "-write-scope",
        "/",
        "-lease-seconds",
        String(SESSION_LEASE_S),
        "-save",
        `${stem}.session.json`,
      ],
      trace,
    );
    await sp(
      [
        "put",
        "-session",
        `${stem}.session.json`,
        "-path",
        path,
        "-source",
        "-",
        "-save",
        `${stem}.change.json`,
      ],
      trace,
      text,
    );
    const committed = await sp<{ receipt: { new_root: string } }>(
      [
        "commit",
        "-session",
        `${stem}.session.json`,
        "-changes",
        `${stem}.change.json`,
        "-operation-id",
        randomUUID(),
        "-apply",
      ],
      trace,
    );
    v.root = committed.receipt.new_root;
    const made = await sp<RefMakeReply>(
      [
        "ref",
        "make",
        "-volume-id",
        v.id,
        "-root",
        v.root,
        "-path",
        path,
        "-expires-at",
        String(Math.floor(Date.now() / 1000) + REFERENCE_TTL_S),
        "-save",
        `${stem}.ref.json`,
      ],
      trace,
    );
    const token: RefMakeReply =
      options.creator !== undefined ? { ...made, creator: options.creator } : made;
    return REFERENCE_PREFIX + Buffer.from(JSON.stringify(token)).toString("base64url");
  }

  const pad: ScratchPadClient = {
    commit(text, path, trace) {
      const next = commits.then(() => commit(text, path, trace));
      commits = next.catch(() => undefined);
      return next;
    },

    async read(reference, trace) {
      const { ref, source_sequence } = decodeReference(reference);
      await ensureDir();
      // Resolving records the read on this agent's timeline and checks the
      // handoff is still valid; the content itself comes with `cat`. The
      // CLI gets back what `ref.make` replied, without the token's `creator`.
      const file = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.resolve.json`);
      await writeFile(file, JSON.stringify({ ref, source_sequence }));
      await sp(["ref", "resolve", "-ref", file], trace);
      const got = await sp<{ data_base64?: string; data?: string }>(
        ["cat", "-volume-id", ref.volume_id, "-root", ref.root, "-path", ref.path ?? "/"],
        trace,
      );
      if (got.data_base64 !== undefined)
        return Buffer.from(got.data_base64, "base64").toString("utf8");
      if (got.data !== undefined) return got.data;
      throw new Error("sp cat: reply carries no data");
    },

    async owns(reference) {
      // An agent that has committed nothing yet has no volume, and owns
      // nothing. The port passes no thread; inside a served prompt the
      // listing that answers this still goes on that prompt's thread.
      return decodeReference(reference).ref.volume_id === (await findVolume(activeTrace()))?.id;
    },

    async grantRead(reference, grantee, trace, toolCallId, kind = "first-hand") {
      const own = await findVolume(trace);
      const ref = decodeReference(reference).ref;
      if (own === undefined || ref.volume_id !== own.id) {
        // Only a volume's owner grants on it. Reading someone else's content
        // and granting on a copy would pass on a permission this agent was
        // never given; its creator is asked instead.
        throw new Error(
          "the reference points into another agent's volume; only its creator can grant read on it",
        );
      }
      const path = ref.path ?? "/";
      const expiresAt = Math.floor(Date.now() / 1000) + grantTtlS;
      // The scope is the one path the reference names, not the root: a
      // grant on the root would open every file at that commit, this
      // agent's earlier replies included. ScratchPad takes one scope kind
      // per grant.
      await sp(
        [
          "grant",
          "issue",
          "-volume-id",
          own.id,
          "-grantee-account",
          grantee.account,
          "-grantee-user",
          grantee.user,
          "-subtree",
          path,
          "-actions",
          "read",
          "-expires-at",
          String(expiresAt),
          "-operation-id",
          randomUUID(),
        ],
        trace,
        undefined,
        toolCallId,
      );
      // Into the ledger, and expired entries out of it.
      const now = Math.floor(Date.now() / 1000);
      for (const [p, readers] of ledger) {
        for (const [who, until] of readers) {
          if (Math.max(until["first-hand"] ?? 0, until["on-request"] ?? 0) <= now) {
            readers.delete(who);
          }
        }
        if (readers.size === 0) ledger.delete(p);
      }
      const readers = ledger.get(path) ?? new Map<string, Partial<Record<GrantKind, number>>>();
      const who = `${grantee.account}.${grantee.user}`;
      readers.set(who, { ...readers.get(who), [kind]: expiresAt });
      ledger.set(path, readers);
    },

    granted(reference, grantee) {
      let ref: Ref;
      try {
        ref = decodeReference(reference).ref;
      } catch {
        return undefined;
      }
      if (volume === undefined || ref.volume_id !== volume.id) return undefined;
      const until = ledger.get(ref.path ?? "/")?.get(`${grantee.account}.${grantee.user}`);
      const now = Math.floor(Date.now() / 1000);
      if ((until?.["first-hand"] ?? 0) > now) return "first-hand";
      if ((until?.["on-request"] ?? 0) > now) return "on-request";
      return undefined;
    },
  };
  return pad;
}

/** The variables {@link scratchPadFromEnv} reads. */
export const SCRATCHPAD_VOLUME_VAR = "SCRATCHPAD_VOLUME";
export const SCRATCHPAD_BIN_VAR = "SCRATCHPAD_BIN";
export const SCRATCHPAD_DIR_VAR = "SCRATCHPAD_DIR";
export const SCRATCHPAD_GRANT_TTL_S_VAR = "SCRATCHPAD_GRANT_TTL_S";

/** What {@link scratchPadFromEnv} takes besides the environment. */
export interface ScratchPadFromEnvOptions {
  /** This agent's prompt address, written into every reference it makes. */
  readonly creator?: string;
  /**
   * The agent's connection source, when it is not the environment's
   * `NATS_CONTEXT`, or `NATS_CREDS` with `NATS_URL`.
   */
  readonly nats?: NatsConnectionSource;
}

/**
 * The agent's ScratchPad as the environment configures it, or `undefined`
 * when `SCRATCHPAD_VOLUME` is unset: ScratchPad off. Reads
 * `SCRATCHPAD_VOLUME`, `SCRATCHPAD_BIN`, `SCRATCHPAD_DIR` and
 * `SCRATCHPAD_GRANT_TTL_S`, and, unless `options.nats` is given, the
 * connection the agent's own configuration reads: `NATS_CONTEXT`, or
 * `NATS_CREDS` with `NATS_URL` (default `nats://127.0.0.1:4222`). An empty
 * variable counts as unset. Throws for a grant TTL that is not a positive
 * number, and, like {@link spCliScratchPad}, for a connection `sp` cannot
 * use.
 */
export function scratchPadFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: ScratchPadFromEnvOptions = {},
): ScratchPadClient | undefined {
  const optional = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const volume = optional(SCRATCHPAD_VOLUME_VAR);
  if (volume === undefined) return undefined;
  const ttl = optional(SCRATCHPAD_GRANT_TTL_S_VAR);
  let grantTtlS: number | undefined;
  if (ttl !== undefined) {
    grantTtlS = Number(ttl);
    if (!Number.isFinite(grantTtlS) || grantTtlS <= 0) {
      throw new Error(`${SCRATCHPAD_GRANT_TTL_S_VAR} must be a positive number, got "${ttl}"`);
    }
  }
  const context = optional("NATS_CONTEXT");
  const creds = optional("NATS_CREDS");
  const url = optional("NATS_URL") ?? "nats://127.0.0.1:4222";
  const nats: NatsConnectionSource =
    options.nats ??
    (context !== undefined ? { context } : creds !== undefined ? { url, creds } : { url });
  const bin = optional(SCRATCHPAD_BIN_VAR);
  const dir = optional(SCRATCHPAD_DIR_VAR);
  return spCliScratchPad({
    volume,
    nats,
    ...(bin !== undefined ? { bin } : {}),
    ...(dir !== undefined ? { dir } : {}),
    ...(grantTtlS !== undefined ? { grantTtlS } : {}),
    ...(options.creator !== undefined ? { creator: options.creator } : {}),
  });
}
