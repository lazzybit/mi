// OpenAI Chat Completions codec (PLAN.md -> Model boundary -> wire support).

import type {
  ModelEvent,
  ModelHistoryItem,
  ModelRequest,
  ModelUsage,
  ProviderCodec,
} from "../types";
import { parseSse } from "../sse";
import { finalizeToolCalls, isRecord, normalizeUsage, safeParseJson } from "./shared";

interface ToolBuffer {
  id?: string;
  name?: string;
  args: string;
}

export class OpenAIChatCodec implements ProviderCodec {
  readonly protocol = "openai-chat-completions" as const;

  encode(request: ModelRequest) {
    const body: Record<string, unknown> = {
      model: request.profile.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: toMessages(request.system, request.history),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    return {
      protocol: this.protocol,
      gatewayId: request.profile.gatewayId,
      provider: "openai",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body,
    };
  }

  async *decode(response: Response, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let text = "";
    let reasoning = "";
    let usage: ModelUsage | undefined;
    const tools = new Map<number, ToolBuffer>();

    for await (const event of parseSse(response, signal)) {
      if (event.data === "[DONE]") break;
      let chunk: unknown;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }
      if (!isRecord(chunk)) continue;
      const chunkUsage = normalizeUsage(chunk.usage);
      if (chunkUsage) {
        usage = chunkUsage;
        yield { type: "usage", value: chunkUsage };
      }
      const choices = chunk.choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const choice = choices[0];
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        yield { type: "text_delta", text: delta.content };
      }
      const reasoningDelta =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : undefined;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        yield { type: "reasoning_delta", text: reasoningDelta };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          if (!isRecord(rawCall)) continue;
          const index = typeof rawCall.index === "number" ? rawCall.index : 0;
          const fn = isRecord(rawCall.function) ? rawCall.function : {};
          const buffer = tools.get(index) ?? { args: "" };
          if (typeof rawCall.id === "string") buffer.id = rawCall.id;
          if (typeof fn.name === "string") buffer.name = fn.name;
          if (typeof fn.arguments === "string") buffer.args += fn.arguments;
          tools.set(index, buffer);
          yield {
            type: "tool_call_delta",
            value: {
              index,
              id: typeof rawCall.id === "string" ? rawCall.id : undefined,
              name: typeof fn.name === "string" ? fn.name : undefined,
              argumentsDelta: typeof fn.arguments === "string" ? fn.arguments : undefined,
            },
          };
        }
      }
    }

    yield {
      type: "completed",
      value: {
        text,
        reasoning: reasoning || undefined,
        toolCalls: finalizeToolCalls(
          [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
        ),
        usage,
      },
    };
  }
}

export function toMessages(system: string, history: ModelHistoryItem[]): unknown[] {
  const messages: unknown[] = [];
  if (system) messages.push({ role: "system", content: system });
  for (const item of history) {
    if (item.role === "user") {
      messages.push({ role: "user", content: item.text });
    } else if (item.role === "summary") {
      messages.push({ role: "system", content: `Conversation summary:\n${item.text}` });
    } else if (item.role === "assistant") {
      const message: Record<string, unknown> = { role: "assistant", content: item.text || null };
      if (item.toolCalls && item.toolCalls.length > 0) {
        message.tool_calls = item.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        }));
      }
      messages.push(message);
    } else {
      messages.push({
        role: "tool",
        tool_call_id: item.toolCallId,
        content: item.isError ? `Error: ${item.text}` : item.text,
      });
    }
  }
  return messages;
}

export { safeParseJson };
