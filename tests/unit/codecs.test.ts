import { describe, expect, it } from "vitest";
import { OpenAIChatCodec } from "../../src/worker/models/codecs/OpenAIChatCodec";
import { OpenAIResponsesCodec } from "../../src/worker/models/codecs/OpenAIResponsesCodec";
import { AnthropicMessagesCodec } from "../../src/worker/models/codecs/AnthropicMessagesCodec";
import type { ModelEvent, ModelRequest } from "../../src/worker/models/types";
import { sse, sseResponse } from "../helpers/fakeTransport";

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    attemptId: "attempt_1",
    profile: {
      gatewayId: "gw",
      provider: "openai",
      model: "gpt-test",
      protocol: "openai-chat-completions",
      contextWindow: 1000,
      maxOutputTokens: 100,
    },
    system: "be helpful",
    history: [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "calling",
        toolCalls: [{ toolCallId: "call_prev", name: "read", arguments: { path: "a" } }],
      },
      { role: "tool", toolCallId: "call_prev", name: "read", text: "content", isError: false },
    ],
    tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("OpenAIChatCodec", () => {
  it("encodes the configured model and tool schema", () => {
    const encoded = new OpenAIChatCodec().encode(request());
    expect(encoded.provider).toBe("openai");
    expect(encoded.path).toBe("/v1/chat/completions");
    const body = encoded.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(true);
    const tools = body.tools as { function: { name: string } }[];
    expect(tools[0]?.function.name).toBe("read");
    const messages = body.messages as { role: string }[];
    expect(messages[0]?.role).toBe("system");
  });

  it("preserves text, tool-call ids, and usage from a stream fixture", async () => {
    const body = sse([
      { data: { choices: [{ delta: { content: "Hel" } }] } },
      { data: { choices: [{ delta: { content: "lo" } }] } },
      {
        data: {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } },
                ],
              },
            },
          ],
        },
      },
      {
        data: {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] } }],
        },
      },
      {
        data: {
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      },
      { data: "[DONE]" },
    ]);
    const events = await collect(new OpenAIChatCodec().decode(sseResponse(body), new AbortController().signal));
    const completed = events.find((event) => event.type === "completed");
    expect(completed).toBeDefined();
    if (completed?.type === "completed") {
      expect(completed.value.text).toBe("Hello");
      expect(completed.value.toolCalls).toEqual([
        { toolCallId: "call_1", name: "read", arguments: { path: "a" } },
      ]);
      expect(completed.value.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    }
  });
});

describe("OpenAIResponsesCodec", () => {
  it("preserves function-call ids and native continuation items", async () => {
    const body = sse([
      { event: "response.output_text.delta", data: { type: "response.output_text.delta", delta: "Hi" } },
      {
        event: "response.reasoning_summary_text.delta",
        data: { type: "response.reasoning_summary_text.delta", delta: "think" },
      },
      {
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: { type: "reasoning", id: "rs_1", encrypted_content: "enc" },
        },
      },
      {
        event: "response.output_item.done",
        data: {
          type: "response.output_item.done",
          item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: '{"path":"a"}' },
        },
      },
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          response: { usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }, output: [] },
        },
      },
    ]);
    const events = await collect(
      new OpenAIResponsesCodec().decode(sseResponse(body), new AbortController().signal),
    );
    const completed = events.find((event) => event.type === "completed");
    if (completed?.type !== "completed") throw new Error("expected completed");
    expect(completed.value.text).toBe("Hi");
    expect(completed.value.toolCalls[0]).toMatchObject({ toolCallId: "call_9", name: "read" });
    expect(completed.value.usage).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    const native = completed.value.native as { items: { type: string }[] };
    expect(native.items.some((item) => item.type === "reasoning")).toBe(true);
  });

  it("replays native items on the next turn", () => {
    const encoded = new OpenAIResponsesCodec().encode(
      request({
        profile: { ...request().profile, protocol: "openai-responses" },
        history: [
          { role: "user", text: "hi" },
          {
            role: "assistant",
            text: "answer",
            native: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }],
            toolCalls: [],
          },
        ],
      }),
    );
    const body = encoded.body as { input: { type: string }[] };
    expect(body.input.some((item) => item.type === "reasoning")).toBe(true);
  });
});

describe("AnthropicMessagesCodec", () => {
  it("preserves tool_use ids, thinking signatures, and stop reasons", async () => {
    const body = sse([
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ponder" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello" } },
      },
      {
        event: "content_block_start",
        data: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read" } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      },
      {
        event: "content_block_delta",
        data: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a"}' } },
      },
      {
        event: "message_delta",
        data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
      },
      { event: "message_stop", data: { type: "message_stop" } },
    ]);
    const events = await collect(
      new AnthropicMessagesCodec().decode(sseResponse(body), new AbortController().signal),
    );
    const completed = events.find((event) => event.type === "completed");
    if (completed?.type !== "completed") throw new Error("expected completed");
    expect(completed.value.text).toBe("Hello");
    expect(completed.value.stopReason).toBe("tool_use");
    expect(completed.value.toolCalls[0]).toMatchObject({ toolCallId: "toolu_1", name: "read" });
    const native = completed.value.native as { thinking: { signature: string }[] };
    expect(native.thinking[0]?.signature).toBe("sig123");
  });

  it("groups consecutive tool results into one user message", () => {
    const encoded = new AnthropicMessagesCodec().encode(
      request({
        profile: { ...request().profile, protocol: "anthropic-messages" },
        history: [
          { role: "user", text: "hi" },
          {
            role: "assistant",
            text: "",
            toolCalls: [
              { toolCallId: "t1", name: "read", arguments: {} },
              { toolCallId: "t2", name: "read", arguments: {} },
            ],
          },
          { role: "tool", toolCallId: "t1", name: "read", text: "a", isError: false },
          { role: "tool", toolCallId: "t2", name: "read", text: "b", isError: false },
        ],
      }),
    );
    const body = encoded.body as { messages: { role: string; content: unknown[] }[] };
    const last = body.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toHaveLength(2);
  });

  it("surfaces a mid-stream error once", async () => {
    const body = sse([
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } },
      { event: "error", data: { type: "error", error: { type: "overloaded_error", message: "overloaded" } } },
    ]);
    const events: ModelEvent[] = [];
    await expect(
      (async () => {
        for await (const event of new AnthropicMessagesCodec().decode(
          sseResponse(body),
          new AbortController().signal,
        )) {
          events.push(event);
        }
      })(),
    ).rejects.toThrow(/overloaded/);
    expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
  });
});
