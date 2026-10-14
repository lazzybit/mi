// Streamable HTTP transport factory (PLAN.md -> MCP subsystem). Local stdio
// servers are out of scope.

import { StreamableHttpConnection } from "./McpConnection";
import type { ConnectorConfig, CredentialLease, McpConnection, McpTransportFactory } from "./types";

export class StreamableHttpTransportFactory implements McpTransportFactory {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async open(connector: ConnectorConfig, credential: CredentialLease | undefined): Promise<McpConnection> {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    credential?.headers.forEach((value, key) => headers.set(key, value));
    return new StreamableHttpConnection(connector.endpoint, headers, this.fetchImpl);
  }
}
