// The only module that knows the AI binding's gateway API (PLAN.md -> Model
// boundary). It sends the provider-native request through the binding's
// universal-request API so AI Gateway authentication is applied by the runtime;
// a plain `fetch` to `getUrl()` is not authenticated. Tests replace it with
// `FakeGatewayTransport`.

import type { GatewayRequest, GatewayTransport } from "./types";

export class AiBindingTransport implements GatewayTransport {
  private resolved?: Ai;

  constructor(private readonly ai: Ai | (() => Ai)) {}

  async send(request: GatewayRequest, signal: AbortSignal): Promise<Response> {
    const gateway = this.resolve().gateway(request.gatewayId);
    // AI Gateway dynamic routes (`dynamic/<route>`) are invoked through the
    // unified (OpenAI-compatible) endpoint at `/compat/chat/completions`. The
    // codec emits the provider-native `/v1/...` path, so drop that segment and
    // address the unified provider for those requests.
    const model = (request.body as { model?: unknown } | undefined)?.model;
    const unified =
      request.provider === "compat" ||
      (typeof model === "string" && model.startsWith("dynamic/"));
    const provider = unified ? "compat" : request.provider;
    const endpoint = unified ? request.path.replace(/^\/v1\//, "/") : request.path;
    return gateway.run(
      {
        provider,
        endpoint,
        headers: request.headers,
        query: request.body,
      },
      { signal },
    );
  }

  private resolve(): Ai {
    if (!this.resolved) {
      this.resolved = typeof this.ai === "function" ? this.ai() : this.ai;
    }
    return this.resolved;
  }
}
