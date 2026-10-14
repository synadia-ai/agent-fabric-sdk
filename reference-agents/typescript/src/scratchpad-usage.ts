import {
  NativeScratchPadError,
  type ScratchPadClient,
} from "@synadia-ai/agent-fabric";
import type { ToolRunner } from "./model.js";
import type { ChatTool } from "./tools.js";

export const SCRATCHPAD_USAGE_TOOL = "scratchpad_usage";
export const USAGE_DESCRIPTION =
  "Read this agent's ScratchPad volume allowance and current charged usage without changing it. Bytes are encoded chunks and metadata, including retained history and reservations; objects are not files. Ordinary headroom is an observation, not a guarantee that a write fits. Removal reserve is separate. An unbound workspace has unknown usage, not zero usage. No arguments or credentials are accepted.";

/** Add a read-only model tool without changing the agent's reply delivery policy. */
export class ScratchPadUsage implements ToolRunner {
  readonly definitions: ToolRunner["definitions"];
  private readonly inspector?: { diagnostics(): Promise<unknown> };

  constructor(
    private readonly runner: ToolRunner,
    client?: ScratchPadClient,
  ) {
    if (
      client &&
      "diagnostics" in client &&
      typeof client.diagnostics === "function"
    ) {
      this.inspector = client as ScratchPadClient & {
        diagnostics(): Promise<unknown>;
      };
    }
    const definition: ChatTool = {
      type: "function",
      function: {
        name: SCRATCHPAD_USAGE_TOOL,
        description: USAGE_DESCRIPTION,
        strict: false,
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    };
    this.definitions =
      this.inspector === undefined
        ? runner.definitions
        : [...runner.definitions, definition];
  }

  async call(name: string, args: unknown, toolCallId: string): Promise<string> {
    if (name !== SCRATCHPAD_USAGE_TOOL || this.inspector === undefined) {
      return this.runner.call(name, args, toolCallId);
    }
    try {
      const value: unknown =
        typeof args === "string"
          ? args.trim() === ""
            ? {}
            : JSON.parse(args)
          : args;
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 0
      )
        return JSON.stringify({ status: "invalid", code: "invalid_arguments" });
    } catch {
      return JSON.stringify({ status: "invalid", code: "invalid_arguments" });
    }
    try {
      return JSON.stringify(await this.inspector.diagnostics());
    } catch (error) {
      // Never send raw transport errors, workspace paths or credentials to the model.
      return JSON.stringify({
        status: "error",
        code:
          error instanceof NativeScratchPadError ? error.code : "unavailable",
      });
    }
  }
}
