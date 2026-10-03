// durable-agent.ts — the durable reference agent: the model loop is the
// workflow.
//
// `agent.ts` keeps its model loop in memory: a crash of the process loses
// the conversation, and the prompt it was serving is gone with every model
// turn and tool call it had made. Here the loop runs as a workflow of the
// durable-execution library, `agent-loop`:
//
//   llm-N          each model turn, one journaled step through the proxy,
//                  with the two trace headers from the run's input
//   tool-N-i       each tool call, one journaled step, run in the run's
//                  tool scope and inside the trace the input carries
//   ask-N-i        a question a prompted agent asks: the run parks on a
//                  durable signal; the front door relays it to the caller
//   answer-N-i     the caller's answer, carried back with `answer_agent`
//
// After a crash the run is taken up again by a worker, here or in another
// process of the same agent, and the loop replays from its journal: a
// recorded model turn returns what it returned, a recorded tool call returns
// its result, and execution resumes at the first step not yet journaled.
//
// What is exactly-once and what is at-least-once, plainly:
//
//   - A model turn whose step ended is never made again: it is journaled
//     before the next step begins. A model turn in flight when the process
//     died (its step began, its answer was not journaled) is made again.
//   - A tool call in flight when the process died runs again. `prompt_agent`
//     carries no idempotency key, so the prompted agent may be prompted
//     twice, and a second edge is written for it. `discover_agents` is a
//     read; running it twice is harmless.
//   - A call that was waiting on a question when the process died is gone
//     with the process's connection: the caller's answer reaches
//     `answer_agent` as a call it does not know, and the model reads that
//     in words.
//   - The reply to the prompt that was being served when the process died
//     is not delivered. The run completes in the journal, but the caller's
//     prompt stream ended with the process. Delivering it is the job of a
//     durable prompt, which the protocol does not have yet; nothing here
//     works around that.
//
// The front door is the reference agent's: `AgentService` with the fabric's
// tracing and the signed identity (behaviour 1, as in `agent.ts`), the
// model through the proxy with the trace headers (2), the agent tools (3)
// and ScratchPad references (4). The run joins the prompt that started it
// with the fabric package's helpers, as in `durable.ts` (5).

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { connect } from "@nats-io/transport-node";
import {
  durableHeaders,
  durableRunId,
  durableTrace,
  fabricTracing,
  findReferences,
  grantRequestEndpoint,
  nativeScratchPadFromEnv,
  READS_REFERENCES_KEY,
  scratchPadExtension,
  withDurableTrace,
  type DurableTrace,
  type ScratchPadClient,
} from "@synadia-ai/agent-fabric";
import { AgentService, RequestRejectedError } from "@synadia-ai/agent-service";
import {
  AGENT_TOOLS_QUESTION_REFUSAL,
  Agents,
  AgentSubject,
  AgentTools,
  formatSender,
  resolveNatsConnectionBundle,
  type Logger,
} from "@synadia-ai/agents";
import {
  createClient,
  createWorker,
  defineWorkflow,
  DurableTimeoutError,
  type Ctx,
  type Logger as DurableLogger,
} from "@synadia-ai/durable";
import type { AgentConfig } from "./config.js";
import { createModelClient, type ChatMessage, type ModelClient } from "./model.js";
import { deliveredReply } from "./reply.js";
import { chatTools, offeredTools, type ChatTool } from "./tools.js";
import type { RunningAgent } from "./agent.js";

/** The workflow's name: a subject token and a consumer name to the library. */
export const AGENT_LOOP = "agent-loop";

/** The run's input: the prompt, the trace of the prompt being served, and the verified caller. */
export interface AgentLoopInput {
  readonly prompt: string;
  readonly trace?: DurableTrace;
  /** The served prompt's sender ID when its signature verified: `prompt_agent` refuses to prompt it back. */
  readonly caller?: string;
}

/** The run's result: the model's answer, and how many model turns it took. */
export interface AgentLoopResult {
  readonly answer: string;
  readonly modelTurns: number;
}

/** A question a prompted agent asked, as the workflow hands it to the front door. */
export interface RelayedQuestion {
  readonly awaitName: string;
  readonly question: string;
  readonly address?: string;
}

/** What the front door signals back on a question's `ctx.await`. */
export interface QuestionAnswer {
  readonly answer: string;
}

/** What the model is told in place of an empty answer. */
const NO_REPLY = "Your last answer was empty. Answer the prompt you are serving in words.";

type Enter = <R>(fn: () => R) => R;

/**
 * The agent tools' scope of each run in this process, kept open across the
 * run's steps.
 *
 * A worker serves no prompt, so the tools' calls need a scope of their own:
 * `AgentTools.runInPromptScope` opens one, with the run's verified caller
 * for the loop guard, and cancels the calls still open when its function
 * returns. A call that asked a question must stay open while the run waits
 * on the answer, across steps, so the scope's function is held until the run
 * ends, and each step enters it through an `AsyncLocalStorage` snapshot taken
 * inside it. The scope lives in memory: after a crash, a run is given a new
 * one and the calls of the old one are gone.
 */
class RunScopes {
  readonly #open = new Map<string, { readonly enter: Promise<Enter>; readonly release: () => void }>();

  constructor(private readonly tools: AgentTools) {}

  /** The run's scope, opened on first use. */
  enter(runId: string, caller: string | undefined): Promise<Enter> {
    let entry = this.#open.get(runId);
    if (entry === undefined) {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const enter = new Promise<Enter>((resolve, reject) => {
        this.tools
          .runInPromptScope(
            async () => {
              resolve(AsyncLocalStorage.snapshot() as Enter);
              await held;
            },
            caller !== undefined ? { caller } : {},
          )
          .catch(reject);
      });
      entry = { enter, release };
      this.#open.set(runId, entry);
    }
    return entry.enter;
  }

  /** Close the run's scope: its open calls are cancelled. */
  release(runId: string): void {
    this.#open.get(runId)?.release();
    this.#open.delete(runId);
  }

  releaseAll(): void {
    for (const runId of [...this.#open.keys()]) this.release(runId);
  }
}

export interface AgentLoopDeps {
  readonly model: ModelClient;
  readonly tools: AgentTools;
  /** What the model is offered, in the chat-completions shape. */
  readonly toolDefinitions: readonly ChatTool[];
  readonly scopes: RunScopes;
  /** Where a question is handed to the front door serving the prompt, if one in this process is. */
  readonly questions: EventEmitter;
  readonly scratchpad: ScratchPadClient | undefined;
  readonly systemPrompt: string;
  /** How long a parked question waits before it is answered with a refusal. */
  readonly questionTimeoutMs: number;
  /** How many model turns may ask for tools before the model is asked to answer in words. */
  readonly maxToolRounds?: number;
}

/** The model loop as the workflow `agent-loop`. */
export function agentLoopWorkflow(deps: AgentLoopDeps) {
  const maxToolRounds = deps.maxToolRounds ?? 8;
  return defineWorkflow(AGENT_LOOP, async (ctx: Ctx, input: AgentLoopInput): Promise<AgentLoopResult> => {
    // The run's tool scope is released when the loop returns or fails. A run
    // that parks on a question does neither: its promise is left pending, so
    // the scope, and the call that asked, stay open for the answer.
    try {
      return await loop(ctx, input);
    } finally {
      deps.scopes.release(ctx.runId);
    }
  });

  async function loop(ctx: Ctx, input: AgentLoopInput): Promise<AgentLoopResult> {
    const headers = durableHeaders(input.trace);

    // (4) What it was handed: the references in the prompt, read in one step.
    let userContent = input.prompt;
    const refs = deps.scratchpad !== undefined ? findReferences(input.prompt) : [];
    if (refs.length > 0) {
      userContent = await ctx.run("read-references", () => readReferences(input, refs));
    }

    const messages: ChatMessage[] = [
      { role: "system", content: deps.systemPrompt },
      { role: "user", content: userContent },
    ];
    let emptyReplies = 0;
    for (let turn = 0; ; turn += 1) {
      const offered = turn < maxToolRounds ? deps.toolDefinitions : [];
      // (2) A model turn: journaled once. On replay this returns the recorded
      // message, and the model is not called again.
      const message = await ctx.run(`llm-${turn}`, async () => {
        const completion = await deps.model.complete(messages, offered, headers);
        return completion.message;
      });
      messages.push(message);
      const calls = offered.length > 0 ? (message.tool_calls ?? []) : [];
      if (calls.length === 0) {
        const answer = message.content ?? "";
        if (answer.trim() !== "") return { answer, modelTurns: turn + 1 };
        emptyReplies += 1;
        if (emptyReplies > 1) throw new Error(`the model returned no reply: its answer was empty ${emptyReplies} times`);
        messages.pop();
        messages.push({ role: "user", content: NO_REPLY });
        continue;
      }
      // (3) Each tool call: one step, in the run's scope and the prompt's
      // trace, with the model turns so far as the trace's turn count, so an
      // edge `prompt_agent` writes sits where the handler's would.
      for (const [i, call] of calls.entries()) {
        const turns = turn + 1;
        let content = await ctx.run(`tool-${turn}-${i}`, () =>
          runTool(ctx.runId, input, call.function.name, call.function.arguments, call.id, turns),
        );
        // A question from the prompted agent: the run parks on a durable
        // signal, and the front door asks the caller. The model sees the
        // call's result once the caller has answered.
        const to = addressOf(call.function.name, call.function.arguments);
        for (let q = 0; ; q += 1) {
          const asked = questionOf(content, to);
          if (asked === undefined) break;
          const suffix = q === 0 ? `${turn}-${i}` : `${turn}-${i}-${q}`;
          const awaitName = `ask-${suffix}`;
          await ctx.run(`ask-request-${suffix}`, () => {
            const relayed: RelayedQuestion = {
              awaitName,
              question: asked.question,
              ...(asked.address !== undefined ? { address: asked.address } : {}),
            };
            deps.questions.emit(ctx.runId, relayed);
            return "relayed";
          });
          let answer: string;
          try {
            ({ answer } = await ctx.await<QuestionAnswer>(awaitName, { timeoutMs: deps.questionTimeoutMs }));
          } catch (err) {
            if (!(err instanceof DurableTimeoutError)) throw err;
            answer = AGENT_TOOLS_QUESTION_REFUSAL;
          }
          content = await ctx.run(`answer-${suffix}`, () =>
            runTool(
              ctx.runId,
              input,
              "answer_agent",
              JSON.stringify({ call_id: asked.callId, answer }),
              call.id,
              turns,
            ),
          );
        }
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }
  }

  async function runTool(
    runId: string,
    input: AgentLoopInput,
    name: string,
    args: string,
    toolCallId: string,
    turns: number,
  ): Promise<string> {
    const enter = await deps.scopes.enter(runId, input.caller);
    return enter(() =>
      withDurableTrace(input.trace, turns, async () => JSON.stringify(await deps.tools.execute(name, args, { toolCallId }))),
    );
  }

  async function readReferences(input: AgentLoopInput, refs: readonly string[]): Promise<string> {
    let content = input.prompt;
    const trace = input.trace !== undefined ? { threadId: input.trace.thread_id, rootId: input.trace.root_id } : undefined;
    for (const ref of refs) {
      try {
        const text = await deps.scratchpad!.read(ref, trace);
        content += `\n\n--- content handed over as ${ref} ---\n${text}`;
      } catch (err) {
        content += `\n\n--- ${ref} could not be read: ${err instanceof Error ? err.message : String(err)} ---`;
      }
    }
    return content;
  }
}

/** Whom a `prompt_agent` call went to, from its arguments. */
function addressOf(tool: string, args: string): string | undefined {
  if (tool !== "prompt_agent") return undefined;
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return typeof parsed["address"] === "string" ? parsed["address"] : undefined;
  } catch {
    return undefined;
  }
}

/** The question in a tool's result, when the call waits on one. */
function questionOf(
  content: string,
  to: string | undefined,
): { callId: string; question: string; address?: string } | undefined {
  let r: unknown;
  try {
    r = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof r !== "object" || r === null) return undefined;
  const { state, call_id: callId, question, address } = r as Record<string, unknown>;
  if (state !== "input_required" || typeof callId !== "string" || typeof question !== "string") return undefined;
  const from = typeof address === "string" ? address : to;
  return { callId, question, ...(from !== undefined ? { address: from } : {}) };
}

export interface StartDurableAgentDeps {
  /** In place of the ScratchPad the environment configures; for tests. */
  readonly scratchpad?: ScratchPadClient;
  /** Where the fabric package reads the `SCRATCHPAD_*` variables; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Start the durable agent: the worker that runs `agent-loop`, and the front door. */
export async function startDurableAgent(
  cfg: AgentConfig,
  log: (line: string) => void = console.log,
  deps: StartDurableAgentDeps = {},
): Promise<RunningAgent> {
  // (1) The connection and the signer from one credentials snapshot.
  const bundle = await resolveNatsConnectionBundle(cfg.nats, { identity: "signed" });
  const nc = await connect(bundle.connectionOptions);
  const { signer } = bundle;
  const model = createModelClient(cfg.model);
  const address = AgentSubject.new(cfg.agent.kind, cfg.agent.owner, cfg.agent.name).prompt;

  const nativeScratchpad =
    deps.scratchpad === undefined
      ? await nativeScratchPadFromEnv(deps.env ?? process.env, { creator: address, nc })
      : undefined;
  const scratchpad = deps.scratchpad ?? nativeScratchpad;

  const tracing = fabricTracing();
  // (3) The caller side and the agent tools, as in `agent.ts`. The tools'
  // request interceptor is not on the service: the calls run on the worker,
  // in the run's scope (`RunScopes`), not in the handler.
  const client = new Agents({ nc, identity: { signer }, interceptors: [tracing.promptInterceptor] });
  const references =
    scratchpad !== undefined ? scratchPadExtension({ scratchPad: scratchpad, agents: client }) : undefined;
  const tools = new AgentTools({
    agents: client,
    tools: offeredTools(cfg.agent.tools),
    selfAddress: address,
    maxWaitMs: cfg.tools.replyTimeoutMs,
    extensions: references !== undefined ? [references] : [],
    logger: lineLogger(log, "[tools]"),
  });
  const scopes = new RunScopes(tools);
  const questions = new EventEmitter();
  questions.setMaxListeners(0);

  // (5) The loop, on a worker on this connection. The library's resources
  // are the tenant's: no sizing, no replicas, nothing created.
  const agentLoop = agentLoopWorkflow({
    model,
    tools,
    toolDefinitions: cfg.agent.tools === "none" ? [] : chatTools(tools),
    scopes,
    questions,
    scratchpad,
    systemPrompt: cfg.agent.systemPrompt,
    questionTimeoutMs: cfg.tools.replyTimeoutMs,
  });
  const worker = createWorker({ nc, workflows: [agentLoop], logger: durableLogger(log) });
  await worker.start();
  const runs = createClient({ nc });

  const service = new AgentService({
    nc,
    agent: cfg.agent.kind,
    owner: cfg.agent.owner,
    name: cfg.agent.name,
    description: cfg.agent.description,
    version: "0.1.0",
    interceptors: [tracing.requestInterceptor, ...(references !== undefined ? [references.requestInterceptor] : [])],
    heartbeatExtras: tracing.heartbeatExtras,
    identity: { signer },
    minSenderTrust: cfg.agent.minSenderTrust,
    ...(scratchpad !== undefined ? { extraMetadata: { [READS_REFERENCES_KEY]: "true" } } : {}),
    ...(scratchpad !== undefined
      ? {
          extraEndpoints: [
            grantRequestEndpoint({ promptAddress: address, scratchPad: scratchpad, logger: lineLogger(log, "[sp-grant]") }),
          ],
        }
      : {}),
    ...(cfg.agent.heartbeatIntervalS !== undefined ? { heartbeatIntervalS: cfg.agent.heartbeatIntervalS } : {}),
  });

  // The front door: a thin relay, not durable itself. It starts the run, asks
  // the caller what the run parks on, and sends the run's answer.
  service.onPrompt(async (envelope, response) => {
    // (5) The run of this prompt: `<thread_id>-prompt`, joined to the served
    // thread itself rather than to a tool call. The run id is the start's
    // idempotency key: the same prompt again, on the same thread, finds the
    // run it started and waits for that one.
    const runId = durableRunId("prompt") ?? `prompt-${randomUUID()}`;
    const trace = durableTrace();
    const sender = response.sender;
    const caller = sender?.trust === "verified" ? sender.id : undefined;
    const tag = `[${runId.slice(0, 8)}]`;
    log(`${tag} prompt from ${formatSender(sender)}: ${envelope.prompt.slice(0, 80)}`);

    // Listen before the run starts, so a question is never missed.
    const relay = (q: RelayedQuestion): void => {
      void (async () => {
        let answer: string;
        try {
          const asked = q.address !== undefined ? `${q.address} asks: ${q.question}` : q.question;
          answer = (await response.ask(asked, { timeoutMs: cfg.tools.replyTimeoutMs })).prompt;
        } catch {
          answer = AGENT_TOOLS_QUESTION_REFUSAL;
        }
        await runs.signal(runId, q.awaitName, { answer } satisfies QuestionAnswer).catch((err: unknown) => {
          log(`${tag} could not signal ${q.awaitName}: ${err instanceof Error ? err.message : String(err)}`);
        });
      })();
    };
    questions.on(runId, relay);
    try {
      const input: AgentLoopInput = {
        prompt: envelope.prompt,
        ...(trace !== undefined ? { trace } : {}),
        ...(caller !== undefined ? { caller } : {}),
      };
      const handle = await runs.start(agentLoop, input, { runId });
      log(`${tag} durable run ${runId}`);
      const result = await handle.result(cfg.tools.replyTimeoutMs);
      log(`${tag} answered after ${result.modelTurns} model turn(s)`);
      await response.send(deliveredReply(result.answer).reply);
    } catch (err) {
      log(`${tag} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      throw new RequestRejectedError(500, err instanceof Error ? err.message : String(err));
    } finally {
      questions.off(runId, relay);
    }
  });

  await service.start();
  const running: RunningAgent = {
    address: service.subject.prompt,
    instanceId: service.instanceId,
    identity: service.identity,
    async stop() {
      await service.stop();
      await worker.stop();
      scopes.releaseAll();
      await tools.close();
      await client.close();
      await nativeScratchpad?.close();
      await nc.close();
      bundle.wipe();
    },
  };
  if (cfg.agent.readyFile !== undefined) {
    await writeFile(
      cfg.agent.readyFile,
      `${JSON.stringify({
        name: cfg.agent.name,
        agent: cfg.agent.kind,
        owner: cfg.agent.owner,
        subject: running.address,
        instance_id: running.instanceId,
        agent_id: running.identity ?? null,
        pid: process.pid,
        started: new Date().toISOString(),
      })}\n`,
    );
  }
  return running;
}

function lineLogger(log: (line: string) => void, prefix: string): Logger {
  const line = (msg: string, ctx?: Record<string, unknown>): void =>
    log(`${prefix} ${msg}${ctx !== undefined && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : ""}`);
  return { debug: () => {}, info: line, warn: line, error: line };
}

function durableLogger(log: (line: string) => void): DurableLogger {
  const line = (msg: string, fields?: Record<string, unknown>): void =>
    log(`[durable] ${msg}${fields !== undefined && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ""}`);
  return { debug: () => {}, info: line, warn: line, error: line };
}
