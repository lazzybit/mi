import { describe, expect, it } from "vitest";
import { AiBindingTransport } from "../../src/worker/models/AiBindingTransport";
import type { GatewayRequest } from "../../src/worker/models/types";

interface Recorded {
  gatewayId: string;
  request: { provider: string; endpoint: string; headers: Record<string, string>; query: unknown };
}

function fakeAi(recorded: Recorded[]): Ai {
  return {
    gateway: (gatewayId: string) => ({
      run: async (request: Recorded["request"]) => {
        recorded.push({ gatewayId, request });
        return new Response("{}", { status: 200 });
      },
    }),
  } as unknown as Ai;
}

function request(overrides: Partial<GatewayRequest>): GatewayRequest {
  return {
    protocol: "openai-chat-completions",
    gatewayId: "mi",
    provider: "openai",
    path: "/v1/chat/completions",
    headers: {},
    body: {},
    ...overrides,
  };
}

describe("AiBindingTransport", () => {
  it("sends a provider-native request through the binding", async () => {
    const recorded: Recorded[] = [];
    const transport = new AiBindingTransport(fakeAi(recorded));

    await transport.send(
      request({ body: { model: "gpt-4.1-mini" } }),
      new AbortController().signal,
    );

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.gatewayId).toBe("mi");
    expect(recorded[0]!.request).toMatchObject({
      provider: "openai",
      endpoint: "/v1/chat/completions",
      query: { model: "gpt-4.1-mini" },
    });
  });

  it("routes dynamic models through the unified endpoint", async () => {
    const recorded: Recorded[] = [];
    const transport = new AiBindingTransport(fakeAi(recorded));

    await transport.send(
      request({ body: { model: "dynamic/runner" } }),
      new AbortController().signal,
    );

    expect(recorded[0]!.request).toMatchObject({
      provider: "compat",
      endpoint: "/chat/completions",
      query: { model: "dynamic/runner" },
    });
  });
});
