import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { NativeScratchPadError } from "./errors";
import { check, MAX_NODE_BYTES, parseStrictJSON, uint } from "./protocol";
import type { ContentObject, ObjectSpec } from "./protocol";
import { verifyObject } from "./codec";

const STATE_LIMIT = 128 * 1024;
// Shared by ESM/CJS copies too. Opening and closing another descriptor for the
// same database can release POSIX process locks, even with another SQLite user.
const OWNERS = Symbol.for("synadia.fabric.scratchpad.workspace-owners.v1");
const globals = globalThis as typeof globalThis & { [OWNERS]?: Set<string> };
const owners = (globals[OWNERS] ??= new Set<string>());

/** One private local database, exclusively owned for the client's lifetime. */
export class WorkspaceStore {
  private poisoned = false;
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly directory: string,
  ) {}

  static async open(directory: string): Promise<WorkspaceStore> {
    check(
      typeof directory === "string" && directory.length > 0,
      "a persistent workspace directory is required",
    );
    const [major, minor] = process.versions.node.split(".").map(Number);
    check(
      major! > 22 || (major === 22 && minor! >= 13),
      "native ScratchPad requires Node 22.13 or later",
    );
    const { DatabaseSync } = await import("node:sqlite");
    const requested = resolve(directory);
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(requested);
    check(
      directoryStat.isDirectory() && !directoryStat.isSymbolicLink(),
      "workspace must be a real directory",
    );
    check(
      process.platform === "win32" || (directoryStat.mode & 0o077) === 0,
      "workspace directory must have mode 0700",
    );
    const canonical = realpathSync(requested);
    if (owners.has(canonical))
      throw new NativeScratchPadError("busy", "workspace is already open in this process", {
        local: true,
      });
    owners.add(canonical);
    let db: DatabaseSync | undefined;
    try {
      const file = join(canonical, "scratchpad.sqlite");
      try {
        const fd = openSync(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        if (process.platform !== "win32") {
          const parent = openSync(canonical, constants.O_RDONLY);
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = lstatSync(file);
      check(
        stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
        "workspace database must be a private regular file",
      );
      check(
        process.platform === "win32" || (stat.mode & 0o077) === 0,
        "workspace database must have mode 0600",
      );
      db = new DatabaseSync(file);
      db.exec(
        "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; BEGIN EXCLUSIVE; COMMIT;",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS objects (kind TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, body BLOB NOT NULL, PRIMARY KEY(kind,id)); CREATE INDEX IF NOT EXISTS object_order ON objects(ordinal);",
      );
      return new WorkspaceStore(db, canonical);
    } catch (cause) {
      db?.close();
      owners.delete(canonical);
      if (cause instanceof NativeScratchPadError) throw cause;
      throw new NativeScratchPadError("busy", "cannot exclusively open the workspace database", {
        local: true,
        cause,
      });
    }
  }

  private usable(): void {
    check(
      !this.closed && !this.poisoned,
      "workspace is closed or had a write failure; close and reopen it",
    );
  }

  load(): unknown {
    this.usable();
    const row = this.db.prepare("SELECT value FROM state WHERE id=1").get();
    return row ? parseStrictJSON(String(row.value), STATE_LIMIT) : undefined;
  }

  save(state: unknown, afterRemote = false, clearObjects = false): void {
    this.usable();
    try {
      const json = JSON.stringify(state);
      check(Buffer.byteLength(json) <= STATE_LIMIT, "workspace metadata exceeds its byte bound");
      this.db.exec("BEGIN IMMEDIATE");
      this.db
        .prepare(
          "INSERT INTO state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        )
        .run(json);
      if (clearObjects) this.db.exec("DELETE FROM objects");
      this.db.exec("COMMIT");
    } catch (cause) {
      this.poisoned = true;
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw new NativeScratchPadError(
        "unavailable",
        "workspace write failed; close and reopen before recovery",
        { local: true, unknown: afterRemote, cause },
      );
    }
  }

  clearObjects(): void {
    this.usable();
    this.db.exec("DELETE FROM objects");
  }

  putObject(ordinal: number, object: ContentObject, data: Uint8Array): void {
    this.usable();
    uint(ordinal);
    check(data.length > 0 && data.length <= MAX_NODE_BYTES, "spool object exceeds bound");
    verifyObject(object, data);
    // DatabaseSync copies the callback's reused chunk buffer before returning.
    this.db
      .prepare(
        "INSERT INTO objects(kind,id,ordinal,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO NOTHING",
      )
      .run(object.kind, object.id, ordinal, data);
  }

  objects(): ObjectSpec[] {
    this.usable();
    return this.db
      .prepare("SELECT kind,id,length(body) AS length FROM objects ORDER BY ordinal")
      .all()
      .map((row) => ({
        object: { kind: row.kind as ContentObject["kind"], id: String(row.id) },
        length: Number(row.length),
      }));
  }

  bytes(object: ContentObject): Uint8Array {
    this.usable();
    const row = this.db
      .prepare("SELECT body FROM objects WHERE kind=? AND id=?")
      .get(object.kind, object.id);
    check(row?.body instanceof Uint8Array, "saved publication payload is missing");
    verifyObject(object, row.body);
    return row.body;
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
    owners.delete(this.directory);
  }
}
