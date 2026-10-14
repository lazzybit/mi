import { describe, expect, it } from "vitest";
import { AuthDiscovery } from "../../src/worker/mcp/AuthDiscovery";
import { OAuthCoordinator } from "../../src/worker/mcp/OAuthCoordinator";
import { SqlStore } from "../../src/worker/storage/SqlStore";
import { NodeSqlBackend } from "../helpers/nodeSql";
import { FixedClock, SequentialIdGenerator } from "../../src/worker/runtime/Clock";
import type { McpServerRecord } from "../../src/worker/storage/records";

function newStore() {
  const backend = new NodeSqlBackend();
  const store = new SqlStore(backend);
  store.migrate();
  return store;
}

function connector(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "conn_1",
    name: "oauth helper",
    endpoint: "https://helper.test/mcp",
    configurationVersion: 1,
    authenticationMode: "oauth",
    state: "unconfigured",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function routedFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("AuthDiscovery", () => {
  const resourceMetadata = {
    resource: "https://helper.test/mcp",
    authorization_servers: ["https://auth.test"],
    scopes_supported: ["mcp.read"],
  };
  const asMetadata = {
    issuer: "https://auth.test",
    authorization_endpoint: "https://auth.test/authorize",
    token_endpoint: "https://auth.test/token",
    registration_endpoint: "https://auth.test/register",
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
  };

  it("discovers from the challenge resource_metadata first", async () => {
    const calls: string[] = [];
    const fetchImpl = routedFetch({
      "https://challenge.test/meta": () => {
        calls.push("challenge");
        return Response.json(resourceMetadata);
      },
      "https://helper.test/.well-known/oauth-protected-resource": () => {
        calls.push("well-known");
        return Response.json(resourceMetadata);
      },
      "https://auth.test/.well-known/oauth-authorization-server": () => Response.json(asMetadata),
    });
    const result = await new AuthDiscovery(fetchImpl).discover(
      "https://helper.test/mcp",
      'Bearer resource_metadata="https://challenge.test/meta"',
    );
    expect(result.issuer).toBe("https://auth.test");
    expect(result.pkceS256Supported).toBe(true);
    expect(result.clientMetadataSupported).toBe(true);
    expect(calls[0]).toBe("challenge");
  });

  it("falls back through issuer metadata locations", async () => {
    const fetchImpl = routedFetch({
      "https://helper.test/.well-known/oauth-protected-resource/mcp": () => Response.json(resourceMetadata),
      "https://auth.test/.well-known/oauth-authorization-server": () => new Response("nope", { status: 404 }),
      "https://auth.test/.well-known/openid-configuration": () => Response.json(asMetadata),
    });
    const result = await new AuthDiscovery(fetchImpl).discover("https://helper.test/mcp");
    expect(result.tokenEndpoint).toBe("https://auth.test/token");
  });
});

describe("OAuthCoordinator", () => {
  function setup(routes: Record<string, () => Response>) {
    const store = newStore();
    store.transaction((tx) => tx.mcpServers.upsert(connector()));
    const clock = new FixedClock(1_000);
    const ids = new SequentialIdGenerator();
    const discovery = new AuthDiscovery(routedFetch({
      "https://helper.test/.well-known/oauth-protected-resource": () =>
        Response.json({ resource: "https://helper.test/mcp", authorization_servers: ["https://auth.test"] }),
      "https://auth.test/.well-known/oauth-authorization-server": () =>
        Response.json({
          issuer: "https://auth.test",
          authorization_endpoint: "https://auth.test/authorize",
          token_endpoint: "https://auth.test/token",
          client_id_metadata_document_supported: true,
          code_challenge_methods_supported: ["S256"],
        }),
      ...routes,
    }));
    const coordinator = new OAuthCoordinator({
      store,
      clock,
      ids,
      discovery,
      clientMetadataUrl: "https://mi.test/oauth/client-metadata.json",
      callbackUrl: "https://mi.test/api/mcp/oauth/callback",
      fetchImpl: routedFetch(routes),
    });
    return { store, coordinator };
  }

  it("begins an authorization with PKCE S256 and the resource indicator", async () => {
    const { store, coordinator } = setup({});
    const { authorizationUrl } = await coordinator.begin("conn_1");
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://helper.test/mcp");
    expect(url.searchParams.get("state")).toBeTruthy();
    const transaction = store.read((tx) =>
      tx.oauthTransactions.findByStateDigest(url.searchParams.get("state") as string),
    );
    expect(transaction?.exchangeState).toBe("pending");
  });

  it("consumes the state before exchanging and rejects a replay", async () => {
    const tokenCalls: string[] = [];
    const { coordinator } = setup({
      "https://auth.test/token": () => {
        tokenCalls.push("token");
        return Response.json({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
      },
    });
    const { authorizationUrl } = await coordinator.begin("conn_1");
    const state = new URL(authorizationUrl).searchParams.get("state") as string;
    await coordinator.complete({ state, code: "code_1" });
    expect(tokenCalls).toHaveLength(1);
    await expect(coordinator.complete({ state, code: "code_1" })).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
    expect(tokenCalls).toHaveLength(1);
  });

  it("requires fresh authorization when a refresh token is rejected", async () => {
    const { store, coordinator } = setup({
      "https://auth.test/token": () => new Response("invalid_grant", { status: 400 }),
    });
    store.transaction((tx) =>
      tx.credentials.upsert({
        id: "oauth:conn_1",
        kind: "oauth",
        connectorId: "conn_1",
        value: JSON.stringify({ accessToken: "old", refreshToken: "rotated" }),
        expiresAt: 0,
        version: 1,
        createdAt: 1,
      }),
    );
    await expect(coordinator.refresh("conn_1")).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
