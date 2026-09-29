# syntax=docker/dockerfile:1
# Named contexts: agents (protocol SDK) and scratchpad (the ScratchPad core source).
# Use the locally qualified agent images of the fabric's deployment. This reuses their locked
# development dependencies; it is not a clean public-package install check.
ARG NODE_IMAGE
ARG PYTHON_IMAGE
FROM ${NODE_IMAGE} AS node
FROM golang:1.26.7-bookworm AS go
FROM oven/bun:1.4.0 AS bun
FROM astral/uv:0.10 AS uv
FROM ${PYTHON_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=go /usr/local/go /usr/local/go
COPY --from=node /src/synadia-agents/client-sdk/typescript /src/synadia-agents/client-sdk/typescript
COPY --from=node /src/synadia-agents/agent-sdk/typescript /src/synadia-agents/agent-sdk/typescript
COPY --from=node /src/agent-fabric-sdk/typescript/node_modules /src/agent-fabric-sdk/typescript/node_modules
COPY --from=node /src/synadia-agents/client-sdk/typescript/bun.lock /tmp/client-sdk.lock
COPY --from=node /src/synadia-agents/agent-sdk/typescript/bun.lock /tmp/agent-sdk.lock
COPY --from=node /src/agent-fabric-sdk/typescript/package-lock.json /tmp/fabric-sdk.lock
# COPY merges directories. Remove inherited sources first so deleted checkout
# files cannot survive through the qualified image; keep dependencies only.
RUN rm -rf /src/synadia-agents/client-sdk/typescript/src /src/synadia-agents/client-sdk/typescript/dist \
    /src/synadia-agents/agent-sdk/typescript/src /src/synadia-agents/agent-sdk/typescript/dist \
    /src/synadia-agents/client-sdk/python/src /src/synadia-agents/agent-sdk/python/src \
    /src/agent-fabric-sdk/typescript/src /src/agent-fabric-sdk/typescript/dist \
    /src/agent-fabric-sdk/typescript/test /src/agent-fabric-sdk/typescript/scripts \
    /src/agent-fabric-sdk/python/src /src/agent-fabric-sdk/python/tests \
    /src/agent-fabric-sdk/scripts /src/agent-fabric-sdk/test-fixtures
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
ENV PATH=/usr/local/go/bin:$PATH CGO_ENABLED=0 \
    UV_PYTHON=/usr/local/bin/python3.12 UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy

# Build only the public protocol packages. Host environments are never copied.
WORKDIR /src/synadia-agents
COPY --from=agents client-sdk/typescript/package.json client-sdk/typescript/bun.lock client-sdk/typescript/tsconfig.json client-sdk/typescript/tsconfig.build.json client-sdk/typescript/tsup.config.ts ./client-sdk/typescript/
COPY --from=agents client-sdk/typescript/src ./client-sdk/typescript/src
COPY --from=agents agent-sdk/typescript/package.json agent-sdk/typescript/bun.lock agent-sdk/typescript/tsconfig.json agent-sdk/typescript/tsconfig.build.json agent-sdk/typescript/tsup.config.ts ./agent-sdk/typescript/
COPY --from=agents agent-sdk/typescript/src ./agent-sdk/typescript/src
RUN cmp client-sdk/typescript/bun.lock /tmp/client-sdk.lock \
    && cmp agent-sdk/typescript/bun.lock /tmp/agent-sdk.lock \
    && cd client-sdk/typescript && bun run build \
    && cd ../../agent-sdk/typescript && bun run build
COPY --from=agents client-sdk/python/pyproject.toml client-sdk/python/README.md client-sdk/python/uv.lock ./client-sdk/python/
COPY --from=agents client-sdk/python/src ./client-sdk/python/src
COPY --from=agents agent-sdk/python/pyproject.toml agent-sdk/python/README.md agent-sdk/python/uv.lock ./agent-sdk/python/
COPY --from=agents agent-sdk/python/src ./agent-sdk/python/src

WORKDIR /src/agent-fabric-sdk
COPY typescript/package.json typescript/package-lock.json typescript/tsconfig.json typescript/tsconfig.build.json typescript/tsup.config.ts typescript/vitest.config.ts ./typescript/
COPY typescript/src ./typescript/src
COPY typescript/test ./typescript/test
COPY typescript/scripts ./typescript/scripts
RUN cmp typescript/package-lock.json /tmp/fabric-sdk.lock && cd typescript && npm run build
COPY python/pyproject.toml python/README.md python/uv.lock python/THIRD_PARTY_NOTICES ./python/
COPY python/src ./python/src
COPY python/tests ./python/tests
RUN cd python && uv sync --frozen

WORKDIR /src/scratchpad
COPY --from=scratchpad go.mod go.sum ./
COPY --from=scratchpad api ./api
COPY --from=scratchpad client ./client
COPY --from=scratchpad codec ./codec
COPY --from=scratchpad naming ./naming
COPY --from=scratchpad internal ./internal
COPY --from=scratchpad third_party ./third_party
# Warm compilation before the measured run. Test fixtures still build their
# own executable from these exact sources and use their ordinary lifecycle.
RUN go test -c -o /tmp/native-fixture ./internal/volumeservice && rm /tmp/native-fixture
WORKDIR /src/agent-fabric-sdk/python
COPY scripts /src/agent-fabric-sdk/scripts
COPY test-fixtures /src/agent-fabric-sdk/test-fixtures
ENV SCRATCHPAD_CORE_ROOT=/src/scratchpad \
    SCRATCHPAD_TYPESCRIPT_PACKAGE=/src/agent-fabric-sdk/typescript \
    TMPDIR=/qualification/work
ENTRYPOINT ["uv", "run", "--no-sync", "python", "../scripts/native-linux/run.py"]
