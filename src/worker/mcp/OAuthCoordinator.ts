// OAuth coordinator (PLAN.md -> MCP subsystem -> Authentication services).
// Uses PKCE S256, sends the resource indicator, stores short-lived transaction
// state, and consumes the callback state before exchanging the code. A failed
// reconstruction never loops on a consumed code or a rotated refresh token.

import { globalFetch } from "./globalFetch";
import { AppError } from "../../shared/domain";
import { sha256Hex } from "../../shared/json";
import type { SqlStore } from "../storage/SqlStore";
import type { Clock, IdGenerator } from "../runtime/Clock";
import type { AuthDiscovery, AuthDiscoveryResult } from "./AuthDiscovery";
import type { CredentialLease, OAuthClientRegistration } from "./types";

export interface OAuthCoordinatorDeps {
  store: SqlStore;
  clock: Clock;
  ids: IdGenerator;
  discovery: AuthDiscovery;
  clientMetadataUrl: string;
  callbackUrl: string;
  registration?: OAuthClientRegistration;
  fetchImpl?: typeof fetch;
}

export interface OAuthCallback {
  state: string;
  code?: string;
  issuer?: string;
  error?: string;
}

const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export class OAuthCoordinator {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: OAuthCoordinatorDeps) {
    this.fetchImpl = deps.fetchImpl ?? globalFetch;
  }

  async begin(connectorId: string): Promise<{ authorizationUrl: string }> {
    const connector = this.deps.store.read((tx) => tx.mcpServers.get(connectorId));
    if (!connector) throw new AppError("NOT_FOUND", "connector not found");
    const discovery = await this.deps.discovery.discover(connector.endpoint);
    const registration = await this.selectRegistration(discovery);
    const verifier = randomVerifier();
    const challenge = await pkceChallenge(verifier);
    const state = randomVerifier();
    const now = this.deps.clock.now();
    const id = this.deps.ids.next("oauth");
    this.deps.store.transaction((tx) => {
      tx.oauthTransactions.insert({
        id,
        stateDigest: state,
        connectorId,
        ownerKey: connector.id,
        pkceVerifier: verifier,
        issuer: discovery.issuer,
        redirectUri: this.deps.callbackUrl,
        expiresAt: now + TRANSACTION_TTL_MS,
        exchangeState: "pending",
        createdAt: now,
      });
    });

    const url = new URL(discovery.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", registration.clientId);
    url.searchParams.set("redirect_uri", this.deps.callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", discovery.resource);
    if (discovery.scopesSupported.length > 0) {
      url.searchParams.set("scope", discovery.scopesSupported.join(" "));
    }
    return { authorizationUrl: url.toString() };
  }

  async complete(callback: OAuthCallback): Promise<{ connectorId: string }> {
    if (callback.error) {
      throw new AppError("AUTH_REQUIRED", `authorization was rejected: ${callback.error}`);
    }
    if (!callback.code) throw new AppError("INVALID_INPUT", "authorization code is required");
    const digest = callback.state;
    const transaction = this.deps.store.read((tx) => tx.oauthTransactions.findByStateDigest(digest));
    if (!transaction) throw new AppError("AUTH_REQUIRED", "no pending authorization transaction");
    if (transaction.expiresAt <= this.deps.clock.now()) {
      this.deps.store.transaction((tx) => tx.oauthTransactions.delete(transaction.id));
      throw new AppError("AUTH_REQUIRED", "the authorization transaction has expired");
    }
    if (transaction.exchangeState !== "pending") {
      throw new AppError("AUTH_REQUIRED", "this authorization code was already consumed");
    }
    // Consume the state before the exchange so a lost response cannot loop.
    this.deps.store.transaction((tx) => tx.oauthTransactions.setExchangeState(transaction.id, "exchanging"));

    const metadata = await this.deps.discovery.discover(
      this.deps.store.read((tx) => tx.mcpServers.get(transaction.connectorId))?.endpoint ?? "",
    );
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.code,
      redirect_uri: transaction.redirectUri,
      client_id: this.deps.registration?.clientId ?? this.deps.clientMetadataUrl,
      code_verifier: transaction.pkceVerifier,
      resource: metadata.resource,
    });
    const response = await this.fetchImpl(metadata.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!response.ok) {
      throw new AppError("AUTH_REQUIRED", `token exchange failed (${response.status})`);
    }
    const tokens = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token) throw new AppError("AUTH_REQUIRED", "token response omitted an access token");
    const now = this.deps.clock.now();
    this.deps.store.transaction((tx) => {
      tx.credentials.upsert({
        id: `oauth:${transaction.connectorId}`,
        kind: "oauth",
        connectorId: transaction.connectorId,
        value: JSON.stringify({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        }),
        expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : undefined,
        version: 1,
        createdAt: now,
      });
      tx.oauthTransactions.delete(transaction.id);
    });
    return { connectorId: transaction.connectorId };
  }

  async refresh(connectorId: string): Promise<CredentialLease> {
    const record = this.deps.store.read((tx) => tx.credentials.findForConnector(connectorId));
    if (!record) throw new AppError("AUTH_REQUIRED", "no refresh token is stored");
    let refreshToken: string | undefined;
    try {
      refreshToken = (JSON.parse(record.value) as { refreshToken?: string }).refreshToken;
    } catch {
      refreshToken = undefined;
    }
    if (!refreshToken) throw new AppError("AUTH_REQUIRED", "no refresh token is stored");

    const connector = this.deps.store.read((tx) => tx.mcpServers.get(connectorId));
    if (!connector) throw new AppError("NOT_FOUND", "connector not found");
    const metadata = await this.deps.discovery.discover(connector.endpoint);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.deps.registration?.clientId ?? this.deps.clientMetadataUrl,
    });
    const response = await this.fetchImpl(metadata.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    if (!response.ok) {
      // A rotated or consumed refresh token cannot be recovered: require fresh
      // authorization instead of looping.
      throw new AppError("AUTH_REQUIRED", "refresh token exchange failed; re-authorize the connector");
    }
    const tokens = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tokens.access_token) throw new AppError("AUTH_REQUIRED", "refresh response omitted an access token");
    const now = this.deps.clock.now();
    this.deps.store.transaction((tx) => {
      tx.credentials.upsert({
        ...record,
        value: JSON.stringify({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? refreshToken,
        }),
        expiresAt: tokens.expires_in ? now + tokens.expires_in * 1000 : undefined,
        version: record.version + 1,
      });
    });
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${tokens.access_token}`);
    return { credentialId: record.id, version: record.version + 1, headers };
  }

  private async selectRegistration(discovery: AuthDiscoveryResult): Promise<OAuthClientRegistration> {
    if (this.deps.registration) return this.deps.registration;
    if (discovery.clientMetadataSupported) {
      return { clientId: this.deps.clientMetadataUrl };
    }
    if (discovery.registrationEndpoint) {
      const response = await this.fetchImpl(discovery.registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "mi",
          redirect_uris: [this.deps.callbackUrl],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      if (response.ok) {
        const registration = (await response.json()) as { client_id?: string; client_secret?: string };
        if (registration.client_id) {
          return { clientId: registration.client_id, clientSecret: registration.client_secret };
        }
      }
    }
    throw new AppError("NOT_CONFIGURED", "no OAuth client registration mechanism is available");
  }
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export { sha256Hex };
