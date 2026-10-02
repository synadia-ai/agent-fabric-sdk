// Durable runs on the Synadia Agent Fabric — how a run of a durable
// workflow joins the task that started it. Mirrors
// `synadia_ai/agent_fabric/durable.py` in the Python package; the two must
// stay wire-identical.
//
// The join is a convention, not a record. A run started by a tool call
// takes the id `<thread_id>-<tool call id>`: the served thread it was
// started from, and the model's call that started it. Whoever reads the
// runs can name the task of each without anything else being written. A
// model call made inside one of the run's steps carries the two headers
// the model proxy already reads, taken from the trace the run's input
// carries: a step runs on a worker, outside the prompt's async scope, so
// the trace has to travel in the input.
//
// Nothing here depends on a durable-execution library: these are strings
// and objects an agent hands to whichever one it uses.

import { NatsAgentError } from "@synadia-ai/agents";
import {
  activeTrace,
  isThreadId,
  ROOT_ID_HEADER,
  THREAD_ID_HEADER,
  validToolCallId,
} from "./trace.js";

/**
 * The served prompt's trace as a run's input carries it, in this key
 * order. Wire form: the same keys and order in both packages.
 */
export interface DurableTrace {
  readonly thread_id: string;
  readonly root_id: string;
}

// What a run id may hold: the durable-execution protocol uses a run id as
// a subject token and as a key, so it is held to the intersection of the
// two. Flagged `u` so that one code point, astral or not, is one character,
// as it is in Python.
const OUTSIDE_RUN_ID = /[^A-Za-z0-9_-]/gu;

/**
 * The run id that joins a durable run to the task that started it:
 * `<thread_id>-<tool call id>`, the active trace's thread and the model's
 * tool-call id, with every character of the tool-call id outside
 * `[A-Za-z0-9_-]` replaced by `_`. Pass it as the run id when the run is
 * started; the run's children and generations keep it as their prefix.
 *
 * `undefined` outside a traced prompt handler: there is no served thread to
 * name. Pick a run id of your own then; that run joins no task.
 *
 * Throws {@link NatsAgentError} when the tool-call id is empty, longer than
 * the trace accepts (`TOOL_CALL_ID_MAX` code points) or not valid Unicode.
 */
export function durableRunId(toolCallId: string): string | undefined {
  if (!validToolCallId(toolCallId)) {
    throw new NatsAgentError(
      `durableRunId: tool call id ${JSON.stringify(toolCallId)} is empty, too long or not valid Unicode`,
    );
  }
  const scope = activeTrace();
  if (scope === undefined) return undefined;
  return `${scope.threadId}-${toolCallId.replace(OUTSIDE_RUN_ID, "_")}`;
}

/**
 * The active trace as `{ thread_id, root_id }`, for the run's input under a
 * key of your choosing; {@link durableHeaders} turns it back into the
 * proxy's headers inside a step. `undefined` outside a traced prompt
 * handler.
 *
 * Unlike `traceHeaders()`, it counts no model turn: it starts no model call.
 */
export function durableTrace(): DurableTrace | undefined {
  const scope = activeTrace();
  if (scope === undefined) return undefined;
  return { thread_id: scope.threadId, root_id: scope.rootId };
}

/**
 * The two headers the model proxy reads, `X-Synadia-Thread-ID` and
 * `X-Synadia-Root-ID`, from a trace a run's input carries, for a model call
 * inside a step. The call then lands on the thread that started the run.
 *
 * The input is read back from the run's journal, so it is checked as
 * untrusted: `{}` unless both ids have the shape of a thread id. `{}` for
 * `undefined` or `null` as well, so a run started outside a traced handler
 * makes its model calls without the headers.
 */
export function durableHeaders(trace: DurableTrace | null | undefined): Record<string, string> {
  if (typeof trace !== "object" || trace === null) return {};
  const { thread_id: threadId, root_id: rootId } = trace as {
    thread_id?: unknown;
    root_id?: unknown;
  };
  if (typeof threadId !== "string" || typeof rootId !== "string") return {};
  if (!isThreadId(threadId) || !isThreadId(rootId)) return {};
  return { [THREAD_ID_HEADER]: threadId, [ROOT_ID_HEADER]: rootId };
}
