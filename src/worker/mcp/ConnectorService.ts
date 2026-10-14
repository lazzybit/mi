// Connector configuration (PLAN.md -> MCP subsystem -> ConnectorService).
// Discovery, authentication, and session management arrive in M4/M5.

import { AppError, type ConnectorId, type ConnectorView } from "../../shared/domain";
import type { SaveConnectorInput, SetConnectorEnabledInput, UpdateConnectorInput } from "../../shared/commands";
import { hashPayload } from "../../shared/json";
import type { StoreTransaction } from "../storage/SqlStore";
import type { McpServerRecord } from "../storage/records";
import type { ServiceDeps, ServiceOutcome } from "../conversations/services";
import { DestinationPolicy } from "./DestinationPolicy";

export class ConnectorService {
  private readonly destination = new DestinationPolicy();

  constructor(private readonly deps: ServiceDeps) {}

  save(
    tx: StoreTransaction,
    input: SaveConnectorInput | UpdateConnectorInput,
  ): ServiceOutcome<{ connectorId: ConnectorId }> {
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_INPUT", "connector name must not be empty");
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new AppError("INVALID_INPUT", "connector endpoint must be an absolute URL");
    }
    this.destination.validateEndpoint(endpoint);

    const now = this.deps.now();
    const existing = "connectorId" in input && input.connectorId ? tx.mcpServers.get(input.connectorId) : undefined;
    const id = existing?.id ?? this.deps.newId();
    const version = (existing?.configurationVersion ?? 0) + 1;

    let credentialId = existing?.credentialId;
    if (input.authMode === "header") {
      if (!input.headerName || !input.headerValue) {
        throw new AppError("INVALID_INPUT", "header authentication requires a name and value");
      }
      const credentialRecord = {
        id: credentialId ?? this.deps.newId(),
        kind: "header" as const,
        connectorId: id,
        value: JSON.stringify({ name: input.headerName, value: input.headerValue }),
        version: 1,
        createdAt: now,
      };
      tx.credentials.upsert(credentialRecord);
      credentialId = credentialRecord.id;
    } else if (input.authMode === "cf-access") {
      if (!input.trustedOrigin) {
        throw new AppError("INVALID_INPUT", "cf-access authentication requires a trusted origin");
      }
      this.destination.validateTrustedOrigin(input.trustedOrigin, endpoint);
    }

    const record: McpServerRecord = {
      id,
      name,
      endpoint: endpoint.toString(),
      configurationVersion: version,
      authenticationMode: input.authMode,
      role: input.role,
      state: existing?.state ?? "unconfigured",
      enabled: existing?.enabled ?? true,
      discoveryJson: existing?.discoveryJson,
      headerName: input.headerName,
      trustedOrigin: input.trustedOrigin,
      credentialId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    tx.mcpServers.upsert(record);
    return { value: { connectorId: id }, changes: [] };
  }

  setEnabled(tx: StoreTransaction, input: SetConnectorEnabledInput): ServiceOutcome<void> {
    const existing = tx.mcpServers.get(input.connectorId);
    if (!existing) throw new AppError("NOT_FOUND", "connector not found");
    tx.mcpServers.upsert({ ...existing, enabled: input.enabled, updatedAt: this.deps.now() });
    return { value: undefined, changes: [] };
  }

  list(tx: StoreTransaction): ConnectorView[] {
    return tx.mcpServers.list().map((record) => this.view(tx, record));
  }

  view(tx: StoreTransaction, record: McpServerRecord): ConnectorView {
    return {
      id: record.id,
      name: record.name,
      endpoint: record.endpoint,
      authMode: record.authenticationMode,
      role: record.role,
      state: record.state,
      version: record.configurationVersion,
      toolCount: tx.mcpTools.listLatest(record.id).length,
      lastError: record.lastError,
    };
  }

  fingerprint(input: SaveConnectorInput): string {
    return hashPayload(input);
  }
}
