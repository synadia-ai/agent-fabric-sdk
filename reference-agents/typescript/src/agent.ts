// agent.ts — the TypeScript reference agent of the Synadia Agent Fabric.
//
// An agent on the fabric does four things. Each is marked below where it
// happens, so the file can be read as the list:
//
//   (1) it receives prompts through the SDK's host side, with a signed
//       identity, so every caller knows who answered;
//   (2) it calls its model through the fabric's proxy, with its virtual key
//       and the two trace headers on every call, so every call lands on its
//       thread in the console;
//   (3) it can see who else is on the fabric and prompt them, through the
//       SDK's agent tools its model may call; a prompt to another agent
//       becomes a child thread under this one;
//   (4) it uses ScratchPad: it reads what it was handed by reference, and
//       commits what it produced so the next agent can be handed that —
//       with a read grant to that one agent, made right before the
//       reference goes out, and to nobody else. What it was handed and
//       wants to hand on, it asks the creator to grant; and it answers such
//       requests about its own content, in code, by a fixed rule. All of
//       it is the fabric package's, the rules and the ScratchPad they run
//       on; this agent writes no ScratchPad code, it is configured
//       (`SCRATCHPAD_VOLUME`);
//   (5) optionally, it delegates durable work: the model starts a workflow
//       this process hosts, by name with an input (`start_workflow`); the
//       run's id names the served thread and the tool call, and its model
//       calls land on that thread (`durable.ts`, `AGENT_DURABLE=1`).
//
// Ported from the labs' `06-chat-agent`: the persona and the accumulating
// history stay, one history per verified caller (`history.ts`).

import { writeFile } from "node:fs/promises";
import { connect } from "@nats-io/transport-node";
import {
  activeTrace,
  fabricTracing,
  findReferences,
  grantRequestEndpoint,
  READS_REFERENCES_KEY,
  scratchPadExtension,
  nativeScratchPadFromEnv,
  traceHeaders,
  type ScratchPadClient,
} from "@synadia-ai/agent-fabric";
import { AgentService, RequestRejectedError } from "@synadia-ai/agent-service";
import {
  Agents,
  AgentSubject,
  AgentTools,
  formatSender,
  resolveNatsConnectionBundle,
  type Logger,
} from "@synadia-ai/agents";
import type { AgentConfig } from "./config.js";
import { Histories, withToolNote } from "./history.js";
import { converse, createModelClient, EmptyReplyError, type ChatMessage, type ToolRunner } from "./model.js";
import { startDurableTasks, withDurableTasks, type DurableTasks } from "./durable.js";
import { deliveredReply } from "./reply.js";
import {
  checkOwnTools,
  NO_TOOLS,
  offeredTools,
  toolRunner,
  withOwnTools,
  type OwnTool,
  type OwnToolContext,
} from "./tools.js";

export interface RunningAgent {
  /** The prompt address other agents see in discovery. */
  readonly address: string;
  readonly instanceId: string;
  /** `<account>.<user>`, the identity the agent registered. */
  readonly identity: string | undefined;
  stop(): Promise<void>;
}

export interface StartAgentDeps {
  /** In place of the ScratchPad the environment configures; for tests. */
  readonly scratchpad?: ScratchPadClient;
  /** Where the fabric package reads the `SCRATCHPAD_*` variables; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Tools the agent defines itself, offered to the model after the agent
   * tools, and with `AGENT_TOOLS=none` alone (`tools.ts`, `OwnTool`).
   */
  readonly ownTools?: ReadonlyArray<OwnTool>;
}

export async function startAgent(
  cfg: AgentConfig,
  log: (line: string) => void = console.log,
  deps: StartAgentDeps = {},
): Promise<RunningAgent> {
  // An own tool named like an agent tool, or two with one name, stop the
  // agent here, before anything connects.
  const ownTools = deps.ownTools ?? [];
  checkOwnTools(ownTools);

  // (1) One credentials snapshot gives both the connection and the signer,
  // so the identity the agent registers is the identity the connection
  // authenticated with; nothing can drift between the two.
  const bundle = await resolveNatsConnectionBundle(cfg.nats, { identity: "signed" });
  const nc = await connect(bundle.connectionOptions);
  const { signer } = bundle;

  // (2) The model, behind the proxy.
  const model = createModelClient(cfg.model);

  // Where this agent takes prompts: `agents.prompt.<kind>.<owner>.<name>`.
  const address = AgentSubject.new(cfg.agent.kind, cfg.agent.owner, cfg.agent.name).prompt;

  // ScratchPad borrows this authenticated connection. The private workspace
  // must persist across restarts; SCRATCHPAD_VOLUME unset disables the feature.
  const nativeScratchpad = deps.scratchpad === undefined
    ? await nativeScratchPadFromEnv(deps.env ?? process.env, { creator: address, nc })
    : undefined;
  const scratchpad = deps.scratchpad ?? nativeScratchpad;

  // Tracing, from the fabric package: three hooks the SDK takes. The
  // service's two adopt or mint each prompt's thread, run the handler
  // inside it, and count the edge records on the heartbeat; the client's
  // one writes the edge that makes a prompt sent from inside the handler a
  // child thread.
  const tracing = fabricTracing();

  // (3) The caller side, on the same connection and the same identity, so
  // the edges it writes are signed as this agent. It traces only because
  // it is given the prompt interceptor: a client without it, even one used
  // inside the handler, sends prompts that start no child thread.
  const client = new Agents({ nc, identity: { signer }, interceptors: [tracing.promptInterceptor] });

  // (4) The fabric's rules for ScratchPad references, as an extension of the
  // agent tools, over the ScratchPad above. Before `prompt_agent`
  // sends a prompt with references in it, the extension checks each one:
  // only a reference this agent was given, exactly as it came; only to an
  // agent whose registration says it reads references (any other gets the
  // text without them); on this agent's own content, a read grant to that
  // one agent's verified identity; on anyone else's, a signed request to the
  // creator the token names, which decides by its own rule. The grant
  // request goes over `client`, so it is signed as this agent.
  const references =
    scratchpad !== undefined ? scratchPadExtension({ scratchPad: scratchpad, agents: client }) : undefined;

  // (3) The agent tools, the SDK's, over the caller side above: by default
  // `discover_agents`, `prompt_agent` and `answer_agent`, every prompt
  // waiting for its reply; the six its contract defines with
  // `AGENT_TOOLS=all` (`tools.ts`). `selfAddress` keeps the agent out of
  // its own discovery and refuses a prompt to itself; the SDK also refuses
  // a prompt back to the agent that sent the prompt being served.
  // `maxWaitMs` is how long one prompt to another agent may run. No
  // attachment roots are named: the SDK's default is its staging directory
  // alone, which holds only the files other agents sent back, so the model
  // may pass one of those on and never a file of this host's, such as the
  // `.env` with the virtual key. These agents hand content over through
  // ScratchPad.
  const tools = new AgentTools({
    agents: client,
    tools: offeredTools(cfg.agent.tools),
    selfAddress: address,
    maxWaitMs: cfg.tools.replyTimeoutMs,
    extensions: references !== undefined ? [references] : [],
    logger: lineLogger(log, "[tools]"),
  });

  const service = new AgentService({
    nc,
    agent: cfg.agent.kind,
    owner: cfg.agent.owner,
    name: cfg.agent.name,
    description: cfg.agent.description,
    version: "0.1.0",
    // In this order, the first outermost. Tracing binds the served prompt's
    // thread, so everything inside runs on it. The tools open the prompt's
    // scope: the calls the model makes belong to this prompt and end with
    // it, and its verified sender is the caller the tools refuse to prompt
    // back. The extension notes the references the prompt hands over, so
    // the model may hand them on.
    interceptors: [
      tracing.requestInterceptor,
      tools.requestInterceptor,
      ...(references !== undefined ? [references.requestInterceptor] : []),
    ],
    heartbeatExtras: tracing.heartbeatExtras,
    identity: { signer },
    minSenderTrust: cfg.agent.minSenderTrust,
    // (4) With ScratchPad, this agent reads the references it is handed, and
    // says so in its registration: callers hand references, and grant read
    // on them, only to agents that do.
    ...(scratchpad !== undefined ? { extraMetadata: { [READS_REFERENCES_KEY]: "true" } } : {}),
    // (4) And it answers grant requests about its own content, next to its
    // prompt address (`agents.sp-grant.<kind>.<owner>.<name>`): an agent it
    // handed a reference asks here before handing it on, and the package's
    // rule decides. No model is involved.
    ...(scratchpad !== undefined
      ? {
          extraEndpoints: [
            grantRequestEndpoint({ promptAddress: address, scratchPad: scratchpad, logger: lineLogger(log, "[sp-grant]") }),
          ],
        }
      : {}),
    ...(cfg.agent.heartbeatIntervalS !== undefined
      ? { heartbeatIntervalS: cfg.agent.heartbeatIntervalS }
      : {}),
  });

  // A history per verified caller, bounded; none with `AGENT_MAX_HISTORY=0`.
  const histories = new Histories(cfg.agent.maxHistoryExchanges);

  // (5) Durable work, with `AGENT_DURABLE=1`: a worker of the durable SDK on
  // this connection runs the workflows this process hosts (`durable.ts`), and
  // the model is offered `start_workflow`, which starts one under the tool
  // call, joined to the prompt being served. The engine holds the journal;
  // the agent creates nothing.
  const durable: DurableTasks | undefined = cfg.durable === true
    ? await startDurableTasks(nc, model, { resultTimeoutMs: cfg.tools.replyTimeoutMs, log: (line) => log(line) })
    : undefined;

  // What the model is offered. A role that must answer itself is offered no
  // agent tools (see `config.ts`), but its own tools and the durable one
  // when it is on. The own tools are bound per prompt, in `serve`: a
  // question one of them asks goes to the caller of the prompt whose model
  // made the call.
  const agentTools = cfg.agent.tools === "none" ? NO_TOOLS : toolRunner(tools);
  const offeredFor = (ctx: OwnToolContext): ToolRunner => {
    const runner = withOwnTools(agentTools, ownTools, ctx);
    return durable !== undefined ? withDurableTasks(runner, durable) : runner;
  };

  service.onPrompt(async (envelope, response) => {
    // The served thread's ids, for log lines and ScratchPad. Read here, not
    // through `traceHeaders()`, which counts a model turn each time.
    const trace = activeTrace();
    const tag = `[${trace?.threadId.slice(0, 8) ?? "untraced"}]`;
    log(`${tag} prompt from ${formatSender(response.sender)}: ${envelope.prompt.slice(0, 80)}`);
    try {
      await serve(envelope, response, trace, tag);
    } catch (err) {
      // A model call that failed, a proxy that refused the key: the SDK
      // answers the caller with the protocol's error (500, "handler
      // error"); the reason is here, in the agent's own log.
      log(`${tag} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
      throw err;
    }
  });

  async function serve(
    envelope: { readonly prompt: string },
    response: Parameters<Parameters<typeof service.onPrompt>[0]>[1],
    trace: ReturnType<typeof activeTrace>,
    tag: string,
  ): Promise<void> {

    // (4) What it was handed: every ScratchPad reference in the prompt is
    // read, and its content follows the prompt in front of the model. The
    // extension's request interceptor has noted the references as given
    // already, so the model may hand them on exactly as they came, and
    // nothing else.
    // LIMITATION: attachments on the envelope are not read; on the fabric
    // content moves by reference.
    let userContent = envelope.prompt;
    if (scratchpad !== undefined) {
      for (const ref of findReferences(envelope.prompt)) {
        try {
          const text = await scratchpad.read(ref, trace);
          log(`${tag} read ${ref.slice(0, 40)}… (${text.length} chars)`);
          userContent += `\n\n--- content handed over as ${ref} ---\n${text}`;
        } catch (err) {
          // A reference that cannot be read is told to the model in words;
          // the prompt still gets an answer.
          const reason = err instanceof Error ? err.message : String(err);
          log(`${tag} could not read ${ref.slice(0, 40)}…: ${reason}`);
          userContent += `\n\n--- ${ref} could not be read: ${reason} ---`;
        }
      }
    }

    // (2) and (3): the model, with the agent tools, until it answers in
    // words. The tools run in this prompt's scope: a prompt the model starts
    // ends with this one, a question the prompted agent asks comes back to
    // the model, and the agent that sent this prompt is refused as a target,
    // the shortest loop between two agents.
    const messages: ChatMessage[] = [
      { role: "system", content: cfg.agent.systemPrompt },
      ...histories.for(response.sender),
      { role: "user", content: userContent },
    ];
    const turnStart = messages.length;
    // An own tool's question goes to this prompt's caller, with the time a
    // prompt to another agent may take. A caller that does not answer is a
    // throw, which the model reads as `{"error": ...}`.
    const offered = offeredFor({
      ask: async (question) => {
        log(`${tag} asks the caller: ${question.slice(0, 80)}`);
        try {
          return (await response.ask(question, { timeoutMs: cfg.tools.replyTimeoutMs })).prompt;
        } catch (err) {
          throw new Error(`the caller did not answer: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });
    let result: Awaited<ReturnType<typeof converse>>;
    try {
      result = await converse({
        model,
        tools: offered,
        messages,
        traceHeaders,
        log: (line) => log(`${tag} ${line}`),
      });
    } catch (err) {
      // The model kept answering with nothing while calls it started were
      // open: the prompt fails with the reason, never succeeds with no reply.
      if (err instanceof EmptyReplyError) throw new RequestRejectedError(500, err.message);
      throw err;
    }

    // (4) What it produced: committed under this thread's name, and the
    // reference appended to the reply, so whoever asked can hand it on
    // without pasting it. The reference goes to one agent, the caller, so
    // the caller is granted read on it right before the reply is sent, for
    // a short while — and only a caller whose signature verified, because
    // a grant names a principal and an unsigned claim proves none. A
    // caller without one gets small replies or a bounded refusal. `grantCaller`
    // makes that decision and the grant, and notes the reference as given.
    let grantedReference: string | undefined;
    if (scratchpad !== undefined && references !== undefined && trace !== undefined) {
      try {
        const ref = await scratchpad.commit(result.reply, `/replies/${trace.threadId}.md`, trace);
        log(`${tag} committed the reply as ${ref.slice(0, 40)}…`);
        if (await references.grantCaller(ref, response.sender)) {
          log(`${tag} granted ${formatSender(response.sender)} read on it`);
          grantedReference = ref;
        } else {
          log(`${tag} caller not verified: no ScratchPad handoff granted`);
        }
      } catch (err) {
        // Small replies can still go out. Large delivery requires the grant.
        log(`${tag} could not hand the reply over by reference: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const delivery = deliveredReply(result.reply, grantedReference);
    await response.send(delivery.reply);

    // The history keeps the exchange as words, not the tool traffic, with
    // one line in front of the reply naming the tools the model used.
    histories.record(response.sender, envelope.prompt, withToolNote(messages.slice(turnStart), delivery.history));
  }

  await service.start();
  const running: RunningAgent = {
    address: service.subject.prompt,
    instanceId: service.instanceId,
    identity: service.identity,
    async stop() {
      // Open prompts to other agents are cancelled before the connection goes.
      await tools.close();
      await client.close();
      await service.stop();
      await durable?.stop();
      await nativeScratchpad?.close();
      await nc.close();
      bundle.wipe();
    },
  };

  // A line for whoever started the process: a script, a test, a
  // supervisor.
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

// The SDK and the fabric package log through a `Logger`; this agent logs
// lines, to wherever `log` writes them. Debug is left out.
function lineLogger(log: (line: string) => void, prefix: string): Logger {
  const line = (msg: string, ctx?: Record<string, unknown>): void =>
    log(`${prefix} ${msg}${ctx !== undefined && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : ""}`);
  return { debug: () => {}, info: line, warn: line, error: line };
}
