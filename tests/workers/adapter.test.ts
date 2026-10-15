// The gateway model factory executes inside workerd. This runs through the
// same built-deployment pool as the rest of the worker tests and injects a
// fixture fetch, so the registered provider and pi-ai API load and stream in
// the Workers runtime.

import { describe, expect, it } from "vitest";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createGatewayModels, type GatewayModelOptions } from "../../src/worker/models";

function sse(events: unknown[]): string {
  return events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n";
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

function context(): Context {
  return { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
}

async function run(
  response: Response,
  options: GatewayModelOptions = {},
  streamOptions: SimpleStreamOptions = {},
): Promise<{ message?: AssistantMessage; url?: string; body?: Record<string, unknown> }> {
  const originalFetch = globalThis.fetch;
  let url: string | undefined;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.body && typeof init.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    return response;
  }) as typeof fetch;
  try {
    const env = { MI_FIXTURE_MODEL_URL: "http://fixture.test" } as unknown as Env;
    const models = createGatewayModels(env, options);
    const model = models.getModel("gateway", "dynamic/runner");
    expect(model).toBeDefined();
    const message = await models.completeSimple(model!, context(), streamOptions);
    return { message, url, body };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("gateway models in workerd", () => {
  it("registers dynamic/runner and streams through the fixture endpoint", async () => {
    const body = sse([
      chatChunk({ content: "hi from workerd" }, "stop"),
      { usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
    ]);
    const { message, url } = await run(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    expect(url).toBe("http://fixture.test/v1/chat/completions");
    expect(message?.stopReason).toBe("stop");
    expect(
      message?.content.some((block) => block.type === "text" && block.text === "hi from workerd"),
    ).toBe(true);
    expect(message?.usage.totalTokens).toBe(7);
  });

  it("reports a premature EOF as an error turn", async () => {
    const body = sse([chatChunk({ content: "partial" }, null)]);
    const { message } = await run(
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    expect(message?.stopReason).toBe("error");
  });

  it("sends the configured output cap and thinking level", async () => {
    const response = sse([
      chatChunk({ content: "capped" }, "stop"),
      { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ]);
    const { body } = await run(
      new Response(response, { status: 200, headers: { "content-type": "text/event-stream" } }),
      {
        settings: {
          kind: "route",
          gatewayId: "gw1",
          routeId: "dynamic/runner",
          thinkingLevel: "high",
          maxOutputTokens: 1234,
        },
      },
      { reasoning: "high" },
    );
    expect(body?.max_completion_tokens ?? body?.max_tokens).toBe(1234);
    expect(body?.reasoning_effort).toBe("high");
  });
});
