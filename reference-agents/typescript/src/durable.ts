// durable.ts — durable work delegated by the model: the workflows this
// process hosts, and the tool that starts one.
//
// `@synadia-ai/durable` runs workflows in this process against the durable
// engine: each step is journaled, and a run survives a restart of the agent by
// replaying what its journal holds.
// An agent whose own model loop is not durable can still hand a job to a
// workflow: the model calls `start_workflow` with a workflow's name and its
// input, and gets back the run id and the result. The workflows are the ones
// this process hosts, in a small registry (`WORKFLOWS`); a worker on the
// agent's connection runs them.
//
// One is registered here, a demo, `durable-task`, of two steps:
//
//   ask-model     one model call through the proxy, with the two trace
//                 headers taken from the run's input, so the call lands on
//                 the thread of the prompt that started the run
//   write-result  the step's answer written into the run's result
//
// The run joins the tool call that started it by its id: the fabric
// package's `durableRunId(toolCallId)` is `<thread_id>-<tool call id>`, the
// served thread and the model's call, and the console shows the run under
// that call. A step runs on the worker, outside the prompt's trace scope, so
// the trace travels in the run's input (`durableTrace()`) and comes back as
// headers inside the step (`durableHeaders()`).
//
// The worker and the client are the thin SDK's: every call is one request
// to `de.api.v1.<op>` on the agent's own connection, and the engine owns the
// journal and everything else. On the fabric the tenant's import carries the
// requests to the engine; the agent creates nothing and needs no rights of
// its own. The worker's first poll binds its workflow names on the engine.
//
// An agent whose model loop is itself durable needs no such tool: its loop is
// the workflow (`durable-agent.ts`).

import { randomUUID } from "node:crypto";
import type { NatsConnection } from "@nats-io/nats-core";
import { durableHeaders, durableRunId, durableTrace, type DurableTrace } from "@synadia-ai/agent-fabric";
import { createClient, createWorker, defineWorkflow, type Logger, type Workflow } from "@synadia-ai/durable";
import type { ChatMessage, ModelClient, ToolDefinitionLike, ToolRunner } from "./model.js";

/** The tool the model sees. */
export const START_WORKFLOW = "start_workflow";

/** The demo workflow's name: a subject token and a consumer name to the engine. */
export const DURABLE_TASK = "durable-task";

/** What the demo workflow's step tells the model. */
export const DURABLE_STEP_INSTRUCTION = "Carry out the task you are given. Answer briefly, in plain text.";

/**
 * A run's input: what the model gave as `input`, and the trace of the
 * prompt that started it, under keys of this agent's choosing.
 */
export interface StartedInput<I> {
  readonly input: I;
  readonly trace?: DurableTrace;
}

/** One workflow the process hosts, as the model is told about it. */
export interface HostedWorkflow {
  readonly name: string;
  /** One line for the tool's description: what it does and the input it takes. */
  readonly description: string;
  /** Why an input is refused, in words; `undefined` when it is accepted. */
  check(input: Record<string, unknown>): string | undefined;
  // The input and result types are the workflow's own.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly workflow: Workflow<StartedInput<any>, unknown>;
}

/** The demo workflow's input and result. */
export interface DurableTaskInput {
  readonly task: string;
}
export interface DurableTaskResult {
  readonly task: string;
  readonly answer: string;
}

/** The demo workflow, over this agent's model client. */
export function durableTaskWorkflow(model: ModelClient): Workflow<StartedInput<DurableTaskInput>, DurableTaskResult> {
  return defineWorkflow(DURABLE_TASK, async (ctx, run: StartedInput<DurableTaskInput>): Promise<DurableTaskResult> => {
    const task = run.input.task;
    // Step one: the model, with the trace headers from the input. The step
    // runs outside the prompt's scope, where `traceHeaders()` has nothing.
    const answer = await ctx.run("ask-model", async () => {
      const messages: ChatMessage[] = [
        { role: "system", content: DURABLE_STEP_INSTRUCTION },
        { role: "user", content: task },
      ];
      const { message } = await model.complete(messages, [], durableHeaders(run.trace));
      return message.content ?? "";
    });
    // Step two: the answer, written into the result.
    return ctx.run("write-result", () => ({ task, answer }));
  });
}

/** The workflows this process hosts: the demo, `durable-task`. Add yours here. */
export function hostedWorkflows(model: ModelClient): HostedWorkflow[] {
  return [
    {
      name: DURABLE_TASK,
      description:
        'carries out a task given in words with one model call, then writes the answer into its result; input {"task": "<the task>"}',
      check: (input) =>
        typeof input["task"] === "string" && input["task"].trim() !== "" ? undefined : "input.task is required",
      workflow: durableTaskWorkflow(model),
    },
  ];
}

/** The tool's definition, from the workflows hosted; the same words as `durable.py`. */
export function startWorkflowTool(workflows: readonly HostedWorkflow[]): ToolDefinitionLike {
  return {
    type: "function",
    function: {
      name: START_WORKFLOW,
      description:
        "Starts a durable workflow this agent hosts and waits for its result. Each step of a workflow is " +
        "journaled, so the work survives a restart of this agent and a finished step is not done again. " +
        "Use it when the prompt asks for durable work. The workflows: " +
        workflows.map((w) => `${w.name}: ${w.description}.`).join(" ") +
        " Returns the run id and the workflow's result.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", enum: workflows.map((w) => w.name), description: "The workflow to start." },
          input: { type: "object", description: "The workflow's input, as its description says." },
        },
        required: ["name", "input"],
      },
      strict: false,
    },
  } as ToolDefinitionLike;
}

export interface DurableTasks {
  /** The tool's definition, for the model's request. */
  readonly definition: ToolDefinitionLike;
  /** Start a run for one tool call and wait for its result; the result, or `{"error": …}`, as JSON text. */
  run(args: unknown, toolCallId: string): Promise<string>;
  stop(): Promise<void>;
}

/**
 * The worker and the client, on the agent's own connection, and the tool
 * that starts a run. The worker is started here: its first poll binds its
 * workflows on the engine.
 */
export async function startDurableTasks(
  nc: NatsConnection,
  model: ModelClient,
  options: { readonly resultTimeoutMs: number; readonly log: (line: string) => void },
): Promise<DurableTasks> {
  const hosted = hostedWorkflows(model);
  const byName = new Map(hosted.map((w) => [w.name, w] as const));
  const worker = createWorker({ nc, workflows: hosted.map((w) => w.workflow), logger: sdkLogger(options.log) });
  await worker.start();
  const client = createClient({ nc });
  const error = (message: string): string => JSON.stringify({ error: `${START_WORKFLOW}: ${message}` });
  return {
    definition: startWorkflowTool(hosted),
    async run(args, toolCallId) {
      let parsed: { name?: unknown; input?: unknown };
      try {
        parsed = (typeof args === "string" ? JSON.parse(args) : args) as typeof parsed;
      } catch {
        return error("the arguments are not JSON");
      }
      const hostedWorkflow = typeof parsed?.name === "string" ? byName.get(parsed.name) : undefined;
      if (hostedWorkflow === undefined) {
        return error(`no workflow named ${JSON.stringify(parsed?.name)}; the workflows: ${[...byName.keys()].join(", ")}`);
      }
      const input = parsed.input;
      if (typeof input !== "object" || input === null || Array.isArray(input)) return error("input must be an object");
      const refused = hostedWorkflow.check(input as Record<string, unknown>);
      if (refused !== undefined) return error(refused);
      try {
        // (5) The run joins the tool call that started it: its id names the
        // served thread and this call, and its input carries the trace.
        // Outside a traced prompt there is no thread to name, and the run
        // joins no task.
        const runId = durableRunId(toolCallId) ?? `${hostedWorkflow.name}-${randomUUID()}`;
        const trace = durableTrace();
        const started: StartedInput<unknown> = { input, ...(trace !== undefined ? { trace } : {}) };
        const handle = await client.start(hostedWorkflow.workflow, started, { runId });
        options.log(`durable run ${runId} started`);
        const result = await handle.result(options.resultTimeoutMs);
        return JSON.stringify({ run_id: runId, result });
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
    },
    async stop() {
      await worker.stop();
    },
  };
}

/** The tool runner with `start_workflow` next to the tools it already has. */
export function withDurableTasks(runner: ToolRunner, durable: DurableTasks): ToolRunner {
  return {
    definitions: [...runner.definitions, durable.definition],
    call: (name, args, toolCallId) =>
      name === START_WORKFLOW ? durable.run(args, toolCallId) : runner.call(name, args, toolCallId),
  };
}

function sdkLogger(log: (line: string) => void): Logger {
  const line = (msg: string, fields?: Record<string, unknown>): void =>
    log(`[durable] ${msg}${fields !== undefined && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ""}`);
  return { debug: () => {}, info: line, warn: line, error: line };
}
