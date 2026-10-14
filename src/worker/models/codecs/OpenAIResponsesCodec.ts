// OpenAI Responses codec (PLAN.md -> Model boundary -> wire support).
// Preserves function-call IDs, reasoning items, and encrypted continuation
// items so a follow-up turn can replay provider-native state.

import type { ModelEvent, ModelHistoryItem, ModelRequest, PersistedModelToolCall, ProviderCodec } from "../types";
import { parseSse } from "../sse";
import { finalizeToolCalls, isRecord, normalizeUsage, safeParseJson } from "./shared";

interface ToolBuffer {
  id?: string;
  name?: string;
  args: string;
}

export class OpenAIResponsesCodec implements ProviderCodec {
  readonly protocol = "openai-responses" as const;

  encode(request: ModelRequest) {
    const body: Record<string, unknown> = {
      model: request.profile.model,
      stream: true,
      store: false,
      input: toResponsesInput(request.history),
    };
    if (request.system) body.instructions = request.system;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      }));
    }
    return {
      protocol: this.protocol,
      gatewayId: request.profile.gatewayId,
      provider: "openai",
      path: "/v1/responses",
      headers: { "content-type": "application/json" },
      body,
    };
  }

  async *decode(response: Response, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let text = "";
    let reasoning = "";
    let usage: ReturnType<typeof normalizeUsage>;
    const tools = new Map<string, ToolBuffer>();
    const outputItems: unknown[] = [];
    let failure: string | undefined;

    for await (const event of parseSse(response, signal)) {
      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        continue;
      }
      if (!isRecord(payload)) continue;
      const type = typeof payload.type === "string" ? payload.type : event.event;
      switch (type) {
        case "response.output_text.delta": {
          if (typeof payload.delta === "string") {
            text += payload.delta;
            yield { type: "text_delta", text: payload.delta };
          }
          break;
        }
        case "response.reasoning_summary_text.delta": {
          if (typeof payload.delta === "string") {
            reasoning += payload.delta;
            yield { type: "reasoning_delta", text: payload.delta };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const itemId = typeof payload.item_id === "string" ? payload.item_id : "0";
          const buffer = tools.get(itemId) ?? { args: "" };
          const delta = payload.delta;
          if (typeof delta === "string") buffer.args += delta;
          tools.set(itemId, buffer);
          yield {
            type: "tool_call_delta",
            value: { index: tools.size - 1, argumentsDelta: typeof delta === "string" ? delta : undefined },
          };
          break;
        }
        case "response.output_item.done": {
          const item = payload.item;
          if (isRecord(item)) {
            outputItems.push(item);
            if (item.type === "function_call") {
              const itemId = typeof item.id === "string" ? item.id : String(tools.size);
              tools.set(itemId, {
                id: typeof item.call_id === "string" ? item.call_id : itemId,
                name: typeof item.name === "string" ? item.name : undefined,
                args: typeof item.arguments === "string" ? item.arguments : "",
              });
            }
          }
          break;
        }
        case "response.completed": {
          const resp = isRecord(payload.response) ? payload.response : {};
          usage = normalizeUsage(resp.usage);
          if (Array.isArray(resp.output)) outputItems.push(...resp.output);
          if (usage) yield { type: "usage", value: usage };
          break;
        }
        case "response.failed":
        case "error": {
          const error = isRecord(payload.error) ? payload.error : payload.response;
          failure = isRecord(error) && typeof error.message === "string" ? error.message : "model response failed";
          break;
        }
        default:
          break;
      }
    }

    if (failure) throw new Error(failure);

    const toolCalls = finalizeToolCalls(tools.values());
    yield {
      type: "completed",
      value: {
        text,
        reasoning: reasoning || undefined,
        toolCalls,
        usage,
        native: { items: outputItems },
      },
    };
  }
}

export function toResponsesInput(history: ModelHistoryItem[]): unknown[] {
  const input: unknown[] = [];
  for (const item of history) {
    if (item.role === "user") {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: item.text }] });
    } else if (item.role === "summary") {
      input.push({
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: `Conversation summary:\n${item.text}` }],
      });
    } else if (item.role === "assistant") {
      if (Array.isArray(item.native) && item.native.length > 0) {
        input.push(...item.native);
        continue;
      }
      if (item.text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: item.text }],
        });
      }
      for (const call of item.toolCalls ?? []) {
        input.push({
          type: "function_call",
          call_id: call.toolCallId,
          name: call.name,
          arguments: JSON.stringify(call.arguments ?? {}),
        });
      }
    } else {
      input.push({
        type: "function_call_output",
        call_id: item.toolCallId,
        output: item.isError ? `Error: ${item.text}` : item.text,
      });
    }
  }
  return input;
}

export type { PersistedModelToolCall, safeParseJson };
