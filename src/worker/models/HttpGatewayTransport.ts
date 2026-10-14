// Test-only gateway transport: sends the provider-native request to a
// configured base URL instead of the AI binding. It is selected only when the
// `MI_FIXTURE_MODEL_URL` variable is present (browser acceptance), so the
// production AI-binding path is unchanged. Reusing the real codecs and gateway
// keeps the acceptance path faithful.
import type { GatewayRequest, GatewayTransport } from "./types";

export class HttpGatewayTransport implements GatewayTransport {
  constructor(private readonly baseUrl: string) {}

  async send(request: GatewayRequest, signal: AbortSignal): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${request.path}`;
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...request.headers },
      body: JSON.stringify(request.body),
      signal,
    });
  }
}
