// Tool catalog and aliases (PLAN.md -> MCP subsystem -> ToolCatalog).
// Catalog refresh never silently points an existing alias at a different
// connector.

import { AppError, type ConnectorId } from "../../shared/domain";
import type { DiscoveredTool, ToolDescriptor } from "./types";
import type { StoreTransaction } from "../storage/SqlStore";
import type { McpToolRecord } from "../storage/records";
import type { ServiceDeps } from "../conversations/services";
import { APPLICATION_TOOLS, APPLICATION_TOOL_PREFIX } from "../runtime/ToolPolicy";

const MAX_ALIAS_LENGTH = 60;

export function deriveAlias(connectorId: ConnectorId, remoteName: string): string {
  const connectorSlug = connectorId.replace(/[^a-zA-Z0-9]/g, "").slice(-8) || "conn";
  const toolSlug = remoteName.replace(/[^a-zA-Z0-9_]/g, "_");
  const combined = `${connectorSlug}__${toolSlug}`;
  return combined.length > MAX_ALIAS_LENGTH ? combined.slice(0, MAX_ALIAS_LENGTH) : combined;
}

export class ToolCatalog {
  constructor(private readonly deps: ServiceDeps) {}

  replaceDiscovery(
    tx: StoreTransaction,
    connectorId: ConnectorId,
    connectorVersion: number,
    tools: DiscoveredTool[],
  ): ToolDescriptor[] {
    const catalogVersion = (tx.mcpTools.latestVersion(connectorId) ?? 0) + 1;
    const foreignAliases = new Map(
      tx.mcpTools
        .listAllAliases()
        .filter((tool) => tool.connectorId !== connectorId)
        .map((tool) => [tool.alias, tool]),
    );
    const seen = new Set<string>();
    const records: McpToolRecord[] = [];
    const descriptors: ToolDescriptor[] = [];
    for (const tool of tools) {
      const alias = deriveAlias(connectorId, tool.name);
      if (seen.has(alias)) {
        throw new AppError("CONFLICT", `duplicate tool alias within connector: ${alias}`);
      }
      seen.add(alias);
      const collision = foreignAliases.get(alias);
      if (collision) {
        throw new AppError(
          "CONFLICT",
          `tool alias ${alias} already belongs to connector ${collision.connectorId}`,
        );
      }
      records.push({
        connectorId,
        toolName: tool.name,
        catalogVersion,
        alias,
        description: tool.description ?? "",
        inputSchemaJson: JSON.stringify(tool.inputSchema ?? { type: "object" }),
        outputSchemaJson: tool.outputSchema ? JSON.stringify(tool.outputSchema) : undefined,
        annotationsJson: tool.annotations ? JSON.stringify(tool.annotations) : undefined,
        available: true,
      });
      descriptors.push({
        alias,
        connectorId,
        connectorVersion,
        catalogVersion,
        remoteName: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema ?? { type: "object" },
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      });
    }
    tx.mcpTools.replaceForVersion(connectorId, catalogVersion, records);
    return descriptors;
  }

  resolve(tx: StoreTransaction, alias: string): ToolDescriptor | undefined {
    if (alias.startsWith(APPLICATION_TOOL_PREFIX)) {
      const name = alias.slice(APPLICATION_TOOL_PREFIX.length);
      if (!APPLICATION_TOOLS.includes(name)) return undefined;
      return {
        alias,
        connectorId: "app:skills",
        connectorVersion: 1,
        catalogVersion: 1,
        remoteName: name,
        description: `Application tool ${name}`,
        inputSchema: { type: "object" },
      };
    }
    const record = tx.mcpTools.findByAlias(alias);
    if (!record) return undefined;
    return {
      alias: record.alias,
      connectorId: record.connectorId,
      connectorVersion: tx.mcpServers.get(record.connectorId)?.configurationVersion ?? 0,
      catalogVersion: record.catalogVersion,
      remoteName: record.toolName,
      description: record.description,
      inputSchema: JSON.parse(record.inputSchemaJson) as Record<string, unknown>,
      outputSchema: record.outputSchemaJson
        ? (JSON.parse(record.outputSchemaJson) as Record<string, unknown>)
        : undefined,
      annotations: record.annotationsJson
        ? (JSON.parse(record.annotationsJson) as Record<string, unknown>)
        : undefined,
    };
  }

  snapshot(tx: StoreTransaction): ToolDescriptor[] {
    const descriptors: ToolDescriptor[] = [];
    for (const server of tx.mcpServers.list()) {
      if (!server.enabled || server.state !== "ready") continue;
      for (const record of tx.mcpTools.listLatest(server.id)) {
        descriptors.push({
          alias: record.alias,
          connectorId: record.connectorId,
          connectorVersion: server.configurationVersion,
          catalogVersion: record.catalogVersion,
          remoteName: record.toolName,
          description: record.description,
          inputSchema: JSON.parse(record.inputSchemaJson) as Record<string, unknown>,
          outputSchema: record.outputSchemaJson
            ? (JSON.parse(record.outputSchemaJson) as Record<string, unknown>)
            : undefined,
          annotations: record.annotationsJson
            ? (JSON.parse(record.annotationsJson) as Record<string, unknown>)
            : undefined,
        });
      }
    }
    for (const name of APPLICATION_TOOLS) {
      descriptors.push({
        alias: `${APPLICATION_TOOL_PREFIX}${name}`,
        connectorId: "app:skills",
        connectorVersion: 1,
        catalogVersion: 1,
        remoteName: name,
        description: `Application tool ${name}`,
        inputSchema: { type: "object" },
      });
    }
    return descriptors;
  }

  nextCatalogVersion(tx: StoreTransaction, connectorId: ConnectorId): number {
    return (tx.mcpTools.latestVersion(connectorId) ?? 0) + 1;
  }
}
