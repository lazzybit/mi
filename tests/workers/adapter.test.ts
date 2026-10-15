// ADR-0002: the real pi-ai adapter executes inside workerd. This runs through
// the same built-deployment pool as the rest of the worker tests and injects a
// fixture fetch, so provider SDKs load and stream in the Workers runtime.

import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { GatewayModelGateway } from "../../src/worker/models/GatewayModelGateway";
import { resolveRoute } from "../../src/worker/models/ModelRoutes";
import type { CanonicalModelRequest, ModelEvent } from "../../src/worker/models/types";

function sse(events: unknown[]): string {
  return (
    events
      .map((data) => `data: ${JSON.stringify(data)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null): unknown {
  return {
    id: "chatcmpl-workerd",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function request(): CanonicalModelRequest {
  const selection = resolveRoute({
    route: "dynamic/runner",
    provider: "deepseek",
    modelId: "deepseek-flash",
  });
  return {
    version: 2,
    attemptId: "attempt_workerd",
    profile: {
      kind: "route",
      gatewayId: "gw1",
      routeId: selection.routeId,
      provider: selection.provider,
      modelId: selection.modelId,
      api: selection.api,
      model: selection.model,
      maxTokens: 256,
    },
    context: {
      systemPrompt: "You are a test assistant.",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    },
  };
}

async function run(response: Response): Promise<{ message?: AssistantMessage; url?: string }> {
  const gateway = new GatewayModelGateway({
    fetch: () => async (input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      (globalThis as Record<string, unknown>).__adapterUrl = url;
      return response;
    },
  });
  const controller = new AbortController();
  let message: AssistantMessage | undefined;
  for await (const event of gateway.stream(request(), controller.signal) as AsyncIterable<ModelEvent>) {
    if (event.type === "completed") message = event.message;
  }
  return { message, url: (globalThis as Record<string, unknown>).__adapterUrl as string | undefined };
}

describe("model adapter in workerd", () => {
  it("streams a completed assistant message through the binding endpoint", async () => {
    const body = sse([
      chatChunk({ content: "hi from workerd" }, "stop"),
      { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
    ]);
    const { message, url } = await run(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    expect(url).toBe("https://workers-binding.ai/ai-gateway/gateways/gw1/compat/chat/completions");
    expect(message?.stopReason).toBe("stop");
    expect(message?.content.some((block) => block.type === "text" && block.text === "hi from workerd")).toBe(true);
    expect(message?.usage.totalTokens).toBe(7);
  });

  it("reports a premature EOF as an error turn", async () => {
    const body = sse([chatChunk({ content: "partial" }, null)]);
    const { message } = await run(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    expect(message?.stopReason).toBe("error");
  });
});
