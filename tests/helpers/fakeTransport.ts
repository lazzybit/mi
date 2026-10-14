import type { GatewayRequest, GatewayTransport } from "../../src/worker/models/types";

export class FakeGatewayTransport implements GatewayTransport {
  readonly requests: GatewayRequest[] = [];
  response: Response | ((request: GatewayRequest) => Response | Promise<Response>) = sseResponse("");

  async send(request: GatewayRequest, _signal: AbortSignal): Promise<Response> {
    this.requests.push(request);
    return typeof this.response === "function" ? this.response(request) : this.response;
  }
}

export function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

export function sse(events: { event?: string; data: unknown }[]): string {
  return events
    .map((entry) => {
      const lines: string[] = [];
      if (entry.event) lines.push(`event: ${entry.event}`);
      lines.push(`data: ${typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data)}`);
      return lines.join("\n");
    })
    .join("\n\n")
    .concat("\n\n");
}
