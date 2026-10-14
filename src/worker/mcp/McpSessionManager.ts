// MCP session management (PLAN.md -> MCP subsystem -> McpSessionManager).
// `detach()` closes local transport resources without deleting a remote session;
// `terminateSession()` explicitly deletes it.

import { AppError } from "../../shared/domain";
import type { SqlStore } from "../storage/SqlStore";
import type { McpServerRecord } from "../storage/records";
import type { ConnectorConfig, CredentialLease, McpConnection, McpTransportFactory } from "./types";
import type { CredentialBroker } from "./CredentialBroker";

export interface McpSession {
  connection: McpConnection;
  connector: McpServerRecord;
  version: number;
}

export class McpSessionManager {
  private readonly sessions = new Map<string, McpSession>();

  constructor(
    private readonly factory: McpTransportFactory,
    private readonly broker: CredentialBroker,
    private readonly store: SqlStore,
  ) {}

  async acquire(connectorId: string): Promise<McpSession> {
    const existing = this.sessions.get(connectorId);
    if (existing) return existing;

    const connector = this.store.read((tx) => tx.mcpServers.get(connectorId));
    if (!connector) throw new AppError("NOT_FOUND", `connector not found: ${connectorId}`);
    if (!connector.enabled) {
      throw new AppError("CONNECTOR_UNAVAILABLE", `connector is disabled: ${connectorId}`);
    }
    const credential = await this.broker.forConnector(connector);
    const connection = await this.factory.open(toConnectorConfig(connector), credential);
    await connection.initialize(new AbortController().signal);
    const session: McpSession = {
      connection,
      connector,
      version: connector.configurationVersion,
    };
    this.sessions.set(connectorId, session);
    return session;
  }

  /** Keep the session for reuse; local resources stay open. */
  async release(connectorId: string): Promise<void> {
    void connectorId;
  }

  /** Close local transport resources but keep the remote session alive. */
  async detach(connectorId: string): Promise<void> {
    const session = this.sessions.get(connectorId);
    if (!session) return;
    await session.connection.detach();
    this.sessions.delete(connectorId);
  }

  /** Explicitly delete the remote session. */
  async invalidate(connectorId: string): Promise<void> {
    const session = this.sessions.get(connectorId);
    if (!session) return;
    await session.connection.terminateSession();
    this.sessions.delete(connectorId);
  }

  has(connectorId: string): boolean {
    return this.sessions.has(connectorId);
  }
}

export function toConnectorConfig(record: McpServerRecord): ConnectorConfig {
  const auth =
    record.authenticationMode === "cf-access"
      ? ({ mode: "cf-access", trustedOrigin: record.trustedOrigin ?? "" } as const)
      : record.authenticationMode === "header"
        ? ({ mode: "header", credentialId: record.credentialId ?? "" } as const)
        : record.authenticationMode === "oauth"
          ? ({ mode: "oauth" } as const)
          : record.authenticationMode === "none"
            ? ({ mode: "none" } as const)
            : ({ mode: "auto" } as const);
  return {
    id: record.id,
    version: record.configurationVersion,
    name: record.name,
    endpoint: record.endpoint,
    auth,
    role: record.role,
  };
}

export type { CredentialLease };
