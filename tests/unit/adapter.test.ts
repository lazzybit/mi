// ADR-0002: adapter contract tests. The real pi-ai adapter runs against
// fixture fetches; provider wire semantics are owned by pi-ai and only the
// boundary guarantees are asserted here.

import { afterAll, describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { GatewayModelGateway, legacyToCanonical } from "../../src/worker/models/GatewayModelGateway";
import { resolveRoute } from "../../src/worker/models/ModelRoutes";
import type { CanonicalModelRequest } from "../../src/worker/models/types";
import type { LegacyHistoryItem } from "../../src/worker/models/types";
import { TEST_MODEL_PROFILE } from "../helpers/runtime";

const originalFetch = globalThis.fetch;

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function sseBody(events: unknown[]): string {
  return (
    events
      .map((data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`)
      .join("") + "data: [DONE]\n\n"
  );
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 0,
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** Install a fixture fetch and return the recorded requests. */
function installFixtureFetch(
  responder: (request: RecordedRequest) => { status: number; body: string },
): { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fixture = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const source = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    source.forEach((value, key) => {
      headers[key] = value;
    });
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    const recorded: RecordedRequest = { url, headers, body };
    requests.push(recorded);
    const response = responder(recorded);
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": "text/event-stream" },
    });
  };
  globalThis.fetch = fixture as typeof fetch;
  return { requests };
}

afterAll(() => {
  globalThis.fetch = originalFetch;
});

type RouteProfile = Extract<CanonicalModelRequest["profile"], { kind: "route" }>;

function routeRequest(overrides: Partial<RouteProfile> = {}): CanonicalModelRequest {
  const selection = resolveRoute({ route: "dynamic/runner", provider: "deepseek", modelId: "deepseek-flash" });
  const profile: RouteProfile = {
    kind: "route",
    gatewayId: "gw1",
    routeId: selection.routeId,
    provider: selection.provider,
    modelId: selection.modelId,
    api: selection.api,
    model: selection.model,
    thinkingLevel: "low",
    maxTokens: 512,
  };
  return {
    version: 2,
    attemptId: "attempt_1",
    profile: { ...profile, ...overrides },
    context: {
      systemPrompt: "You are a test assistant.",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    },
  };
}

async function collect(gateway: GatewayModelGateway, request: CanonicalModelRequest): Promise<AssistantMessage> {
  const controller = new AbortController();
  let terminal: AssistantMessage | undefined;
  for await (const event of gateway.stream(request, controller.signal)) {
    if (event.type === "completed") terminal = event.message;
  }
  expect(terminal).toBeDefined();
  return terminal as AssistantMessage;
}

describe("GatewayModelGateway over the AI binding", () => {
  it("dispatches the route identity through the unified compat endpoint", async () => {
    const { requests } = installFixtureFetch(() => ({
      status: 200,
      body: sseBody([chatChunk({ content: "hi" }, "stop"), { usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]),
    }));
    const gateway = new GatewayModelGateway({ fetch: () => fetch });
    const message = await collect(gateway, routeRequest());

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (!request) throw new Error("expected a recorded request");
    expect(request.url).toBe("https://workers-binding.ai/ai-gateway/gateways/gw1/compat/chat/completions");
    // The dispatched identity is the route, not the catalog host or model id.
    expect(request.body.model).toBe("dynamic/runner");
    // Output and thinking controls are sent.
    expect(request.body.max_tokens).toBe(512);
    expect(request.body.reasoning_effort).toBe("low");
    // Binding authentication: sentinel present, provider keys suppressed.
    expect(request.headers["cf-aig-authorization"]).toBe("Bearer cloudflare-gateway-binding");
    expect(request.headers["authorization"]).toBeUndefined();
    expect(request.headers["x-api-key"]).toBeUndefined();
    // Terminal message and usage come from pi-ai.
    expect(message.stopReason).toBe("stop");
    expect(message.usage.input).toBe(3);
    expect(message.usage.output).toBe(2);
    expect(message.usage.totalTokens).toBe(5);
  });

  it("reports a premature EOF as an error turn, not a success", async () => {
    const { requests } = installFixtureFetch(() => ({
      status: 200,
      body: sseBody([chatChunk({ content: "partial" })]),
    }));
    const gateway = new GatewayModelGateway({ fetch: () => fetch });
    const message = await collect(gateway, routeRequest());
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("finish_reason");
    expect(requests).toHaveLength(1);
  });

  it("surfaces provider HTTP failures with their body as error evidence", async () => {
    installFixtureFetch(() => ({
      status: 500,
      body: JSON.stringify({ error: { message: "upstream exploded" } }),
    }));
    const gateway = new GatewayModelGateway({ fetch: () => fetch });
    const message = await collect(gateway, routeRequest());
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("upstream exploded");
  });
});

describe("GatewayModelGateway in fixture mode", () => {
  it("keeps the /v1 layout for the fixture model service", async () => {
    const { requests } = installFixtureFetch(() => ({
      status: 200,
      body: sseBody([chatChunk({ content: "hi" }, "stop")]),
    }));
    const gateway = new GatewayModelGateway({ fetch: () => fetch, baseUrlOverride: "http://127.0.0.1:8898" });
    await collect(gateway, routeRequest());
    expect(requests[0]?.url).toBe("http://127.0.0.1:8898/v1/chat/completions");
  });
});

describe("legacy request conversion", () => {
  it("converts historical system/history/tools requests into canonical contexts", async () => {
    const { requests } = installFixtureFetch(() => ({
      status: 200,
      body: sseBody([chatChunk({ content: "ok" }, "stop")]),
    }));
    const gateway = new GatewayModelGateway({ fetch: () => fetch, baseUrlOverride: "http://fixture" });
    const history: LegacyHistoryItem[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "calling",
        toolCalls: [{ toolCallId: "call_1", name: "read", arguments: { path: "a" } }],
      },
      { role: "tool", toolCallId: "call_1", name: "read", text: "content", isError: false },
    ];
    const canonical = legacyToCanonical({
      attemptId: "attempt_legacy",
      profile: TEST_MODEL_PROFILE,
      system: "legacy system",
      history,
      tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
    });
    expect(canonical.version).toBe(2);
    expect(canonical.profile.kind).toBe("legacy");
    expect(canonical.context.systemPrompt).toBe("legacy system");
    expect(canonical.context.messages).toHaveLength(3);
    expect(canonical.context.tools).toHaveLength(1);

    await collect(gateway, canonical);
    const messages = requests[0]?.body.messages as Array<Record<string, unknown>>;
    // The legacy tool call replays with its name intact (the ADR-0002 defect).
    expect(messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls))).toBe(true);
    expect(messages.some((message) => message.role === "tool" && message.tool_call_id === "call_1")).toBe(true);
    expect(requests[0]?.url).toBe("http://fixture/v1/chat/completions");
  });
});
