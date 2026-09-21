"""Pytest fixtures for the synadia-ai-agent-fabric test suite.

Real nats-servers (session-scoped, started lazily on first use) over the
identity fixtures vendored under ``test-fixtures/identity/``: an open one,
``nkey-noaccounts.conf`` (alice as an nkey user in ``$G``), and the
operator-mode topology (``operator/operator.conf``, alice in ACME), whose
``{account NKEY}.{user NKEY}`` agent IDs are the form the edge schema
requires.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

import nats
import pytest
import pytest_asyncio

from tests.harness.nats_server import (
    RunningServer,
    find_nats_server,
    identity_fixture,
    start_server,
)
from tests.support import NkeyUser

if TYPE_CHECKING:
    from nats.aio.client import Client as NATSClient


def _server(
    tmp_path_factory: pytest.TempPathFactory, config: str | None
) -> Iterator[RunningServer]:
    if find_nats_server() is None:
        pytest.skip(
            "nats-server not on PATH — integration tests skipped. "
            "Install with `brew install nats-server` (macOS) or see "
            "https://docs.nats.io/running-a-nats-service/introduction/installation"
        )
    log_dir = tmp_path_factory.mktemp("nats-server-logs")
    config_path = identity_fixture(config) if config is not None else None
    server = start_server(log_dir, config_path=config_path)
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture(scope="session")
def nats_server(tmp_path_factory: pytest.TempPathFactory) -> Iterator[RunningServer]:
    """No auth."""
    yield from _server(tmp_path_factory, None)


@pytest.fixture(scope="session")
def nats_server_nkey(tmp_path_factory: pytest.TempPathFactory) -> Iterator[RunningServer]:
    """``nkey-noaccounts.conf``: alice as an nkey user in the global account ``$G``."""
    yield from _server(tmp_path_factory, "nkey-noaccounts.conf")


@pytest.fixture(scope="session")
def nats_server_operator(tmp_path_factory: pytest.TempPathFactory) -> Iterator[RunningServer]:
    """``operator/operator.conf``: operator mode, alice in ACME."""
    yield from _server(tmp_path_factory, "operator/operator.conf")


@pytest_asyncio.fixture
async def nc(nats_server: RunningServer) -> AsyncIterator[NATSClient]:
    """A connected NATS client on the open server, closed on teardown."""
    client = await nats.connect(nats_server.url)
    try:
        yield client
    finally:
        await client.close()


@pytest.fixture(scope="session")
def identity_keys() -> dict[str, NkeyUser]:
    """The throwaway users in ``keys.json``, by name."""
    raw = json.loads(identity_fixture("keys.json").read_text(encoding="utf-8"))
    return {
        name: NkeyUser(name=name, public=user["public"], seed=user["seed"])
        for name, user in raw["users"].items()
    }


class ConnectNkeyUser(Protocol):
    """``await connect_nkey_user(server, "alice", **nats_connect_kwargs)``."""

    def __call__(
        self, server: RunningServer, name: str, /, **kwargs: Any
    ) -> Awaitable[NATSClient]: ...


class ConnectCreds(Protocol):
    """``await connect_creds(server, path)``."""

    def __call__(self, server: RunningServer, creds: Path, /) -> Awaitable[NATSClient]: ...


@pytest_asyncio.fixture
async def connect_nkey_user(identity_keys: dict[str, NkeyUser]) -> AsyncIterator[ConnectNkeyUser]:
    """Factory: connect to *server* as a ``keys.json`` user; closed on teardown."""
    opened: list[NATSClient] = []

    async def _connect(server: RunningServer, name: str, /, **kwargs: Any) -> NATSClient:
        client = await nats.connect(server.url, nkeys_seed_str=identity_keys[name].seed, **kwargs)
        opened.append(client)
        return client

    try:
        yield _connect
    finally:
        for client in opened:
            if not client.is_closed:
                await client.close()


@pytest_asyncio.fixture
async def connect_creds() -> AsyncIterator[ConnectCreds]:
    """Factory: connect to *server* with a ``.creds`` file; closed on teardown."""
    opened: list[NATSClient] = []

    async def _connect(server: RunningServer, creds: Path, /) -> NATSClient:
        client = await nats.connect(server.url, user_credentials=str(creds))
        opened.append(client)
        return client

    try:
        yield _connect
    finally:
        for client in opened:
            if not client.is_closed:
                await client.close()
