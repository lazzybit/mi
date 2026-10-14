// MCP subsystem types (PLAN.md -> MCP subsystem).

import type { ConnectorId, ReplayPolicy } from "../../shared/domain";

export type ConnectorAuth =
  | { mode: "auto" }
  | { mode: "none" }
  | { mode: "oauth"; registration?: OAuthClientRegistration }
  | { mode: "header"; credentialId: string }
  | { mode: "cf-access"; trustedOrigin: string };

export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
}

export interface ConnectorConfig {
  id: ConnectorId;
  version: number;
  name: string;
  endpoint: string;
  auth: ConnectorAuth;
  role?: "container" | "web-research";
}

export interface ToolDescriptor {
  alias: string;
  connectorId: ConnectorId;
  connectorVersion: number;
  catalogVersion: number;
  remoteName: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

export type JsonSchema = boolean | Record<string, unknown>;

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string; blob?: string };

export interface NormalizedToolResult {
  isError: boolean;
  content: ToolContent[];
  structuredContent?: unknown;
}

export interface ServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

export interface ToolPage {
  tools: DiscoveredTool[];
  nextCursor?: string;
}

export interface McpConnection {
  initialize(signal: AbortSignal): Promise<ServerCapabilities>;
  listTools(cursor?: string): Promise<ToolPage>;
  callTool(
    request: { requestId: string; name: string; arguments: unknown },
    signal: AbortSignal,
  ): Promise<NormalizedToolResult>;
  cancel(requestId: string): Promise<void>;
  detach(): Promise<void>;
  terminateSession(): Promise<void>;
}

export interface CredentialLease {
  credentialId: string;
  version: number;
  expiresAt?: number;
  headers: Headers;
}

export interface McpTransportFactory {
  open(connector: ConnectorConfig, credential: CredentialLease | undefined): Promise<McpConnection>;
}

export interface ToolInvocation {
  runId: string;
  conversationId: string;
  toolCallId: string;
  alias: string;
  arguments: unknown;
}

export interface PreparedToolCall {
  toolCallId: string;
  descriptor: ToolDescriptor;
  connector: ConnectorConfig;
  remoteName: string;
  arguments: unknown;
  replayPolicy: ReplayPolicy;
  credential?: CredentialLease;
}

export interface ToolExecutionOutcome {
  isError: boolean;
  content: ToolContent[];
  structuredContent?: unknown;
}

export interface ToolExecutor {
  prepare(invocation: ToolInvocation): Promise<PreparedToolCall>;
  execute(call: PreparedToolCall, signal: AbortSignal): Promise<ToolExecutionOutcome>;
}

export interface ToolPolicy {
  replayPolicy(descriptor: ToolDescriptor): ReplayPolicy;
  isAllowedDuringReconciliation(descriptor: ToolDescriptor): boolean;
}

export interface ConnectionReport {
  connectorId: ConnectorId;
  state: "ready" | "auth_required" | "error";
  toolCount: number;
  authUrl?: string;
  error?: string;
}
