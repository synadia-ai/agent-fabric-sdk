// durable.ts — a durable workflow the model can start, joined to the task
// that started it.
//
// `@synadia-ai/durable` runs workflows on NATS: each step is journaled, and
// a run survives a restart of the agent by replaying what its journal holds.
// This agent registers one workflow, `durable-task`, of two steps:
//
//   ask-model     one model call through the proxy, with the two trace
//                 headers taken from the run's input, so the call lands on
//                 the thread of the prompt that started the run
//   write-result  the step's answer written into the run's result
//
// and offers the model one more tool, `run_durable_task`, that starts a run
// and waits for its result.
//
// The run joins the task that started it by its id: the fabric package's
// `durableRunId(toolCallId)` is `<thread_id>-<tool call id>`, the served
// thread and the model's call. A step runs on the worker, outside the
// prompt's trace scope, so the trace travels in the run's input
// (`durableTrace()`) and comes back as headers inside the step
// (`durableHeaders()`).
//
// The library's seven JetStream resources are the tenant's: the fabric's
// onboarding creates them in the account, sized to its tier. The worker and
// the client are given no sizing and no replicas, so starting them creates
// nothing and changes nothing; they find what is there.

import { randomUUID } from "node:crypto";
import type { NatsConnection } from "@nats-io/nats-core";
import { durableHeaders, durableRunId, durableTrace, type DurableTrace } from "@synadia-ai/agent-fabric";
import { createClient, createWorker, defineWorkflow, type Logger } from "@synadia-ai/durable";
import type { ChatMessage, ModelClient, ToolDefinitionLike, ToolRunner } from "./model.js";

/** The workflow's name: a subject token and a consumer name to the library. */
export const DURABLE_WORKFLOW = "durable-task";

/** The tool the model sees. */
export const RUN_DURABLE_TASK = "run_durable_task";

/** What the model reads about the tool. */
export const RUN_DURABLE_TASK_TOOL = {
  type: "function",
  function: {
    name: RUN_DURABLE_TASK,
    description:
      "Runs a task as a durable workflow on this agent: each step is journaled, so the work survives a restart " +
      "and is not done twice. Use it when the prompt asks for durable work. Give the task in words; " +
      "the result is the workflow's answer.",
    parameters: {
      type: "object",
      properties: { task: { type: "string", description: "The task, in words." } },
      required: ["task"],
    },
    strict: false,
  },
} as const;

/** What the step tells the model. */
export const DURABLE_STEP_INSTRUCTION = "Carry out the task you are given. Answer briefly, in plain text.";

/** A run's input: the task, and the trace of the prompt that started it, under a key of this agent's choosing. */
export interface DurableTaskInput {
  readonly task: string;
  readonly trace?: DurableTrace;
}

/** A run's result: the step's answer. */
export interface DurableTaskResult {
  readonly task: string;
  readonly answer: string;
}

/** The workflow, over this agent's model client. */
export function durableTaskWorkflow(model: ModelClient) {
  return defineWorkflow(DURABLE_WORKFLOW, async (ctx, input: DurableTaskInput): Promise<DurableTaskResult> => {
    // Step one: the model, with the trace headers from the input. The step
    // runs outside the prompt's scope, where `traceHeaders()` has nothing.
    const answer = await ctx.run("ask-model", async () => {
      const messages: ChatMessage[] = [
        { role: "system", content: DURABLE_STEP_INSTRUCTION },
        { role: "user", content: input.task },
      ];
      const { message } = await model.complete(messages, [], durableHeaders(input.trace));
      return message.content ?? "";
    });
    // Step two: the answer, written into the result.
    return ctx.run("write-result", () => ({ task: input.task, answer }));
  });
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
 * that starts a run. The worker is started here: it binds its two durable
 * consumers and nothing else.
 */
export async function startDurableTasks(
  nc: NatsConnection,
  model: ModelClient,
  options: { readonly resultTimeoutMs: number; readonly log: (line: string) => void },
): Promise<DurableTasks> {
  const workflow = durableTaskWorkflow(model);
  const logger = libraryLogger(options.log);
  const worker = createWorker({ nc, workflows: [workflow], logger });
  await worker.start();
  const client = createClient({ nc });
  return {
    definition: RUN_DURABLE_TASK_TOOL,
    async run(args, toolCallId) {
      let task: string;
      try {
        const parsed = (typeof args === "string" ? JSON.parse(args) : args) as { task?: unknown };
        if (typeof parsed?.task !== "string" || parsed.task.trim() === "") throw new Error("task is required");
        task = parsed.task;
      } catch (err) {
        return JSON.stringify({ error: `run_durable_task: ${err instanceof Error ? err.message : String(err)}` });
      }
      try {
        // (5) The run joins the task that started it: its id names the
        // served thread and this tool call, and its input carries the trace.
        // Outside a traced prompt there is no thread to name, and the run
        // joins no task.
        const runId = durableRunId(toolCallId) ?? `${DURABLE_WORKFLOW}-${randomUUID()}`;
        const trace = durableTrace();
        const input: DurableTaskInput = { task, ...(trace !== undefined ? { trace } : {}) };
        const handle = await client.start(workflow, input, { runId });
        options.log(`durable run ${runId} started`);
        const result = await handle.result(options.resultTimeoutMs);
        return JSON.stringify({ run_id: runId, ...result });
      } catch (err) {
        return JSON.stringify({ error: `run_durable_task: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
    async stop() {
      await worker.stop();
    },
  };
}

/** The tool runner with `run_durable_task` next to the tools it already has. */
export function withDurableTasks(runner: ToolRunner, durable: DurableTasks): ToolRunner {
  return {
    definitions: [...runner.definitions, durable.definition],
    call: (name, args, toolCallId) =>
      name === RUN_DURABLE_TASK ? durable.run(args, toolCallId) : runner.call(name, args, toolCallId),
  };
}

function libraryLogger(log: (line: string) => void): Logger {
  const line = (msg: string, fields?: Record<string, unknown>): void =>
    log(`[durable] ${msg}${fields !== undefined && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ""}`);
  return { debug: () => {}, info: line, warn: line, error: line };
}
