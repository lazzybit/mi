// External attempt execution (ADR-0002). The executor forwards deltas to the
// output committer and returns the authoritative pi-ai terminal message; it
// never reconstructs tool arguments or invents call identities.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AttemptId } from "../../shared/domain";
import type { ModelAttemptResult, ModelEvent, ModelGateway, ModelRequest } from "../models/types";
import type { PreparedToolCall, ToolExecutionOutcome, ToolExecutor } from "../mcp/types";
import type { OutputCommitter } from "./OutputCommitter";

export class AttemptAbortedError extends Error {
  constructor(
    readonly reason: "cancelled" | "deadline",
    message?: string,
  ) {
    super(message ?? `attempt aborted: ${reason}`);
    this.name = "AttemptAbortedError";
  }
}

/** Synthetic terminal message for a stream that ended without a terminal event. */
export function failedAssistantMessage(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
}

export class AttemptExecutor {
  constructor(
    private readonly model: ModelGateway,
    private readonly tools: ToolExecutor,
    private readonly committer: OutputCommitter,
  ) {}

  async executeModel(
    attemptId: AttemptId,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelAttemptResult> {
    let terminal: AssistantMessage | undefined;
    try {
      for await (const event of this.model.stream(request, signal)) {
        if (signal.aborted) throw abortError(signal);
        const mapped = consumeEvent(event, this.committer, attemptId);
        if (mapped) terminal = mapped;
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (error instanceof AttemptAbortedError) throw error;
      // ADR-0002: transport-level failures surface as terminal errors with
      // the provider error text preserved for retry classification.
      return { message: failedAssistantMessage(describe(error)) };
    }
    if (!terminal) {
      return {
        message: failedAssistantMessage("model stream ended without a terminal event"),
      };
    }
    return terminal.usage ? { message: terminal, usage: terminal.usage } : { message: terminal };
  }

  async executeTool(call: PreparedToolCall, signal: AbortSignal): Promise<ToolExecutionOutcome> {
    if (signal.aborted) throw abortError(signal);
    return this.tools.execute(call, signal);
  }
}

function consumeEvent(
  event: ModelEvent,
  committer: OutputCommitter,
  attemptId: AttemptId,
): AssistantMessage | undefined {
  switch (event.type) {
    case "text_delta":
      committer.append(attemptId, event.text);
      return undefined;
    case "thinking_delta":
      // Thinking is not user-visible output; it is preserved in the terminal
      // message's content blocks.
      return undefined;
    case "completed":
      return event.message;
    default:
      return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "model request failed";
}

function abortError(signal: AbortSignal): AttemptAbortedError {
  const reason = signal.reason === "deadline" ? "deadline" : "cancelled";
  return new AttemptAbortedError(reason);
}

export type { ModelEvent };
