// External attempt execution (PLAN.md -> Execution engine -> AttemptExecutor).

import type { AttemptId } from "../../shared/domain";
import type {
  CompletedModelTurn,
  ModelAttemptResult,
  ModelEvent,
  ModelGateway,
  ModelRequest,
  PersistedModelToolCall,
  ToolCallDelta,
} from "../models/types";
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
    const toolCallBuffers = new Map<number, ToolCallDelta>();
    let text = "";
    let reasoning = "";
    let completed: CompletedModelTurn | undefined;

    try {
      for await (const event of this.model.stream(request, signal)) {
        if (signal.aborted) throw abortError(signal);
        switch (event.type) {
          case "text_delta": {
            text += event.text;
            this.committer.append(attemptId, event.text);
            break;
          }
          case "reasoning_delta": {
            reasoning += event.text;
            break;
          }
          case "tool_call_delta": {
            const existing = toolCallBuffers.get(event.value.index) ?? { index: event.value.index };
            toolCallBuffers.set(event.value.index, {
              index: event.value.index,
              id: event.value.id ?? existing.id,
              name: event.value.name ?? existing.name,
              argumentsDelta: (existing.argumentsDelta ?? "") + (event.value.argumentsDelta ?? ""),
            });
            break;
          }
          case "usage":
          case "completed": {
            if (event.type === "completed") completed = event.value;
            break;
          }
          default: {
            break;
          }
        }
      }
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw error;
    }

    if (!completed) {
      throw new Error("model stream ended without a completed event");
    }
    const toolCalls = completed.toolCalls.length > 0 ? completed.toolCalls : bufferedToolCalls(toolCallBuffers);
    const result: ModelAttemptResult = {
      text: completed.text || text,
      toolCalls,
    };
    if (completed.native !== undefined) result.native = completed.native;
    if (completed.usage !== undefined) result.usage = completed.usage;
    if (reasoning) {
      result.native = { ...(asRecord(result.native)), reasoning };
    }
    return result;
  }

  async executeTool(call: PreparedToolCall, signal: AbortSignal): Promise<ToolExecutionOutcome> {
    if (signal.aborted) throw abortError(signal);
    return this.tools.execute(call, signal);
  }
}

function bufferedToolCalls(buffers: Map<number, ToolCallDelta>): PersistedModelToolCall[] {
  return [...buffers.values()]
    .sort((a, b) => a.index - b.index)
    .map((buffer) => {
      let parsed: unknown = {};
      try {
        parsed = buffer.argumentsDelta ? JSON.parse(buffer.argumentsDelta) : {};
      } catch {
        parsed = { _raw: buffer.argumentsDelta ?? "" };
      }
      return {
        toolCallId: buffer.id ?? `call_${buffer.index}`,
        name: buffer.name ?? "unknown",
        arguments: parsed,
      };
    });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function abortError(signal: AbortSignal): AttemptAbortedError {
  const reason = signal.reason === "deadline" ? "deadline" : "cancelled";
  return new AttemptAbortedError(reason);
}

export type { ModelEvent };
