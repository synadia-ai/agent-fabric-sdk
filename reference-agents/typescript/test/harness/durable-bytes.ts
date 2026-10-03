// The durable pieces both reference agents must word the same, one JSON
// line each, for the Python suite's parity test
// (`python/tests/test_durable_parity.py`): the `start_workflow` tool as the
// model is shown it, the names, and the words a step tells the model.

import { AGENT_LOOP, NO_REPLY } from "../../src/durable-agent.js";
import {
  DURABLE_STEP_INSTRUCTION,
  DURABLE_TASK,
  hostedWorkflows,
  START_WORKFLOW,
  startWorkflowTool,
} from "../../src/durable.js";
import type { ModelClient } from "../../src/model.js";

// The workflows close over a model client they never call here.
const model = { label: "none" } as unknown as ModelClient;
const lines: unknown[] = [
  startWorkflowTool(hostedWorkflows(model)),
  [START_WORKFLOW, DURABLE_TASK, AGENT_LOOP],
  DURABLE_STEP_INSTRUCTION,
  NO_REPLY,
];
for (const line of lines) console.log(JSON.stringify(JSON.stringify(line)));
