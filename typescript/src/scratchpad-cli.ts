// The ready implementation of the ScratchPad port, through the `sp` command
// line. Mirrors `synadia_ai/agent_fabric/scratchpad_cli.py`.
//
// ScratchPad is the fabric's store for what agents produce: durable,
// permissioned volumes, every commit, grant and read written to the agent's
// timeline. This optional adapter drives the sp v2 command line.
// For direct NATS access, use nativeScratchPad from this package.
// The binary must be on the machine; it connects with the agent's own
// credentials. Five operations are all an
// agent needs:
//
//   commit(text, path)     publish the text as this agent's reply, retained
//                          for ten minutes, and return the reference the CLI
//                          made for it: one token that fits in a prompt
//   read(reference)        fetch the exact bytes the reference names
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
// are {@link ScratchPadClient}, which the native implementation also satisfies.
//
// Every call carries the served prompt's thread and root ids, so the
// commit, the grant and the read show up on the thread in the console next
// to the model calls that produced and consumed the content.
//
// The CLI keeps a small private workspace in `dir`: which volume this agent
// owns, and the one command it may still have to finish. A command whose
// outcome is unknown (the connection dropped after sending) stays pending
// there, and the CLI refuses any different command until that one is
// resolved. This never resets or replaces it; it only asks the CLI to
// finish the same command. Keep the directory across restarts.
//
// Each commit is a new root that holds only that reply, not every earlier
// one, and the CLI retains it for ten minutes in the same step. The volume
// has a few retention slots and a small content allowance. When they are
// full, this asks the CLI to release expired retention and collect content
// nothing retains any more, then tries the same commit once more. The
// refused commit leaves its prepared copy (the CLI's spool) in the
// workspace, and the CLI publishes nothing else until that is removed, so
// this first asks the CLI to remove it. It first
// reads the volume: with every retention slot held by a pin that cannot be
// released now, cleanup cannot free one, so the commit fails at once and
// the volume stays open for the agents reading earlier replies. A live
// handoff is never evicted to make room: the commit fails, and the agent
// answers in plain text instead. A cleanup the CLI cannot finish stays
// saved in the workspace; the next mutation asks the CLI to recover it, so
// an interrupted cleanup never leaves the volume closed.
//
// The CLI returns one token unchanged: service-issued `sp-r1:` or the
// existing `sp-ref:` form. resolveReference expands short metadata through
// `sp resolve`; a bounded cache helps creator and grant routing. Reads pass
// the original token to `sp read` so cached metadata never skips current
// token validity or content authorization. Python follows the same rules.
//
// Who may read: nobody but the volume's owner, until the owner grants it.
// The token is application data, not a credential: ScratchPad
// authenticates the reader as the `(account, user)` the server stamped on
// its connection and checks the grants on the volume. So a reference is
// handed over in two moves: a grant to the one agent that is about to
// receive it, then the prompt or reply that carries it. Least authority:
// one grantee, one root, one path, read only, a short expiry; nothing is
// granted when content is committed, and never to everyone discovered. A
// grant goes only to a principal in the reference's own account; the CLI
// refuses any other, and refuses to read another account's token.
//
// Being allowed to read is not being allowed to pass on. An agent handed a
// reference cannot let a third agent read it: ScratchPad has no
// delegation, on purpose. It does not copy the content into its own volume
// to get around that either; it asks the creator, and the creator decides
// (`grant-request.ts`). For that decision this keeps a ledger of whom this
// agent granted what, and how: first-hand, to an agent it handed the
// reference itself, or on request, to an agent someone else wanted to hand
// it to. Only the first kind entitles its holder to ask for another agent.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NatsConnectionSource } from "@synadia-ai/agents";
import {
  REFERENCE_PREFIX,
  type GrantKind,
  type Grantee,
  type ScratchPad,
  type TraceIds,
} from "./scratchpad.js";
import { activeTrace } from "./trace.js";
import {
  SHORT_REFERENCE_PREFIX,
  decodeShortReference,
  validateResolvedReference,
} from "./scratchpad-native/references";
import { encodeReference } from "./scratchpad-native/codec";
import { readScratchPadBootstrapFile } from "./scratchpad-native/bootstrap";

/**
 * The agent's ScratchPad: the {@link ScratchPad} port, which the rules for
 * references run on, and the commit and read the agent makes itself.
 */
export interface ScratchPadClient extends ScratchPad {
  /**
   * Publish `text` at `path` in this agent's volume, retained for ten
   * minutes, and return the reference token the CLI made for it.
   */
  commit(text: string, path: string, trace: TraceIds | undefined): Promise<string>;
  /** Fetch the exact content a reference token names, as text. */
  read(reference: string, trace: TraceIds | undefined): Promise<string>;
}

export interface SpCliScratchPadOptions {
  /**
   * The volume this agent writes to, by name: letters and digits only. The
   * deployment provisions it for the agent's account and user; the first
   * commit creates it.
   */
  readonly volume?: string;
  /** Exact public creation descriptor, imported by sp init. Requires a persistent dir. */
  readonly bootstrapFile?: string;
  /**
   * The agent's own connection source: `sp` authenticates the same way. It
   * takes a URL with a credentials file; it reads no NATS context, and an
   * nkey seed alone is not a form it accepts.
   */
  readonly nats: NatsConnectionSource;
  /** The `sp` binary. Default `sp` on PATH. */
  readonly bin?: string;
  /**
   * A private directory for the CLI's workspace; created if missing, and
   * used by its real path. Keep it across restarts: it records the volume
   * and any command still to finish. Default `scratchpad-<volume>` under
   * the temp directory.
   */
  readonly dir?: string;
  /** How long a read grant lasts, in seconds. Default and ceiling ten minutes. */
  readonly grantTtlS?: number;
  /**
   * This agent's prompt address, written into every reference it makes, so
   * an agent handed one knows whom to ask before passing it on. A commit
   * needs it.
   */
  readonly creator?: string;
}

/** The `sp` binary when none is given: the one on PATH. */
export const DEFAULT_SP_BIN = "sp";
/** How long a committed reply stays retained, and its reference valid. */
const HANDOFF_TTL_S = 600;
/**
 * How long a read grant lasts at most: long enough for the receiving agent
 * to read what it was handed when it starts on the prompt, short enough
 * that the access does not outlive the task. A grant also never outlives
 * the reference it is on.
 */
export const DEFAULT_GRANT_TTL_S = 600;
/**
 * Seconds a grant stays short of its reference's expiry. The CLI checks the
 * bound on its own clock a moment later, so a grant asked for to the exact
 * second could outlive the reference by the time it arrives.
 */
const EXPIRY_MARGIN_S = 5;
/** Live entries the grant ledger holds; ScratchPad itself has 16 grant slots. */
const MAX_LEDGER = 16;
/** A reference token's size bound, the CLI's. */
const MAX_REFERENCE_BYTES = 16 * 1024;
/** The largest file a read returns: the SDK's logical limit. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** A read's stdout: the file in base64, plus room for the JSON around it. */
const MAX_READ_STDOUT = Math.ceil(MAX_READ_BYTES / 3) * 4 + 64 * 1024;
/** Every other reply, and every error, is small. */
const MAX_STDOUT = 256 * 1024;
const MAX_STDERR = 64 * 1024;

const ACCOUNT_RE = /^A[A-Z2-7]{55}$/;
const VOLUME_RE = /^[0-9A-Za-z]{1,64}$/;
const CREATION_RE = /^[0-9a-f]{32}$/;
const ROOT_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** What a reference token holds, as the CLI writes it. No field is a credential. */
export interface Reference {
  readonly version: 2;
  readonly creator: string;
  readonly account: string;
  readonly target: Target;
  readonly root: string;
  readonly generation: number;
  readonly path: string;
  readonly retention: { readonly slot: number; readonly generation: number };
  readonly expires_at: number;
}

interface Target {
  readonly volume: string;
  readonly creation_id: string;
}

/** The volume this agent owns: whom the CLI authenticated, and the volume's exact incarnation. */
interface Binding {
  readonly account: string;
  readonly target: Target;
}

/**
 * A refusal or failure from `sp`: its error code, and whether the outcome
 * is unknown — a mutation that may still have taken effect.
 */
export class ScratchPadError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly unknown: boolean,
  ) {
    super(message);
    this.name = "ScratchPadError";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const hasKeys = (v: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => k in v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function validTarget(v: unknown): v is Target {
  return (
    isObject(v) &&
    hasKeys(v, ["volume", "creation_id"]) &&
    typeof v["volume"] === "string" &&
    VOLUME_RE.test(v["volume"]) &&
    typeof v["creation_id"] === "string" &&
    CREATION_RE.test(v["creation_id"])
  );
}

function validPath(p: unknown): p is string {
  if (typeof p !== "string" || !p.startsWith("/") || utf8Bytes(p) > 256) return false;
  if (p === "/") return true;
  return p
    .slice(1)
    .split("/")
    .every((name) => name !== "" && name !== "." && name !== "..");
}

/**
 * The token's fields, when its shape is right: the size bound, the prefix,
 * unpadded base64url, exactly the nine fields and their kinds. The CLI
 * checks the rest (canonical bytes, the path's names, the NKEY checksum).
 */
export function decodeReference(reference: string): Reference {
  const refuse = (why: string): never => {
    throw new Error(`malformed ScratchPad reference: ${why}`);
  };
  if (typeof reference !== "string" || !reference.startsWith(REFERENCE_PREFIX)) {
    refuse("no sp-ref: prefix");
  }
  if (reference.length > MAX_REFERENCE_BYTES) refuse("longer than 16 KiB");
  const body = reference.slice(REFERENCE_PREFIX.length);
  if (!BASE64URL_RE.test(body) || body.length % 4 === 1) refuse("not unpadded base64url");
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    refuse("not JSON");
  }
  const keys = [
    "version",
    "creator",
    "account",
    "target",
    "root",
    "generation",
    "path",
    "retention",
    "expires_at",
  ];
  if (!isObject(v) || !hasKeys(v, keys)) return refuse("not the version 2 fields");
  const r = v.retention;
  if (
    v["version"] !== 2 ||
    typeof v["creator"] !== "string" ||
    v["creator"].length === 0 ||
    utf8Bytes(v["creator"]) > 512 ||
    typeof v["account"] !== "string" ||
    !ACCOUNT_RE.test(v["account"]) ||
    !validTarget(v["target"]) ||
    typeof v["root"] !== "string" ||
    !ROOT_RE.test(v["root"]) ||
    !positive(v["generation"]) ||
    !validPath(v["path"]) ||
    !isObject(r) ||
    !hasKeys(r, ["slot", "generation"]) ||
    !Number.isSafeInteger(r["slot"]) ||
    (r["slot"] as number) < 0 ||
    (r["slot"] as number) > 7 ||
    !positive(r["generation"]) ||
    !positive(v["expires_at"])
  ) {
    refuse("a field is out of shape");
  }
  return v as unknown as Reference;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** The parts of the CLI's `describe` reply that decide whether cleanup can make room. */
export interface VolumeView {
  readonly closed: boolean;
  /** The saved request the CLI has not finished, by kind: `close`, `apply`, `release` or `grant`. */
  readonly control: string | undefined;
  readonly retentions: readonly {
    readonly generation: number;
    readonly until: number | undefined;
  }[];
  readonly grants: readonly {
    readonly slot: number;
    readonly generation: number;
    readonly until: number;
  }[];
}

const RETENTION_SLOTS = 8;
const GRANT_SLOTS = 16;
const CONTROL_KINDS = ["close", "apply", "release", "grant"];
/** The codes `describe` refuses with when the workspace holds no volume yet. */
const NO_VOLUME_CODES = ["workspace", "not_found"];
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * The volume view in a `describe` reply, checked field by field: exactly
 * eight retention slots and sixteen grant slots, each with the kinds the
 * CLI writes. Anything else is refused, never guessed at.
 */
export function decodeDescribe(reply: unknown): VolumeView {
  const refuse = (why: string): never => {
    throw new ScratchPadError(`sp describe: ${why}`, "malformed_reply", false);
  };
  if (!isObject(reply) || !isObject(reply["volume"])) return refuse("the reply names no volume");
  const volume = reply["volume"];
  const control = reply["control"];
  let kind: string | undefined;
  if (control !== null && control !== undefined) {
    if (
      !isObject(control) ||
      typeof control["kind"] !== "string" ||
      !CONTROL_KINDS.includes(control["kind"])
    ) {
      return refuse("the saved control request is out of shape");
    }
    kind = control["kind"];
  }
  if (typeof volume["closed"] !== "boolean") return refuse("the volume names no closed state");
  const retentions = volume["retentions"];
  const grants = volume["grants"];
  if (!Array.isArray(retentions) || retentions.length !== RETENTION_SLOTS)
    return refuse("not eight retention slots");
  if (!Array.isArray(grants) || grants.length !== GRANT_SLOTS)
    return refuse("not sixteen grant slots");
  const pins = retentions.map((slot: unknown) => {
    if (!isObject(slot) || !count(slot["generation"]))
      return refuse("a retention slot is out of shape");
    const pin = slot["pin"];
    if (pin === undefined || pin === null)
      return { generation: slot["generation"], until: undefined };
    if (!isObject(pin) || !count(pin["until"]) || typeof pin["root"] !== "string")
      return refuse("a retention pin is out of shape");
    return { generation: slot["generation"], until: pin["until"] };
  });
  const live: { slot: number; generation: number; until: number }[] = [];
  for (const slot of grants as unknown[]) {
    if (!isObject(slot) || !count(slot["generation"]))
      return refuse("a grant slot is out of shape");
    const grant = slot["grant"];
    if (grant === undefined || grant === null) continue;
    const handle = isObject(grant) ? grant["retention"] : undefined;
    if (
      !isObject(grant) ||
      !count(grant["until"]) ||
      !isObject(handle) ||
      !count(handle["slot"]) ||
      handle["slot"] >= RETENTION_SLOTS ||
      !positive(handle["generation"])
    ) {
      return refuse("a grant is out of shape");
    }
    live.push({
      slot: handle["slot"],
      generation: handle["generation"],
      until: grant["until"],
    });
  }
  return { closed: volume["closed"], control: kind, retentions: pins, grants: live };
}

/** The spool a `spool-remove` reply describes: whether one is there, and whether it went. */
export interface SpoolView {
  readonly present: boolean;
  readonly removable: boolean;
  readonly applied: boolean;
}

/**
 * A `spool-remove` or `spool-inspect` reply, checked field by field: exactly
 * `present`, `files`, `bytes`, `removable` and `applied`, and `phase` when,
 * and only when, a spool is present. Anything else is refused.
 */
export function decodeSpool(reply: unknown): SpoolView {
  const refuse = (why: string): never => {
    throw new ScratchPadError(`sp spool-remove: ${why}`, "malformed_reply", false);
  };
  if (!isObject(reply) || typeof reply["present"] !== "boolean")
    return refuse("the reply says no spool state");
  const present = reply["present"];
  const keys = ["present", "files", "bytes", "removable", "applied"];
  if (present) keys.push("phase");
  if (
    !hasKeys(reply, keys) ||
    (present && (typeof reply["phase"] !== "string" || reply["phase"] === "")) ||
    !count(reply["files"]) ||
    !count(reply["bytes"]) ||
    typeof reply["removable"] !== "boolean" ||
    typeof reply["applied"] !== "boolean"
  ) {
    return refuse("the spool state is out of shape");
  }
  return { present, removable: reply["removable"], applied: reply["applied"] };
}

/**
 * Why `maintain --apply` cannot make room for a retained commit now, or
 * `undefined` when it can: a slot is free, or an expired pin no live grant
 * names can be released. A closed volume with no saved cleanup of this
 * agent's is someone else's maintenance, and never reopened from here.
 */
export function cleanupCannotHelp(view: VolumeView, at: number = now()): string | undefined {
  const maintenance = view.control === "close" || view.control === "apply";
  if (view.closed && !maintenance)
    return "the volume is closed, and no cleanup of this agent's is saved";
  if (maintenance) return undefined; // finish the saved cleanup first
  const room = view.retentions.some(
    (pin, slot) =>
      pin.until === undefined || // free
      (pin.until !== 0 && // expired, and no live grant names this exact handle
        pin.until <= at &&
        !view.grants.some(
          (g) => g.slot === slot && g.generation === pin.generation && g.until > at,
        )),
  );
  return room ? undefined : "every retention slot holds a live pin";
}

/**
 * Commit, read and grant by reference, through one `sp` binary and one
 * volume: the {@link ScratchPadClient} an agent hands to
 * `scratchPadExtension()` and `grantRequestEndpoint()` and commits and reads
 * with itself.
 */
export function spCliScratchPad(options: SpCliScratchPadOptions): ScratchPadClient {
  const bootstrap =
    options.bootstrapFile === undefined
      ? undefined
      : readScratchPadBootstrapFile(options.bootstrapFile);
  const selectedVolume = options.volume ?? bootstrap?.volume;
  if (!selectedVolume || !VOLUME_RE.test(selectedVolume))
    throw new Error("ScratchPad: a valid volume or bootstrap file is required");
  const volumeName = selectedVolume;
  if (bootstrap && bootstrap.volume !== volumeName)
    throw new Error("ScratchPad: bootstrap differs from the configured volume");
  if (bootstrap && !options.dir)
    throw new Error("ScratchPad: bootstrap import requires a persistent dir");
  // `sp` takes a URL and a credentials file. It reads no NATS context, and
  // an nkey seed alone is not a form it accepts.
  if (!("creds" in options.nats) || options.nats.creds === undefined) {
    throw new Error(
      "ScratchPad: the sp CLI needs NATS_URL and NATS_CREDS; a NATS context or an nkey seed alone is not supported",
    );
  }
  const connection = ["--url", options.nats.url, "--creds", options.nats.creds];
  const bin = options.bin ?? DEFAULT_SP_BIN;
  const configuredDir = options.dir ?? join(tmpdir(), `scratchpad-${volumeName}`);
  const grantTtlS = Math.min(options.grantTtlS ?? DEFAULT_GRANT_TTL_S, DEFAULT_GRANT_TTL_S);

  // The CLI's workspace: the configured directory with every symlink
  // resolved, because on macOS both `/tmp` and `$TMPDIR` are symlinks.
  let dir: Promise<string> | undefined;
  // Which volume this agent owns, once the CLI has said so.
  let binding: Binding | undefined;
  // One mutation at a time (init, commit, maintenance, grant). The CLI
  // locks its workspace too; this keeps the agent's own calls in order
  // rather than having the CLI refuse the second of two at once.
  let mutations: Promise<unknown> = Promise.resolve();
  // Whether the workspace may hold a commit or a cleanup whose outcome is
  // unknown or unfinished: at start (a previous process may have left one),
  // after a commit that ended unknown, and after a cleanup that failed. The
  // next commit or grant first asks the CLI to recover it.
  let mayHavePending = true;
  // A grant whose outcome is unknown: its exact arguments, to finish before
  // any other grant, because the CLI refuses a different one meanwhile.
  let pendingGrant: { args: string[]; key: string; kind: GrantKind; ref: Reference } | undefined;

  // Whom this agent granted read: the account, the volume's incarnation,
  // the root, the path and the grantee, to the expiry of its latest grant
  // of each kind. ScratchPad knows the grants but not how they came about;
  // that is this agent's own knowledge. In memory, so one ledger per
  // process: after a restart, or in another instance behind the same
  // address, the answer is "not granted", which is the safe one.
  const ledger = new Map<string, Partial<Record<GrantKind, number>>>();

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = mutations.then(work);
    mutations = next.catch(() => undefined);
    return next;
  }

  const expansions = new Map<string, Reference>();
  async function resolveReference(token: string, trace?: TraceIds): Promise<Reference> {
    if (!token.startsWith(SHORT_REFERENCE_PREFIX)) return decodeReference(token);
    decodeShortReference(token);
    const cached = expansions.get(token);
    if (cached && cached.expires_at > now()) return structuredClone(cached);
    const reply = await sp<{ reference: unknown; full_reference: string }>(
      "resolve",
      ["--ref", token],
      { trace },
    );
    const pair = { short: token, expanded: reply?.reference };
    validateResolvedReference(pair);
    if (reply.full_reference !== encodeReference(pair.expanded))
      throw new ScratchPadError(
        "sp resolve: expanded token differs from descriptor",
        "malformed_reply",
        false,
      );
    const ref = decodeReference(reply.full_reference);
    if (ref.expires_at <= now()) throw new Error("the reference has expired");
    expansions.delete(token);
    expansions.set(token, ref);
    if (expansions.size > 64) expansions.delete(expansions.keys().next().value!);
    return structuredClone(ref);
  }

  async function workspace(): Promise<string> {
    dir ??= (async () => {
      await mkdir(configuredDir, { recursive: true, mode: 0o700 });
      return realpath(configuredDir);
    })();
    return dir;
  }

  async function sp<T>(
    command: string,
    args: string[],
    opts: {
      trace?: TraceIds | undefined;
      toolCallId?: string | undefined;
      stdin?: string;
      maxStdout?: number;
      mutation?: boolean;
    } = {},
  ): Promise<T> {
    const trace = opts.trace
      ? ["--thread-id", opts.trace.threadId, "--root-id", opts.trace.rootId]
      : [];
    if (opts.trace && opts.toolCallId !== undefined) trace.push("--tool-call-id", opts.toolCallId);
    // A read targets the reference's volume, which can belong to another agent.
    const volume = ["read", "resolve"].includes(command) ? [] : ["--volume", volumeName];
    const bootstrapArgs =
      command === "init" && options.bootstrapFile
        ? ["--bootstrap-file", options.bootstrapFile]
        : [];
    const argv = [
      command,
      ...connection,
      "--dir",
      await workspace(),
      ...volume,
      ...bootstrapArgs,
      ...args,
      ...trace,
    ];
    const maxStdout = opts.maxStdout ?? MAX_STDOUT;
    const { code, stdout, stderr } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = execFile(
        bin,
        argv,
        { maxBuffer: Math.max(maxStdout, MAX_STDERR), encoding: "utf8" },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
          resolve({
            code: e === null ? 0 : typeof e.code === "number" ? e.code : null,
            stdout: stdout ?? "",
            stderr: stderr || (e !== null && typeof e.code === "string" ? e.message : ""),
          });
        },
      );
      child.stdin?.end(opts.stdin ?? "");
    });
    if (code === null && /^spawn .*(ENOENT|EACCES)/m.test(stderr)) {
      // Not started: nothing was sent.
      throw new ScratchPadError(`sp ${command}: ${stderr.trim()}`, "spawn_failed", false);
    }
    if (code === 0 && stdout.length <= maxStdout) {
      try {
        return JSON.parse(stdout) as T;
      } catch {
        // Fall through: a mutation whose reply cannot be read may still
        // have happened.
      }
    }
    // A refusal is JSON on stderr: `{"error": {"code", "message", "unknown"}}`.
    // Anything else from a mutation (a crash, a cut-off reply) proves nothing
    // about whether it took effect, so it counts as unknown.
    let failure: { code: string; message: string; unknown: boolean } = {
      code: code === 0 ? "malformed_reply" : "failed",
      message: stderr.trim().slice(0, 512) || `exit ${code ?? "by signal"}`,
      unknown: opts.mutation === true,
    };
    if (code !== 0) {
      try {
        const e = (JSON.parse(stderr) as { error?: Record<string, unknown> }).error;
        if (isObject(e) && typeof e["code"] === "string") {
          failure = {
            code: e["code"],
            message: typeof e["message"] === "string" ? e["message"] : "",
            unknown:
              e["unknown"] === true ||
              (opts.mutation === true && typeof e["unknown"] !== "boolean"),
          };
        }
      } catch {
        // Not JSON: keep the conservative reading above.
      }
    }
    throw new ScratchPadError(
      `sp ${command}: ${failure.code}${failure.unknown ? " (outcome unknown)" : ""}: ${failure.message}`,
      failure.code,
      failure.unknown,
    );
  }

  function bind(reply: unknown, command: string): Binding {
    const r = reply as { principal?: { account?: unknown }; target?: unknown };
    const account = r?.principal?.account;
    if (typeof account !== "string" || !ACCOUNT_RE.test(account) || !validTarget(r.target)) {
      throw new ScratchPadError(
        `sp ${command}: the reply names no principal and target`,
        "malformed_reply",
        false,
      );
    }
    if (r.target.volume !== volumeName) {
      throw new ScratchPadError(
        `sp ${command}: the workspace is bound to another volume`,
        "invalid",
        false,
      );
    }
    return { account, target: { volume: r.target.volume, creation_id: r.target.creation_id } };
  }

  // Create the volume, or resume it: the CLI makes this safe to repeat.
  async function init(trace: TraceIds | undefined): Promise<Binding> {
    binding ??= bind(await sp("init", [], { trace, mutation: true }), "init");
    return binding;
  }

  // The volume this agent owns, without creating it: `undefined` when the
  // workspace was never initialized, which the CLI refuses as `workspace`
  // ("run init"). A workspace bound to another volume or principal answers
  // the same, and the next commit's `init` reports it.
  async function describe(trace: TraceIds | undefined): Promise<Binding | undefined> {
    if (binding !== undefined) return binding;
    try {
      binding = bind(await sp("describe", [], { trace }), "describe");
    } catch (err) {
      if (err instanceof ScratchPadError && NO_VOLUME_CODES.includes(err.code)) return undefined;
      throw err;
    }
    return binding;
  }

  const ownedBy = (ref: Reference, b: Binding | undefined): boolean =>
    b !== undefined &&
    ref.account === b.account &&
    ref.target.volume === b.target.volume &&
    ref.target.creation_id === b.target.creation_id;

  const ledgerKey = (ref: Reference, grantee: Grantee): string =>
    JSON.stringify([
      ref.account,
      ref.target.volume,
      ref.target.creation_id,
      ref.root,
      ref.path,
      grantee.account,
      grantee.user,
    ]);

  function prune(): void {
    const t = now();
    for (const [key, until] of ledger) {
      if (Math.max(until["first-hand"] ?? 0, until["on-request"] ?? 0) <= t) ledger.delete(key);
    }
  }

  function record(key: string, kind: GrantKind, expiresAt: number): void {
    ledger.set(key, { ...ledger.get(key), [kind]: expiresAt });
  }

  // The expiry the CLI reports for a grant, never later than the reference's.
  function grantExpiry(reply: unknown, ref: Reference): number {
    const r = reply as { handle?: unknown; expires_at?: unknown };
    if (!isObject(r) || !isObject(r.handle) || !positive(r.expires_at)) {
      throw new ScratchPadError(
        "sp grant: the reply names no handle and expiry",
        "malformed_reply",
        true,
      );
    }
    return Math.min(r.expires_at, ref.expires_at);
  }

  async function publish(
    bytes: string,
    path: string,
    operationId: string,
    trace: TraceIds | undefined,
  ): Promise<unknown> {
    return sp(
      "publish-file",
      [
        "--source",
        "-",
        "--path",
        path,
        "--operation-id",
        operationId,
        "--creator",
        options.creator!,
        "--ttl-seconds",
        String(HANDOFF_TTL_S),
      ],
      { trace, stdin: bytes, mutation: true },
    );
  }

  // Finish what an earlier call may have left unresolved: a commit or a
  // saved cleanup. This repeats that exact request; it never starts another
  // one. A definite refusal (nothing pending, say) lets the new mutation go
  // ahead, and the CLI refuses that one too if something is still pending.
  async function recover(trace: TraceIds | undefined): Promise<void> {
    if (!mayHavePending) return;
    try {
      await sp("recover", [], { trace, mutation: true });
    } catch (err) {
      if (!(err instanceof ScratchPadError) || err.unknown) throw err;
    }
    mayHavePending = false;
  }

  // After a definite refusal of a commit: remove the spool its preparation
  // left in the workspace, which the CLI requires before any other
  // publication. The CLI removes only a spool of this workspace's that no
  // unresolved command protects; one it keeps means the refused command is
  // still pending, and the next mutation recovers it first.
  async function removeRefusedSpool(
    refusal: ScratchPadError,
    trace: TraceIds | undefined,
  ): Promise<void> {
    let why: string;
    try {
      const spool = decodeSpool(await sp("spool-remove", ["--apply"], { trace, mutation: true }));
      if (!spool.present || spool.applied) return;
      why = "the refused publication's spool is protected";
    } catch (err) {
      if (err instanceof ScratchPadError && err.unknown) throw err;
      why = `its spool was not removed: ${(err as Error).message}`;
    }
    mayHavePending = true;
    throw new ScratchPadError(
      `${refusal.message}; cleanup not started: ${why}`,
      refusal.code,
      false,
    );
  }

  // The volume's current slots and state, as the CLI describes them.
  async function volumeView(trace: TraceIds | undefined): Promise<VolumeView> {
    return decodeDescribe(await sp("describe", [], { trace }));
  }

  async function commit(text: string, path: string, trace: TraceIds | undefined): Promise<string> {
    if (options.creator === undefined) {
      throw new Error(
        "ScratchPad: a reference names its creator; this ScratchPad was made without one",
      );
    }
    const own = await init(trace);
    await recover(trace);
    const operationId = randomUUID();
    let reply: unknown;
    try {
      reply = await publish(text, path, operationId, trace);
    } catch (err) {
      if (err instanceof ScratchPadError && err.unknown) mayHavePending = true;
      if (!(err instanceof ScratchPadError) || err.code !== "capacity" || err.unknown) throw err;
      // Full: release expired retention and collect what nothing retains,
      // then the same commit once more, but only when cleanup can make room.
      // The CLI releases only expired retention; a live handoff stays.
      await removeRefusedSpool(err, trace);
      let reason: string | undefined;
      try {
        reason = cleanupCannotHelp(await volumeView(trace));
      } catch (inspect) {
        // Unread, nothing is known about the slots: close nothing.
        throw new ScratchPadError(
          `${err.message}; cleanup not started: ${(inspect as Error).message}`,
          err.code,
          false,
        );
      }
      if (reason !== undefined)
        throw new ScratchPadError(
          `${err.message}; cleanup not started: ${reason}`,
          err.code,
          false,
        );
      try {
        await sp("maintain", ["--apply"], { trace, mutation: true });
      } catch (cleanup) {
        // The CLI keeps the unfinished cleanup saved; recover finishes it
        // before the next mutation. An unknown cleanup stays unknown.
        mayHavePending = true;
        const unknown = !(cleanup instanceof ScratchPadError) || cleanup.unknown;
        throw new ScratchPadError(
          `${err.message}; cleanup: ${(cleanup as Error).message}`,
          unknown && cleanup instanceof ScratchPadError
            ? cleanup.code
            : unknown
              ? "failed"
              : err.code,
          unknown,
        );
      }
      try {
        reply = await publish(text, path, operationId, trace);
      } catch (again) {
        if (again instanceof ScratchPadError && again.unknown) mayHavePending = true;
        throw again;
      }
    }
    const token = (reply as { reference?: unknown } | null)?.reference;
    if (typeof token !== "string" || !isObject((reply as { receipt?: unknown }).receipt)) {
      mayHavePending = true;
      throw new ScratchPadError(
        "sp publish-file: the reply names no receipt and reference",
        "malformed_reply",
        true,
      );
    }
    const ref = await resolveReference(token, trace);
    if (!ownedBy(ref, own) || ref.path !== path || ref.creator !== options.creator) {
      throw new ScratchPadError(
        "sp publish-file: the reference names another volume, path or creator",
        "malformed_reply",
        false,
      );
    }
    // Exactly the token the CLI made.
    return token;
  }

  async function runGrant(
    args: string[],
    trace: TraceIds | undefined,
    toolCallId: string | undefined,
    ref: Reference,
  ): Promise<number> {
    return grantExpiry(await sp("grant", args, { trace, toolCallId, mutation: true }), ref);
  }

  async function grantRead(
    reference: string,
    grantee: Grantee,
    trace: TraceIds | undefined,
    toolCallId: string | undefined,
    kind: GrantKind,
  ): Promise<void> {
    const ref = await resolveReference(reference, trace);
    if (!ownedBy(ref, await describe(trace))) {
      // Only a volume's owner grants on it. Reading someone else's content
      // and granting on a copy would pass on a permission this agent was
      // never given; its creator is asked instead.
      throw new Error(
        "the reference points into another agent's volume; only its creator can grant read on it",
      );
    }
    await recover(trace);
    if (pendingGrant !== undefined) {
      // Finish the grant that ended unknown, with its exact arguments,
      // before any other: the CLI refuses a different one meanwhile.
      const earlier = pendingGrant;
      try {
        record(
          earlier.key,
          earlier.kind,
          await runGrant(earlier.args, undefined, undefined, earlier.ref),
        );
        pendingGrant = undefined;
      } catch (err) {
        if (!(err instanceof ScratchPadError) || err.unknown) throw err;
        pendingGrant = undefined;
      }
    }
    const remaining = ref.expires_at - now() - EXPIRY_MARGIN_S;
    const ttl = Math.floor(Math.min(grantTtlS, remaining));
    if (ttl < 1)
      throw new Error(
        "the reference has expired, or is about to; there is nothing left to grant on",
      );
    const key = ledgerKey(ref, grantee);
    prune();
    if (!ledger.has(key) && ledger.size >= MAX_LEDGER) {
      // The ledger stays finite. ScratchPad has 16 grant slots too.
      throw new Error(
        `this agent already holds ${MAX_LEDGER} live grants; try again when one expires`,
      );
    }
    const trail = trace ? ["--thread-id", trace.threadId, "--root-id", trace.rootId] : [];
    if (trace && toolCallId !== undefined) trail.push("--tool-call-id", toolCallId);
    const args = [
      "--ref",
      reference,
      "--grantee-account",
      grantee.account,
      "--grantee-user",
      grantee.user,
      "--operation-id",
      randomUUID(),
      "--ttl-seconds",
      String(ttl),
    ];
    try {
      record(key, kind, await runGrant(args, trace, toolCallId, ref));
    } catch (err) {
      // Unknown: the grant may exist, but the ledger says nothing until the
      // CLI confirms it. The same arguments, trace labels included, go again
      // before the next grant.
      if (err instanceof ScratchPadError && err.unknown)
        pendingGrant = { args: [...args, ...trail], key, kind, ref };
      throw err;
    }
  }

  const pad: ScratchPadClient = {
    commit(text, path, trace) {
      return serialize(() => commit(text, path, trace));
    },

    async read(reference, trace) {
      const ref = await resolveReference(reference, trace);
      // An expired reference opens nothing; the CLI would refuse it too.
      if (ref.expires_at <= now()) throw new Error("the reference has expired");
      const got = await sp<{ data_base64?: unknown; bytes?: unknown }>(
        "read",
        ["--ref", reference],
        {
          trace,
          maxStdout: MAX_READ_STDOUT,
        },
      );
      const { data_base64: data, bytes } = got ?? {};
      if (
        typeof data !== "string" ||
        !BASE64_RE.test(data) ||
        !Number.isSafeInteger(bytes) ||
        (bytes as number) > MAX_READ_BYTES
      ) {
        throw new ScratchPadError("sp read: the reply carries no data", "malformed_reply", false);
      }
      const raw = Buffer.from(data, "base64");
      if (raw.length !== bytes || raw.toString("base64") !== data) {
        throw new ScratchPadError(
          "sp read: the data does not match its length",
          "malformed_reply",
          false,
        );
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        throw new Error("the referenced file is not UTF-8 text");
      }
    },

    resolveReference,

    async owns(reference) {
      // A token that does not decode is nobody's. An agent that has
      // committed nothing yet has no volume, and owns nothing; asking never
      // creates one. The port passes no thread; inside a served prompt the
      // question still goes on that prompt's thread.
      let ref: Reference;
      try {
        ref = await resolveReference(reference);
      } catch {
        return false;
      }
      return ownedBy(ref, await describe(activeTrace()));
    },

    grantRead(reference, grantee, trace, toolCallId, kind = "first-hand") {
      return serialize(() => grantRead(reference, grantee, trace, toolCallId, kind));
    },

    granted(reference, grantee) {
      const find = (ref: Reference): GrantKind | undefined => {
        if (!ownedBy(ref, binding)) return undefined;
        const until = ledger.get(ledgerKey(ref, grantee)),
          t = now();
        if ((until?.["first-hand"] ?? 0) > t) return "first-hand";
        if ((until?.["on-request"] ?? 0) > t) return "on-request";
        return undefined;
      };
      if (reference.startsWith(SHORT_REFERENCE_PREFIX))
        return resolveReference(reference).then(find, () => undefined);
      try {
        return find(decodeReference(reference));
      } catch {
        return undefined;
      }
    },
  };
  return pad;
}

/** The variables {@link scratchPadFromEnv} reads. */
export const SCRATCHPAD_VOLUME_VAR = "SCRATCHPAD_VOLUME";
export const SCRATCHPAD_BOOTSTRAP_FILE_VAR = "SCRATCHPAD_BOOTSTRAP_FILE";
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
 * when both `SCRATCHPAD_VOLUME` and `SCRATCHPAD_BOOTSTRAP_FILE` are unset. Reads
 * `SCRATCHPAD_VOLUME`, `SCRATCHPAD_BIN`, `SCRATCHPAD_DIR` and
 * `SCRATCHPAD_GRANT_TTL_S`, and, unless `options.nats` is given, the
 * connection the agent's own configuration reads: `NATS_CREDS` with
 * `NATS_URL` (default `nats://127.0.0.1:4222`), or `NATS_CONTEXT`, which
 * `sp` cannot use. An empty variable counts as unset. Throws for a grant TTL
 * that is not a positive number, and, like {@link spCliScratchPad}, for a
 * connection `sp` cannot use: a NATS context without credentials, or no
 * credentials at all.
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
  const bootstrapFile = optional(SCRATCHPAD_BOOTSTRAP_FILE_VAR);
  if (volume === undefined && bootstrapFile === undefined) return undefined;
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
  // `sp` reads no NATS context: the credentials file, when there is one,
  // even beside a context, and otherwise the context, which is refused.
  const nats: NatsConnectionSource =
    options.nats ??
    (creds !== undefined ? { url, creds } : context !== undefined ? { context } : { url });
  const bin = optional(SCRATCHPAD_BIN_VAR);
  const dir = optional(SCRATCHPAD_DIR_VAR);
  return spCliScratchPad({
    ...(volume === undefined ? {} : { volume }),
    ...(bootstrapFile === undefined ? {} : { bootstrapFile }),
    nats,
    ...(bin !== undefined ? { bin } : {}),
    ...(dir !== undefined ? { dir } : {}),
    ...(grantTtlS !== undefined ? { grantTtlS } : {}),
    ...(options.creator !== undefined ? { creator: options.creator } : {}),
  });
}
