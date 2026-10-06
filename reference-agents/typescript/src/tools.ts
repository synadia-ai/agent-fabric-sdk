// tools.ts — the agent tools, as a chat-completions model loop sees them.
//
// An agent on the fabric is not only reachable. It can see who else is
// there and prompt them. The tools that give its model that capability are
// the SDK's: `AgentTools` from `@synadia-ai/agents`, the six of the SDK's
// contract (its `docs/agent-tools.md`), with the words the model reads and
// what each call does. This agent offers the first three by default
// (`BLOCKING_TOOLS` below), all six with `AGENT_TOOLS=all`:
//
//   discover_agents   the agents on the fabric, one entry per address
//   prompt_agent      a prompt to one of them; by default it waits for the
//                     reply, or for a question the other agent asks
//   answer_agent      the answer to such a question
//   wait_agent        the result of a prompt started with `wait: false`
//   cancel_agent      stop a prompt
//   list_agent_calls  the prompts started in the prompt being served
//
// The fabric package adds its rules for ScratchPad references to them, as
// an extension (`scratchPadExtension`; `agent.ts` wires both). What is left
// for this file is the model loop's side: show the model the definitions in
// the shape a chat-completions request carries, run each call the model
// makes, and hand back the result as the `tool` message's content.
//
// Why a child thread hangs under the right parent with no plumbing here:
// the fabric package's request interceptor runs the agent's prompt handler
// inside a trace scope (an AsyncLocalStorage, which follows every await, so
// it is still there when the model loop calls back into this file). The
// client's prompt interceptor, from the same package, reads that scope when
// `prompt_agent` sends: it mints a thread ID for the child, writes the
// `edge` record with the served thread as `parent_id`, and puts the ids on
// the envelope. The one thing this code has to do is pass the model's
// tool-call id through, so the edge names the call that spawned the child.
//
// Reference code: copy it and adapt it to your model loop. The words the
// model reads are the SDK's, so every agent that offers these tools shows
// its model the same ones, whatever language it is written in.

import { AGENT_TOOL_NAMES, type AgentToolName, type AgentTools } from "@synadia-ai/agents";
import type { ToolsSetting } from "./config.js";
import type { ToolRunner } from "./model.js";

/**
 * The three tools a model needs to delegate one step at a time: find an
 * agent, prompt it and wait for the reply, and answer a question it asks
 * on the way. Every definition the model is shown is input tokens on every
 * model call, and these three cost a little over half of the six. Without
 * `wait_agent` nothing can be detached, so the SDK shows `prompt_agent`
 * and `answer_agent` without their `wait` parameter and with words that
 * name no tool it does not offer.
 */
export const BLOCKING_TOOLS: ReadonlyArray<AgentToolName> = ["discover_agents", "prompt_agent", "answer_agent"];

/**
 * `AgentTools`' `tools` option for an `AGENT_TOOLS` setting (`config.ts`):
 * the three above by default, the SDK's six with `all`. With `none` the
 * helper is built with the three as well, and the model is shown nothing
 * ({@link NO_TOOLS}).
 */
export function offeredTools(setting: ToolsSetting): ReadonlyArray<AgentToolName> | undefined {
  return setting === "all" ? undefined : BLOCKING_TOOLS;
}

/** One tool as a chat-completions request carries it (`tools: [...]`). */
export interface ChatTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly strict: false;
  };
}

/**
 * The SDK's definitions in the chat-completions shape: each one wrapped as
 * a `function` with explicit non-strict argument generation. The SDK's
 * names, descriptions and parameter schemas are preserved.
 */
export function chatTools(tools: AgentTools): ChatTool[] {
  return tools.definitions.map((d) => ({
    type: "function",
    function: { name: d.name, description: d.description, parameters: d.parameters, strict: false },
  }));
}

/**
 * The tools for `converse()`: the definitions, and a call that runs one.
 * The model's tool-call id goes with each call; `prompt_agent` puts it in
 * the prompt's context, where the fabric's tracing writes it on the edge,
 * and a grant made for the call carries it too. The result, whatever the
 * tool, is a JSON object; the model gets it as JSON text. Something the
 * model got wrong comes back in words (`{"error": ...}`), never as a throw.
 */
export function toolRunner(tools: AgentTools): ToolRunner {
  return {
    definitions: chatTools(tools),
    call: async (name, args, toolCallId) => JSON.stringify(await tools.execute(name, args, { toolCallId })),
  };
}

/**
 * A role that must answer itself is offered no tools at all (`AGENT_TOOLS=none`
 * in `config.ts`). The agent keeps the capability; the model is not shown it.
 */
export const NO_TOOLS: ToolRunner = {
  definitions: [],
  call: async () => JSON.stringify({ error: "this agent has no tools" }),
};

/**
 * A tool the agent defines itself, next to the agent tools: a plant
 * agent's `read_lines`, say. The model reads `name`, `description` and
 * `parameters` (a JSON schema object). `run` gets the parsed arguments;
 * what it returns goes back to the model as JSON text.
 */
export interface OwnTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The names an own tool may not take: the SDK's six agent tools, offered
 * or not, and `start_workflow` (`durable.ts`). A call goes by name, so two
 * tools with one name cannot both be reached.
 */
export const RESERVED_TOOL_NAMES: ReadonlyArray<string> = [...AGENT_TOOL_NAMES, "start_workflow"];

/**
 * Throws, naming the tool, when an own tool takes a reserved name or two
 * own tools share one. `startAgent` calls it before it connects.
 */
export function checkOwnTools(own: ReadonlyArray<OwnTool>): void {
  const seen = new Set<string>();
  for (const tool of own) {
    if (RESERVED_TOOL_NAMES.includes(tool.name)) {
      throw new Error(`own tool "${tool.name}" has the name of an agent tool`);
    }
    if (seen.has(tool.name)) throw new Error(`two own tools are named "${tool.name}"`);
    seen.add(tool.name);
  }
}

/**
 * The runner with the own tools after the tools it already has. A call to
 * an own tool runs it; any other goes to `runner`. Arguments that are not
 * a JSON object, or a tool that throws, come back as `{"error": ...}`,
 * never as a throw, as for the agent tools.
 */
export function withOwnTools(runner: ToolRunner, own: ReadonlyArray<OwnTool>): ToolRunner {
  checkOwnTools(own);
  if (own.length === 0) return runner;
  const byName = new Map(own.map((tool) => [tool.name, tool]));
  return {
    definitions: [
      ...runner.definitions,
      ...own.map((t): ChatTool => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters, strict: false },
      })),
    ],
    call: async (name, args, toolCallId) => {
      const tool = byName.get(name);
      if (tool === undefined) return runner.call(name, args, toolCallId);
      try {
        return JSON.stringify((await tool.run(parseArgs(args))) ?? null);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// The model sends its arguments as JSON text; a test may pass the object.
function parseArgs(args: unknown): Record<string, unknown> {
  let value: unknown = args;
  if (typeof args === "string") {
    try {
      value = args.trim() === "" ? {} : JSON.parse(args);
    } catch {
      throw new Error("the arguments are not valid JSON");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("the arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}
