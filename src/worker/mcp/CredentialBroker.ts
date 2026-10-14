// Credential leasing (PLAN.md -> MCP subsystem -> CredentialBroker).
// The worker assertion is never sent while probing an untrusted endpoint, and a
// credential is forwarded only to its configured destination.

import { AppError } from "../../shared/domain";
import type { SqlStore } from "../storage/SqlStore";
import type { McpServerRecord } from "../storage/records";
import type { CredentialLease } from "./types";

export interface CredentialBrokerDeps {
  store: SqlStore;
  refreshOAuth?: (connectorId: string) => Promise<CredentialLease>;
}

export class CredentialBroker {
  constructor(private readonly deps: CredentialBrokerDeps) {}

  async forConnector(connector: McpServerRecord): Promise<CredentialLease | undefined> {
    if (connector.authenticationMode === "none" || connector.authenticationMode === "auto") {
      return undefined;
    }

    if (connector.authenticationMode === "header") {
      const record = connector.credentialId
        ? this.deps.store.read((tx) => tx.credentials.get(connector.credentialId as string))
        : this.deps.store.read((tx) => tx.credentials.findForConnector(connector.id));
      if (!record) throw new AppError("AUTH_REQUIRED", "connector header credential is missing");
      const parsed = JSON.parse(record.value) as { name: string; value: string };
      const headers = new Headers();
      headers.set(parsed.name, parsed.value);
      return { credentialId: record.id, version: record.version, headers };
    }

    if (connector.authenticationMode === "cf-access") {
      const record = this.deps.store.read((tx) => tx.credentials.get("access:owner"));
      if (!record) {
        throw new AppError("AUTH_REQUIRED", "no delegated Access assertion is available");
      }
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
        throw new AppError("AUTH_REQUIRED", "the delegated Access assertion has expired");
      }
      const headers = new Headers();
      headers.set("Cf-Access-Token", record.value);
      return { credentialId: record.id, version: record.version, expiresAt: record.expiresAt, headers };
    }

    // oauth
    const record = this.deps.store.read((tx) => tx.credentials.findForConnector(connector.id));
    if (!record) throw new AppError("AUTH_REQUIRED", "connector authorization is required");
    if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
      if (!this.deps.refreshOAuth) {
        throw new AppError("AUTH_REQUIRED", "the connector credential has expired");
      }
      return this.deps.refreshOAuth(connector.id);
    }
    const token = parseToken(record.value);
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${token}`);
    return { credentialId: record.id, version: record.version, expiresAt: record.expiresAt, headers };
  }
}

function parseToken(value: string): string {
  try {
    const parsed = JSON.parse(value) as { accessToken?: string };
    return parsed.accessToken ?? value;
  } catch {
    return value;
  }
}
