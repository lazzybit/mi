import { afterEach, describe, expect, it, vi } from "vitest";
import { AiBindingTransport } from "../../src/worker/models/AiBindingTransport";
import type { GatewayRequest } from "../../src/worker/models/types";

function fakeAi(base: string): Ai {
  return {
    gateway: (id: string) => ({
      getUrl: async (provider?: string) => `${base}/${id}${provider ? `/${provider}` : ""}`,
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends the provider-native path for a normal provider", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new AiBindingTransport(fakeAi("https://gateway.test/v1/account"));

    await transport.send(request({ provider: "openai" }), new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.test/v1/account/mi/openai/v1/chat/completions",
      expect.anything(),
    );
  });

  it("uses the unified endpoint for the compat provider", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new AiBindingTransport(fakeAi("https://gateway.test/v1/account"));

    await transport.send(
      request({ provider: "compat", body: { model: "dynamic/runner" } }),
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.test/v1/account/mi/compat/chat/completions",
      expect.anything(),
    );
  });
});
