# The two reference agents. They run against a fabric that already stands: a
# NATS URL and credentials, the model proxy and a virtual key, and ScratchPad
# if you use it. `typescript/env.example` and `python/env.example` list what
# an agent is told.
#
#   make setup      install both agents' packages; builds the SDK in the checkout
#                   below and this repository's package first, until they are published
#   make agent-ts   run the TypeScript agent from typescript/.env
#   make agent-py   run the Python agent from python/.env
#   make test       both agents' tests (test-ts, test-py); nats-server on PATH.
#                   The durable tests spawn the durable engine: DE_ENGINE (a
#                   -dev build) and DE_LICENCE, or built from ../durable-engine
#                   at the thin SDK's engine.pin with Go; they skip without it

# Until the protocol SDK is published, it comes from this checkout, next to
# this repository, on this branch. `make setup` refuses another branch unless
# ANY_BRANCH=1. The fabric package is this repository's own: ../typescript
# and ../python.
SDK_DIR       := synadia-agents
SDK_BRANCH    := main
ANY_BRANCH    ?=
# The thin durable SDK, for the durable workflows (AGENT_DURABLE=1, the
# durable agent): from its checkout next to this repository, until it is
# published. The engine behind it is ../durable-engine, built by the tests.
DE_DIR        := durable-sdk

.PHONY: setup agent-ts test-ts agent-py test-py test test-reply-controls

# The packages, built and installed. Safe to run twice.
setup:
	@SDK_DIR=$(SDK_DIR) SDK_BRANCH=$(SDK_BRANCH) ANY_BRANCH=$(ANY_BRANCH) DE_DIR=$(DE_DIR) scripts/setup.sh

# One TypeScript agent, configured by typescript/.env.
agent-ts:
	cd typescript && npm start

# The TypeScript tests: the agent tools as the agent wires them, and the agent, on a throwaway nats-server.
test-ts:
	cd typescript && npm run typecheck && npm test

# One Python agent, configured by python/.env.
agent-py:
	cd python && uv run python -m fabric_agent

# The Python tests: the same two, plus the TypeScript agent and the Python one prompting each other.
test-py:
	cd python && uv run pytest -q

# Everything.
test: test-ts test-py

# The destination is explicit because the controls retain isolated source copies.
test-reply-controls:
	@test -n "$(REPLY_EVIDENCE)" || (echo 'Set REPLY_EVIDENCE to a new absolute evidence directory'; exit 2)
	uv run --script test-fixtures/reply_controls.py --evidence "$(REPLY_EVIDENCE)"
