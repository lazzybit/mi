// Anthropic Messages codec (PLAN.md -> Model boundary -> wire support).
// Preserves `tool_use` / `tool_result` IDs, thinking signatures, and stop
// reasons.

import type {
  ModelEvent,
  ModelHistoryItem,
  ModelRequest,
  PersistedModelToolCall,
  ProviderCodec,
} from "../types";
import { parseSse } from "../sse";
import { isRecord, normalizeUsage, safeParseJson } from "./shared";

interface BlockBuffer {
  type: string;
  id?: string;
  name?: string;
  args: string;
  thinking: string;
  signature?: string;
}

export class AnthropicMessagesCodec implements ProviderCodec {
  readonly protocol = "anthropic-messages" as const;

  encode(request: ModelRequest) {
    const body: Record<string, unknown> = {
      model: request.profile.model,
      max_tokens: request.profile.maxOutputTokens,
      stream: true,
      messages: toAnthropicMessages(request.history),
    };
    if (request.system) body.system = request.system;
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    return {
      protocol: this.protocol,
      gatewayId: request.profile.gatewayId,
      provider: "anthropic",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    };
  }

  async *decode(response: Response, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let text = "";
    let reasoning = "";
    let usage: ReturnType<typeof normalizeUsage>;
    let stopReason: string | undefined;
    const blocks = new Map<number, BlockBuffer>();
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
      const index = typeof payload.index === "number" ? payload.index : 0;
      switch (type) {
        case "content_block_start": {
          const block = isRecord(payload.content_block) ? payload.content_block : {};
          blocks.set(index, {
            type: typeof block.type === "string" ? block.type : "text",
            id: typeof block.id === "string" ? block.id : undefined,
            name: typeof block.name === "string" ? block.name : undefined,
            args: "",
            thinking: typeof block.thinking === "string" ? block.thinking : "",
            signature: typeof block.signature === "string" ? block.signature : undefined,
          });
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(index) ?? { type: "text", args: "", thinking: "" };
          const delta = isRecord(payload.delta) ? payload.delta : {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            text += delta.text;
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            block.thinking += delta.thinking;
            reasoning += delta.thinking;
            yield { type: "reasoning_delta", text: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            block.args += delta.partial_json;
            yield {
              type: "tool_call_delta",
              value: { index, argumentsDelta: delta.partial_json },
            };
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
            block.signature = (block.signature ?? "") + delta.signature;
          }
          blocks.set(index, block);
          break;
        }
        case "message_delta": {
          const delta = isRecord(payload.delta) ? payload.delta : {};
          if (typeof delta.stop_reason === "string") stopReason = delta.stop_reason;
          usage = normalizeUsage(payload.usage) ?? usage;
          if (usage) yield { type: "usage", value: usage };
          break;
        }
        case "error": {
          const error = isRecord(payload.error) ? payload.error : {};
          failure = typeof error.message === "string" ? error.message : "anthropic request failed";
          break;
        }
        default:
          break;
      }
    }

    if (failure) throw new Error(failure);

    const toolCalls: PersistedModelToolCall[] = [];
    const thinkingBlocks: { thinking: string; signature?: string }[] = [];
    for (const block of [...blocks.values()]) {
      if (block.type === "tool_use") {
        toolCalls.push({
          toolCallId: block.id ?? `tool_${toolCalls.length}`,
          name: block.name ?? "unknown",
          arguments: safeParseJson(block.args),
        });
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        thinkingBlocks.push({ thinking: block.thinking, signature: block.signature });
      }
    }

    yield {
      type: "completed",
      value: {
        text,
        reasoning: reasoning || undefined,
        toolCalls,
        usage,
        stopReason,
        native: thinkingBlocks.length > 0 ? { thinking: thinkingBlocks } : undefined,
      },
    };
  }
}

export function toAnthropicMessages(history: ModelHistoryItem[]): unknown[] {
  const messages: unknown[] = [];
  let pendingToolResults: unknown[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const item of history) {
    if (item.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: item.toolCallId,
        content: item.text,
        is_error: item.isError,
      });
      continue;
    }
    flushToolResults();
    if (item.role === "user") {
      messages.push({ role: "user", content: [{ type: "text", text: item.text }] });
    } else if (item.role === "summary") {
      messages.push({
        role: "user",
        content: [{ type: "text", text: `Conversation summary:\n${item.text}` }],
      });
    } else if (item.role === "assistant") {
      const content: unknown[] = [];
      const native = isRecord(item.native) && Array.isArray(item.native.thinking) ? item.native.thinking : [];
      for (const thinking of native) {
        if (isRecord(thinking)) {
          content.push({
            type: "thinking",
            thinking: typeof thinking.thinking === "string" ? thinking.thinking : "",
            signature: typeof thinking.signature === "string" ? thinking.signature : undefined,
          });
        }
      }
      if (item.text) content.push({ type: "text", text: item.text });
      for (const call of item.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.toolCallId, name: call.name, input: call.arguments ?? {} });
      }
      messages.push({ role: "assistant", content });
    }
  }
  flushToolResults();
  return messages;
}
