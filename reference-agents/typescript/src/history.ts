// history.ts — what the model is shown of earlier exchanges.
//
// Three rules, the same in the Python agent (`fabric_agent/history.py`):
//
// - A history per caller, keyed by the verified sender's agent ID. What one
//   caller said is never shown to the model serving another. A caller whose
//   signature did not verify gets no history: an unsigned claim names nobody
//   the exchange could be kept for.
// - Bounded twice: the last `maxExchanges` exchanges of a caller, and the
//   last `MAX_CALLERS` callers served; the one served longest ago is dropped
//   first. `maxExchanges` 0 keeps nothing: the model gets the system prompt
//   and the prompt alone.
// - An exchange in which the model used tools says so: one short line in
//   front of the reply names the tools and the agents it prompted, never
//   arguments or results. Without it a model that delegated is shown only
//   prompts answered at once with a finished reply, and the more such
//   examples the history holds, the more it answers the next prompt that
//   way itself, without its tools.

import type { SenderInfo } from "@synadia-ai/agents";
import type { ChatMessage } from "./model.js";

/** How many callers' histories one agent keeps. */
export const MAX_CALLERS = 32;

export class Histories {
  readonly #byCaller = new Map<string, ChatMessage[]>();
  readonly #maxExchanges: number;
  readonly #maxCallers: number;

  constructor(maxExchanges: number, maxCallers: number = MAX_CALLERS) {
    this.#maxExchanges = maxExchanges;
    this.#maxCallers = maxCallers;
  }

  /** The earlier exchanges to show the model serving this sender. */
  for(sender: SenderInfo | undefined): readonly ChatMessage[] {
    const key = keyOf(sender);
    return key === undefined ? [] : [...(this.#byCaller.get(key) ?? [])];
  }

  /** Keep one exchange for this sender; a sender that did not verify is not kept. */
  record(sender: SenderInfo | undefined, prompt: string, reply: string): void {
    const key = keyOf(sender);
    if (key === undefined || this.#maxExchanges <= 0) return;
    const history = this.#byCaller.get(key) ?? [];
    // Last served goes last: the Map's order is the order to drop in.
    this.#byCaller.delete(key);
    this.#byCaller.set(key, history);
    history.push({ role: "user", content: prompt }, { role: "assistant", content: reply });
    while (history.length > this.#maxExchanges * 2) history.splice(0, 2);
    for (const oldest of this.#byCaller.keys()) {
      if (this.#byCaller.size <= this.#maxCallers) break;
      this.#byCaller.delete(oldest);
    }
  }

  /** How many callers have a history; for tests. */
  get callers(): number {
    return this.#byCaller.size;
  }
}

function keyOf(sender: SenderInfo | undefined): string | undefined {
  return sender?.trust === "verified" ? sender.id : undefined;
}

// Only what reads as a tool name or a subject goes into the note; anything
// else the model put in a call is left out.
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS = /^[A-Za-z0-9_$.-]{1,256}$/;

/**
 * The line that says which tools a turn used, from the messages the model
 * loop added to it, or `undefined` when it used none:
 *
 *     [tools used: discover_agents; prompt_agent x2 to agents.prompt.a.o.n, agents.prompt.b.o.n; answer_agent]
 *
 * Each tool once, in the order first called, with a count above one; for
 * `prompt_agent` the addresses it named. No arguments, no results.
 */
export function toolNote(turn: readonly ChatMessage[]): string | undefined {
  const used = new Map<string, { count: number; addresses: Set<string> }>();
  for (const message of turn) {
    for (const call of message.tool_calls ?? []) {
      const name = call.function.name;
      if (!TOOL_NAME.test(name)) continue;
      const entry = used.get(name) ?? { count: 0, addresses: new Set<string>() };
      entry.count += 1;
      if (name === "prompt_agent") {
        const address = addressOf(call.function.arguments);
        if (address !== undefined) entry.addresses.add(address);
      }
      used.set(name, entry);
    }
  }
  if (used.size === 0) return undefined;
  const parts = [...used].map(([name, { count, addresses }]) => {
    const times = count > 1 ? ` x${count}` : "";
    const to = addresses.size > 0 ? ` to ${[...addresses].join(", ")}` : "";
    return `${name}${times}${to}`;
  });
  return `[tools used: ${parts.join("; ")}]`;
}

/** The reply as the history keeps it: the note, if any, on its own line in front. */
export function withToolNote(turn: readonly ChatMessage[], reply: string): string {
  const note = toolNote(turn);
  return note === undefined ? reply : `${note}\n${reply}`;
}

function addressOf(args: string): string | undefined {
  try {
    const address = (JSON.parse(args) as Record<string, unknown>)["address"];
    return typeof address === "string" && ADDRESS.test(address) ? address : undefined;
  } catch {
    return undefined;
  }
}
