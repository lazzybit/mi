// The only module that knows the AI binding's gateway API (PLAN.md -> Model
// boundary). It resolves the provider-scoped gateway URL and performs the
// provider-native request; tests replace it with `FakeGatewayTransport`.

import type { GatewayRequest, GatewayTransport } from "./types";

export class AiBindingTransport implements GatewayTransport {
  private resolved?: Ai;

  constructor(private readonly ai: Ai | (() => Ai)) {}

  async send(request: GatewayRequest, signal: AbortSignal): Promise<Response> {
    const gateway = this.resolve().gateway(request.gatewayId);
    const base = await gateway.getUrl(request.provider);
    // The unified (OpenAI-compatible) endpoint is mounted at
    // `/compat/chat/completions`, and AI Gateway dynamic routes
    // (`dynamic/<route>`) are invoked through it. Codecs emit the
    // provider-native `/v1/...` path, so drop that segment for this provider.
    const path =
      request.provider === "compat" ? request.path.replace(/^\/v1\//, "/") : request.path;
    const url = `${base.replace(/\/+$/, "")}${path}`;
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal,
    });
  }

  private resolve(): Ai {
    if (!this.resolved) {
      this.resolved = typeof this.ai === "function" ? this.ai() : this.ai;
    }
    return this.resolved;
  }
}
