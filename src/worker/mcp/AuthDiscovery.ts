// Authorization discovery (PLAN.md -> MCP subsystem -> Authentication services).
//
// Protected-resource metadata comes from the challenge first, then the
// endpoint-path well-known location, then the root. Authorization-server
// metadata follows the documented fallback order for issuers with and without a
// path.

import { AppError } from "../../shared/domain";

export interface AuthDiscoveryResult {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientMetadataSupported: boolean;
  scopesSupported: string[];
  pkceS256Supported: boolean;
}

interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface AuthorizationServerMetadata {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  client_id_metadata_document_supported?: boolean;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export class AuthDiscovery {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async discover(endpoint: string, challenge?: string): Promise<AuthDiscoveryResult> {
    const resourceUrl = new URL(endpoint);
    const resourceMetadata = await this.discoverProtectedResource(resourceUrl, challenge);
    const issuer = resourceMetadata.authorization_servers?.[0];
    if (!issuer) {
      throw new AppError("NOT_CONFIGURED", "no authorization server advertised by the resource");
    }
    const metadata = await this.discoverAuthorizationServer(new URL(issuer));
    if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
      throw new AppError("NOT_CONFIGURED", "authorization server metadata is incomplete");
    }
    const result: AuthDiscoveryResult = {
      resource: resourceMetadata.resource ?? endpoint,
      issuer,
      authorizationEndpoint: metadata.authorization_endpoint,
      tokenEndpoint: metadata.token_endpoint,
      clientMetadataSupported: metadata.client_id_metadata_document_supported === true,
      scopesSupported: metadata.scopes_supported ?? resourceMetadata.scopes_supported ?? [],
      pkceS256Supported: (metadata.code_challenge_methods_supported ?? []).includes("S256"),
    };
    if (metadata.registration_endpoint) result.registrationEndpoint = metadata.registration_endpoint;
    return result;
  }

  private async discoverProtectedResource(
    resource: URL,
    challenge?: string,
  ): Promise<ProtectedResourceMetadata> {
    const candidates: string[] = [];
    const challenged = challenge ? parseResourceMetadata(challenge) : undefined;
    if (challenged) candidates.push(challenged);
    candidates.push(`${resource.origin}/.well-known/oauth-protected-resource${trimTrailing(resource.pathname)}`);
    candidates.push(`${resource.origin}/.well-known/oauth-protected-resource`);
    for (const candidate of candidates) {
      const metadata = await this.tryJson<ProtectedResourceMetadata>(candidate);
      if (metadata) return metadata;
    }
    throw new AppError("NOT_CONFIGURED", "no protected-resource metadata was discovered");
  }

  private async discoverAuthorizationServer(issuer: URL): Promise<AuthorizationServerMetadata> {
    const path = trimTrailing(issuer.pathname);
    const candidates: string[] = [];
    if (path && path !== "/") {
      candidates.push(`${issuer.origin}/.well-known/oauth-authorization-server${path}`);
      candidates.push(`${issuer.origin}/.well-known/openid-configuration${path}`);
      candidates.push(`${issuer.origin}${path}/.well-known/openid-configuration`);
    } else {
      candidates.push(`${issuer.origin}/.well-known/oauth-authorization-server`);
      candidates.push(`${issuer.origin}/.well-known/openid-configuration`);
    }
    for (const candidate of candidates) {
      const metadata = await this.tryJson<AuthorizationServerMetadata>(candidate);
      if (metadata) return metadata;
    }
    throw new AppError("NOT_CONFIGURED", "no authorization-server metadata was discovered");
  }

  private async tryJson<T>(url: string): Promise<T | undefined> {
    try {
      const response = await this.fetchImpl(url, { headers: { accept: "application/json" } });
      if (!response.ok) return undefined;
      const value = (await response.json()) as T;
      return value && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  }
}

export function parseResourceMetadata(challenge: string): string | undefined {
  const match = /resource_metadata="([^"]+)"/.exec(challenge);
  return match?.[1];
}

function trimTrailing(pathname: string): string {
  return pathname.replace(/\/+$/, "");
}
