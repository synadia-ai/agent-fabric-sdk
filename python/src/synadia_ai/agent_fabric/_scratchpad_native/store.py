"""Current client state and one stable artifact, in an exclusively owned database."""

from __future__ import annotations

import json
import os
import sqlite3
import stat
from pathlib import Path
from typing import Any

from .codec import verify_object
from .errors import NativeScratchPadError
from .protocol import MAX_NODE_BYTES, check, parse_strict_json

STATE_LIMIT = 128 * 1024
_owners: set[Path] = set()


class WorkspaceStore:
    """Only this connection may access its database while the client is open."""

    def __init__(self, db: sqlite3.Connection, directory: Path) -> None:
        self._db = db
        self._directory = directory
        self._closed = False
        self._poisoned = False

    @classmethod
    def open(cls, directory: str | os.PathLike[str]) -> WorkspaceStore:
        check(bool(str(directory)), "a persistent workspace directory is required")
        requested = Path(directory).absolute()
        requested.mkdir(parents=True, exist_ok=True, mode=0o700)
        attributes = requested.lstat()
        check(stat.S_ISDIR(attributes.st_mode), "workspace must be a real directory")
        check(
            os.name == "nt" or attributes.st_mode & 0o077 == 0,
            "workspace directory must have mode 0700",
        )
        canonical = requested.resolve()
        if canonical in _owners:
            raise NativeScratchPadError(
                "busy", "workspace is already open in this process", local=True
            )
        _owners.add(canonical)
        db: sqlite3.Connection | None = None
        try:
            file = canonical / "scratchpad.sqlite"
            try:
                descriptor = os.open(
                    file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600
                )
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                if os.name != "nt":
                    parent = os.open(canonical, os.O_RDONLY)
                    try:
                        os.fsync(parent)
                    finally:
                        os.close(parent)
            except FileExistsError:
                pass
            attributes = file.lstat()
            check(
                stat.S_ISREG(attributes.st_mode) and attributes.st_nlink == 1,
                "workspace database must be a private regular file",
            )
            check(
                os.name == "nt" or attributes.st_mode & 0o077 == 0,
                "workspace database must have mode 0600",
            )
            db = sqlite3.connect(file, timeout=0, isolation_level=None)
            db.row_factory = sqlite3.Row
            db.executescript("""
                PRAGMA busy_timeout=0;
                PRAGMA locking_mode=EXCLUSIVE;
                PRAGMA journal_mode=DELETE;
                PRAGMA synchronous=EXTRA;
                PRAGMA fullfsync=ON;
                BEGIN EXCLUSIVE;
                COMMIT;
                CREATE TABLE IF NOT EXISTS state
                    (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS objects
                    (kind TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL,
                     body BLOB NOT NULL, PRIMARY KEY(kind,id));
                CREATE INDEX IF NOT EXISTS object_order ON objects(ordinal);
            """)
            return cls(db, canonical)
        except BaseException as cause:
            if db is not None:
                db.close()
            _owners.discard(canonical)
            if isinstance(cause, (NativeScratchPadError, KeyboardInterrupt, SystemExit)):
                raise
            raise NativeScratchPadError(
                "busy", "cannot exclusively open workspace database", local=True, cause=cause
            ) from cause

    def _usable(self) -> None:
        check(
            not self._closed and not self._poisoned,
            "workspace is closed or had a write failure; close and reopen it",
        )

    def load(self) -> Any:
        self._usable()
        row = self._db.execute("SELECT value FROM state WHERE id=1").fetchone()
        return parse_strict_json(row["value"], STATE_LIMIT) if row else None

    def save(
        self, state: dict[str, Any], *, after_remote: bool = False, clear_objects: bool = False
    ) -> None:
        self._usable()
        try:
            encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            check(len(encoded.encode()) <= STATE_LIMIT, "workspace metadata exceeds byte bound")
            self._db.execute("BEGIN IMMEDIATE")
            self._db.execute(
                "INSERT INTO state(id,value) VALUES(1,?) "
                "ON CONFLICT(id) DO UPDATE SET value=excluded.value",
                (encoded,),
            )
            if clear_objects:
                self._db.execute("DELETE FROM objects")
            self._db.execute("COMMIT")
        except Exception as cause:
            self._poisoned = True
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            raise NativeScratchPadError(
                "unavailable",
                "workspace write failed; close and reopen before recovery",
                local=True,
                unknown=after_remote,
                cause=cause,
            ) from cause

    def clear_objects(self) -> None:
        self._usable()
        self._db.execute("DELETE FROM objects")

    def put_object(self, ordinal: int, content: dict[str, Any], data: bytes) -> None:
        self._usable()
        check(0 < len(data) <= MAX_NODE_BYTES, "spool object exceeds byte bound")
        verify_object(content, data)
        self._db.execute(
            "INSERT INTO objects(kind,id,ordinal,body) VALUES(?,?,?,?) "
            "ON CONFLICT(kind,id) DO NOTHING",
            (content["kind"], content["id"], ordinal, data),
        )

    def objects(self) -> list[dict[str, Any]]:
        self._usable()
        return [
            {"object": {"kind": row["kind"], "id": row["id"]}, "length": row["length"]}
            for row in self._db.execute(
                "SELECT kind,id,length(body) AS length FROM objects ORDER BY ordinal"
            )
        ]

    def bytes(self, content: dict[str, Any]) -> bytes:
        self._usable()
        row = self._db.execute(
            "SELECT body FROM objects WHERE kind=? AND id=?", (content["kind"], content["id"])
        ).fetchone()
        check(row is not None and isinstance(row["body"], bytes), "saved payload is missing")
        data: bytes = row["body"]
        verify_object(content, data)
        return data

    def close(self) -> None:
        if not self._closed:
            self._db.close()
            self._closed = True
            _owners.discard(self._directory)
