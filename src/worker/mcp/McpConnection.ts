// Streamable HTTP MCP client (PLAN.md -> MCP subsystem).
//
// Implemented directly over fetch rather than a Node-assuming SDK so it runs in
// workerd. Automatic retries of `tools/call` are disabled: a reconnecting
// session may repeat initialization and discovery, but must never repeat an
// unresolved tool invocation.

import { globalFetch } from "./globalFetch";
import { parseSse } from "../models/sse";
import type { McpConnection, NormalizedToolResult, ServerCapabilities, ToolPage } from "./types";

const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export class StreamableHttpConnection implements McpConnection {
  private sessionId?: string;
  private nextId = 1;
  private detached = false;

  constructor(
    private readonly endpoint: string,
    private readonly headers: Headers,
    private readonly fetchImpl: typeof fetch = globalFetch,
  ) {}

  async initialize(signal: AbortSignal): Promise<ServerCapabilities> {
    const { result } = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mi", version: "0.1.0" },
    }, signal);
    await this.notify("notifications/initialized", {}, signal);
    const capabilities = (result as { capabilities?: ServerCapabilities } | undefined)?.capabilities;
    return capabilities ?? ({} as ServerCapabilities);
  }

  async listTools(cursor?: string): Promise<ToolPage> {
    const { result } = await this.request("tools/list", cursor ? { cursor } : {}, new AbortController().signal);
    const page = (result ?? {}) as { tools?: unknown[]; nextCursor?: string };
    return {
      tools: (page.tools ?? []) as ToolPage["tools"],
      nextCursor: page.nextCursor,
    };
  }

  async callTool(
    request: { requestId: string; name: string; arguments: unknown },
    signal: AbortSignal,
  ): Promise<NormalizedToolResult> {
    const { result, error } = await this.request(
      "tools/call",
      { name: request.name, arguments: request.arguments },
      signal,
    );
    if (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    const value = (result ?? {}) as {
      isError?: boolean;
      content?: unknown[];
      structuredContent?: unknown;
    };
    return {
      isError: value.isError === true,
      content: (value.content ?? []) as NormalizedToolResult["content"],
      structuredContent: value.structuredContent,
    };
  }

  async cancel(requestId: string): Promise<void> {
    await this.notify("notifications/cancelled", { requestId }, new AbortController().signal);
  }

  /** Close local transport resources without deleting the remote session. */
  async detach(): Promise<void> {
    this.detached = true;
  }

  /** Explicitly delete the remote session (can affect active work). */
  async terminateSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.fetchImpl(this.endpoint, {
      method: "DELETE",
      headers: this.withSession(this.headers),
    }).catch(() => undefined);
    this.sessionId = undefined;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  private async request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
    if (this.detached) throw new Error("MCP connection detached");
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.withSession(this.headers),
      body: JSON.stringify(body),
      signal,
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new McpProtocolError(response.status, `MCP ${method} failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const message = await readJsonRpcMessage(response, id);
    if (!message) {
      throw new McpProtocolError(-1, `MCP ${method} returned no matching response`);
    }
    if (message.error) {
      return { error: message.error };
    }
    return { result: message.result };
  }

  private async notify(method: string, params: unknown, signal: AbortSignal): Promise<void> {
    if (this.detached) return;
    await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.withSession(this.headers),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    }).catch(() => undefined);
  }

  private withSession(base: Headers): Headers {
    const headers = new Headers(base);
    if (this.sessionId) headers.set("mcp-session-id", this.sessionId);
    return headers;
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

async function readJsonRpcMessage(response: Response, id: number): Promise<JsonRpcMessage | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for await (const event of parseSse(response, new AbortController().signal)) {
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(event.data) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (parsed.id === id) return parsed;
    }
    return undefined;
  }
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as JsonRpcMessage;
  } catch {
    return undefined;
  }
}
