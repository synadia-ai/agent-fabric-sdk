# The two reference agents. They run against a fabric that already stands: a
# NATS URL and credentials, the model proxy and a virtual key, and ScratchPad
# if you use it. `typescript/env.example` and `python/env.example` list what
# an agent is told.
#
# A user of the Python agent needs none of this file: in python/,
# `uv run python -m fabric_agent` takes the four packages from PyPI.
#
#   make setup      install both agents' packages for work on this repository:
#                   TypeScript's from npm, with the checkouts below built and
#                   linked over them; Python's from PyPI (uv sync)
#   make agent-ts   run the TypeScript agent from typescript/.env
#   make agent-py   run the Python agent from python/.env
#   make test       both agents' tests (test-ts, test-py); nats-server on PATH.
#                   The durable tests spawn the durable engine from Synadia:
#                   DE_ENGINE (its binary) and DE_LICENCE (its licence file);
#                   they skip without DE_ENGINE
#
#   CHECKOUTS=1     with agent-py, test-py or test: the Python agent runs on the
#                   four packages' checkouts instead of PyPI's, for testing
#                   changes not yet released (`make test-py CHECKOUTS=1`).
#                   Without it, `make test` runs the TypeScript agent on the
#                   checkouts and the Python one on PyPI's packages, so the
#                   interop and byte-parity tests compare the two only while
#                   the checkouts are what was released

# The protocol SDK's checkout, next to this repository, on this branch: the
# TypeScript agent's link and the Python agent's CHECKOUTS=1. `make setup`
# refuses another branch unless ANY_BRANCH=1. The fabric package is this
# repository's own: ../typescript and ../python.
SDK_DIR       := synadia-agents
SDK_BRANCH    := main
ANY_BRANCH    ?=
# The thin durable SDK, for the durable workflows (AGENT_DURABLE=1, the
# durable agent): its checkout next to this repository, the same way. The
# engine behind it comes from Synadia (DE_ENGINE).
DE_DIR        := durable-sdk
CHECKOUTS     ?=

# How the Python agent runs, from python/. With CHECKOUTS=1, uv layers the four
# checkouts, installed editable, over the synced environment for that one run;
# the environment, pyproject.toml and uv.lock stay on the published packages.
# Every program starts as `python -m`, from the overlay's Python: a script of
# the synced environment (its bin/pytest) would start that environment's
# Python, without the checkouts. tests/test_checkouts.py checks which copies
# are imported, in the tests and in a child, when CHECKOUTS=1.
PY_RUN := uv run$(if $(CHECKOUTS), --with-editable ../../python \
  --with-editable ../../../$(SDK_DIR)/client-sdk/python \
  --with-editable ../../../$(SDK_DIR)/agent-sdk/python \
  --with-editable ../../../$(DE_DIR)/python)

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
	cd python && $(PY_RUN) python -m fabric_agent

# The Python tests: the same two, plus the TypeScript agent and the Python one prompting each other.
test-py:
	cd python && CHECKOUTS=$(CHECKOUTS) SDK_DIR=$(SDK_DIR) DE_DIR=$(DE_DIR) $(PY_RUN) python -m pytest -q

# Everything.
test: test-ts test-py

# The destination is explicit because the controls retain isolated source copies.
test-reply-controls:
	@test -n "$(REPLY_EVIDENCE)" || (echo 'Set REPLY_EVIDENCE to a new absolute evidence directory'; exit 2)
	uv run --script test-fixtures/reply_controls.py --evidence "$(REPLY_EVIDENCE)"
