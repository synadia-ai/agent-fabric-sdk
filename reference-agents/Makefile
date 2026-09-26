# The two reference agents. They run against a fabric that already stands: a
# NATS URL and credentials, the model proxy and a virtual key, and ScratchPad
# if you use it. `typescript/env.example` and `python/env.example` list what
# an agent is told.
#
#   make setup      install both agents' packages; builds the SDK in the checkout
#                   below and this repository's package first, until they are published
#   make agent-ts   run the TypeScript agent from typescript/.env
#   make agent-py   run the Python agent from python/.env
#   make test       both agents' tests (test-ts, test-py); nats-server on PATH

# Until the protocol SDK is published, it comes from this checkout, next to
# this repository, on this branch. `make setup` refuses another branch unless
# ANY_BRANCH=1. The fabric package is this repository's own: ../typescript
# and ../python.
SDK_DIR       := synadia-agents
SDK_BRANCH    := sdk-release-rollout
ANY_BRANCH    ?=

.PHONY: setup agent-ts test-ts agent-py test-py test

# The packages, built and installed. Safe to run twice.
setup:
	@SDK_DIR=$(SDK_DIR) SDK_BRANCH=$(SDK_BRANCH) ANY_BRANCH=$(ANY_BRANCH) scripts/setup.sh

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
