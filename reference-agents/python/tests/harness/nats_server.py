"""A throwaway nats-server for the tests: one process on a free port, with the
users the test asks for, torn down after. The binary must be on PATH
(``brew install nats-server``); when it is not, the tests skip.

Identity on the fabric is ``(account, user)`` NATS keys, so every party in a
test gets its own freshly generated user key. Nothing is committed; nothing
outlives the process. The same harness as the TypeScript agent's.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import nkeys
from nacl.signing import SigningKey


@dataclass(frozen=True)
class NatsUser:
    public_key: str
    #: The seed as text, what the SDK's ``signer_from_seed`` and the connect option take.
    seed: str


def new_user() -> NatsUser:
    """A fresh user key pair: an ed25519 seed in the nkeys text form, its public key."""
    raw = bytes(SigningKey.generate())
    seed = nkeys.encode_seed(raw, nkeys.PREFIX_BYTE_USER).decode("ascii")
    public = nkeys.from_seed(seed.encode()).public_key
    return NatsUser(public_key=public.decode("ascii") if isinstance(public, bytes) else str(public), seed=seed)


def nats_server_on_path() -> str | None:
    return shutil.which("nats-server")


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _tcp_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.2)
        try:
            s.connect(("127.0.0.1", port))
            return True
        except OSError:
            return False


class LocalNatsServer:
    def __init__(self, url: str, proc: subprocess.Popen[bytes], directory: Path) -> None:
        self.url = url
        self._proc = proc
        self._dir = directory

    @classmethod
    def start(cls, binary: str, users: list[NatsUser]) -> LocalNatsServer:
        """Start a server that accepts exactly ``users``, all in the server's default account."""
        directory = Path(tempfile.mkdtemp(prefix="fabric-examples-nats-"))
        config = directory / "server.conf"
        entries = ", ".join(f'{{ nkey: "{u.public_key}" }}' for u in users)
        config.write_text(f"authorization {{ users: [ {entries} ] }}\n", encoding="utf-8")
        return cls._launch(binary, directory, config)

    @classmethod
    def start_tenant(cls, binary: str, users: list[NatsUser], *, max_streams: int) -> LocalNatsServer:
        """Start a server with JetStream whose ``users`` are in one account
        ``TENANT``, under the limits a tenant's tier sets: file storage only,
        ``max_bytes`` required on every stream, and ``max_streams`` streams."""
        directory = Path(tempfile.mkdtemp(prefix="fabric-examples-nats-"))
        config = directory / "server.conf"
        entries = ", ".join(f'{{ nkey: "{u.public_key}" }}' for u in users)
        config.write_text(
            f'jetstream {{ store_dir: "{directory / "js"}" }}\n'
            f"accounts {{ TENANT {{ users: [ {entries} ], jetstream {{ max_streams: {max_streams}, "
            "max_mem: 0, max_file: 4GB, max_bytes_required: true } } }\n",
            encoding="utf-8",
        )
        return cls._launch(binary, directory, config)

    @classmethod
    def start_with_config(cls, binary: str, config: Path) -> LocalNatsServer:
        """Start a server from a port-less configuration file, such as the
        operator-mode one in this repository's ``test-fixtures/identity/``,
        whose users connect with ``.creds`` files: a real ``(account, user)``
        identity, and credentials ScratchPad's CLI takes."""
        directory = Path(tempfile.mkdtemp(prefix="fabric-examples-nats-"))
        return cls._launch(binary, directory, config)

    @classmethod
    def _launch(cls, binary: str, directory: Path, config: Path) -> LocalNatsServer:
        port = _free_port()
        log = open(directory / "server.log", "wb")  # noqa: SIM115 — closed with the process
        proc = subprocess.Popen(
            [binary, "-a", "127.0.0.1", "-p", str(port), "-c", str(config)],
            stdout=subprocess.DEVNULL,
            stderr=log,
        )
        deadline = time.monotonic() + 5.0
        while not _tcp_open(port):
            if proc.poll() is not None:
                tail = (directory / "server.log").read_text(errors="replace")[-2000:]
                shutil.rmtree(directory, ignore_errors=True)
                raise RuntimeError(f"nats-server exited with {proc.returncode}: {tail}")
            if time.monotonic() > deadline:
                proc.kill()
                shutil.rmtree(directory, ignore_errors=True)
                raise RuntimeError(f"nats-server did not listen on {port} in time")
            time.sleep(0.05)
        return cls(f"nats://127.0.0.1:{port}", proc, directory)

    def stop(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()
        shutil.rmtree(self._dir, ignore_errors=True)

    def write_seed_file(self, user: NatsUser, name: str) -> str:
        """The user's seed in a file, the way an agent reads its credentials."""
        path = self._dir / f"{name}.nk"
        path.write_text(user.seed + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
        return str(path)
