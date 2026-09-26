# The two example agents. They run against a fabric that already stands: a
# NATS URL and credentials, the model proxy and a virtual key, and ScratchPad
# if you use it. `agents/ts/env.example` and `agents/py/env.example` list what
# an agent is told.
#
#   make setup      install both agents' packages; builds the SDK and the fabric
#                   package in the checkouts below first, until they are published
#   make agent-ts   run the TypeScript agent from agents/ts/.env
#   make agent-py   run the Python agent from agents/py/.env
#   make test       both agents' tests (test-ts, test-py); nats-server on PATH

# Until the packages are published, they come from these checkouts, next to
# this one, on these branches. `make setup` refuses another branch unless
# ANY_BRANCH=1.
SDK_DIR       := synadia-agents
SDK_BRANCH    := sdk-release-rollout
FABRIC_DIR    := agent-fabric-sdk
FABRIC_BRANCH := main
ANY_BRANCH    ?=

.PHONY: setup agent-ts test-ts agent-py test-py test

# The packages, built and installed. Safe to run twice.
setup:
	@SDK_DIR=$(SDK_DIR) SDK_BRANCH=$(SDK_BRANCH) FABRIC_DIR=$(FABRIC_DIR) FABRIC_BRANCH=$(FABRIC_BRANCH) \
	  ANY_BRANCH=$(ANY_BRANCH) scripts/setup.sh

# One TypeScript agent, configured by agents/ts/.env.
agent-ts:
	cd agents/ts && npm start

# The TypeScript tests: the agent tools as the agent wires them, and the agent, on a throwaway nats-server.
test-ts:
	cd agents/ts && npm run typecheck && npm test

# One Python agent, configured by agents/py/.env.
agent-py:
	cd agents/py && uv run python -m fabric_agent

# The Python tests: the same two, plus the TypeScript agent and the Python one prompting each other.
test-py:
	cd agents/py && uv run pytest -q

# Everything.
test: test-ts test-py
