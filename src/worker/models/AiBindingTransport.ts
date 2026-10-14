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
    const url = `${base.replace(/\/+$/, "")}${request.path}`;
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
