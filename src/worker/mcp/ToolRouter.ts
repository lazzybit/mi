// Tool dispatch boundary (PLAN.md -> MCP subsystem -> Tool dispatch boundary).
// Resolves configuration, validates arguments, and obtains a credential before
// the attempt is marked dispatched; no usable credential means the run waits
// for authentication with no dispatched effect.

import { AppError } from "../../shared/domain";
import type { SqlStore } from "../storage/SqlStore";
import type { ToolPolicyRegistry } from "../runtime/ToolPolicy";
import type { CredentialBroker } from "./CredentialBroker";
import type { JsonSchemaValidator } from "./JsonSchemaValidator";
import type { McpSessionManager } from "./McpSessionManager";
import type { ToolCatalog } from "./ToolCatalog";
import type {
  PreparedToolCall,
  ToolExecutionOutcome,
  ToolExecutor,
  ToolInvocation,
} from "./types";
import { toConnectorConfig } from "./McpSessionManager";

export interface ApplicationToolHandler {
  handles(alias: string): boolean;
  execute(alias: string, args: unknown, invocation: ToolInvocation): Promise<ToolExecutionOutcome>;
}

export interface ToolRouterDeps {
  store: SqlStore;
  catalog: ToolCatalog;
  sessions: McpSessionManager;
  broker: CredentialBroker;
  policy: ToolPolicyRegistry;
  validator: JsonSchemaValidator;
  application?: ApplicationToolHandler;
}

export class ToolRouter implements ToolExecutor {
  constructor(private readonly deps: ToolRouterDeps) {}

  async prepare(invocation: ToolInvocation): Promise<PreparedToolCall> {
    const descriptor = this.deps.store.read((tx) => this.deps.catalog.resolve(tx, invocation.alias));
    if (!descriptor) {
      throw new AppError("CONNECTOR_UNAVAILABLE", `unknown tool: ${invocation.alias}`);
    }
    this.deps.validator.validate(descriptor.inputSchema, invocation.arguments);

    if (descriptor.connectorId.startsWith("app:")) {
      return {
        toolCallId: invocation.toolCallId,
        descriptor,
        connector: {
          id: descriptor.connectorId,
          version: descriptor.connectorVersion,
          name: "application",
          endpoint: "app://tools",
          auth: { mode: "none" },
        },
        remoteName: descriptor.remoteName,
        arguments: invocation.arguments,
        replayPolicy: "safe",
      };
    }

    const connector = this.deps.store.read((tx) => tx.mcpServers.get(descriptor.connectorId));
    if (!connector) {
      throw new AppError("CONNECTOR_UNAVAILABLE", `connector not configured: ${descriptor.connectorId}`);
    }
    if (!connector.enabled) {
      throw new AppError("CONNECTOR_UNAVAILABLE", `connector is disabled: ${connector.id}`);
    }
    if (connector.state !== "ready") {
      throw new AppError(
        connector.state === "auth_required" ? "AUTH_REQUIRED" : "CONNECTOR_UNAVAILABLE",
        `connector is not ready: ${connector.id} (${connector.state})`,
      );
    }

    // Obtain a credential before dispatch intent is persisted.
    const credential = await this.deps.broker.forConnector(connector);
    const replayPolicy = this.deps.policy.classifyRoleTool(connector.role, descriptor.remoteName);

    return {
      toolCallId: invocation.toolCallId,
      descriptor,
      connector: toConnectorConfig(connector),
      remoteName: descriptor.remoteName,
      arguments: invocation.arguments,
      replayPolicy,
      credential,
    };
  }

  async execute(call: PreparedToolCall, signal: AbortSignal): Promise<ToolExecutionOutcome> {
    if (call.descriptor.connectorId.startsWith("app:")) {
      if (!this.deps.application) {
        throw new AppError("CONNECTOR_UNAVAILABLE", "application tools are unavailable");
      }
      return this.deps.application.execute(call.descriptor.alias, call.arguments, {
        runId: "",
        conversationId: "",
        toolCallId: call.toolCallId,
        alias: call.descriptor.alias,
        arguments: call.arguments,
      });
    }
    const session = await this.deps.sessions.acquire(call.descriptor.connectorId);
    const result = await session.connection.callTool(
      { requestId: call.toolCallId, name: call.remoteName, arguments: call.arguments },
      signal,
    );
    return {
      isError: result.isError,
      content: result.content,
      structuredContent: result.structuredContent,
    };
  }
}
