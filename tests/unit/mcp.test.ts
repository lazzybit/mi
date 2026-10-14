import { describe, expect, it } from "vitest";
import { AppError } from "../../src/shared/domain";
import { SqlStore } from "../../src/worker/storage/SqlStore";
import { NodeSqlBackend } from "../helpers/nodeSql";
import { StreamableHttpConnection } from "../../src/worker/mcp/McpConnection";
import { McpSessionManager, toConnectorConfig } from "../../src/worker/mcp/McpSessionManager";
import { StreamableHttpTransportFactory } from "../../src/worker/mcp/McpTransportFactory";
import { ToolCatalog } from "../../src/worker/mcp/ToolCatalog";
import { ToolRouter } from "../../src/worker/mcp/ToolRouter";
import { CredentialBroker } from "../../src/worker/mcp/CredentialBroker";
import { JsonSchemaValidator } from "../../src/worker/mcp/JsonSchemaValidator";
import { ToolPolicyRegistry } from "../../src/worker/runtime/ToolPolicy";
import type { McpServerRecord } from "../../src/worker/storage/records";
import type { DiscoveredTool } from "../../src/worker/mcp/types";

function newStore() {
  const backend = new NodeSqlBackend();
  const store = new SqlStore(backend);
  store.migrate();
  return store;
}

function connector(overrides: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: "conn_1",
    name: "helper",
    endpoint: "https://helper.test/mcp",
    configurationVersion: 1,
    authenticationMode: "none",
    state: "ready",
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function fakeFetch(
  tools: DiscoveredTool[],
  onCall?: (params: { name: string; arguments: unknown }) => unknown,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as { id?: number; method: string; params?: unknown };
    const headers = { "content-type": "application/json", "mcp-session-id": "sess_1" };
    const respond = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers });
    if (body.method === "initialize") {
      return respond({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202, headers });
    }
    if (body.method === "tools/list") {
      return respond({ tools });
    }
    if (body.method === "tools/call") {
      const params = body.params as { name: string; arguments: unknown };
      const result = onCall ? onCall(params) : { content: [{ type: "text", text: "ok" }], isError: false };
      return respond(result);
    }
    return respond({});
  }) as typeof fetch;
}

describe("StreamableHttpConnection", () => {
  it("initializes, lists tools, and calls a tool", async () => {
    const connection = new StreamableHttpConnection(
      "https://helper.test/mcp",
      new Headers({ "content-type": "application/json" }),
      fakeFetch([{ name: "read", inputSchema: { type: "object" } }]),
    );
    const capabilities = await connection.initialize(new AbortController().signal);
    expect(capabilities.tools).toBeDefined();
    expect(connection.getSessionId()).toBe("sess_1");
    const page = await connection.listTools();
    expect(page.tools[0]?.name).toBe("read");
    const result = await connection.callTool(
      { requestId: "r1", name: "read", arguments: { path: "a" } },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ok" });
  });

  it("returns a normalized error result when the server reports one", async () => {
    const connection = new StreamableHttpConnection(
      "https://helper.test/mcp",
      new Headers(),
      fakeFetch([{ name: "read", inputSchema: {} }], () => ({ isError: true, content: [{ type: "text", text: "boom" }] })),
    );
    const result = await connection.callTool(
      { requestId: "r1", name: "read", arguments: {} },
      new AbortController().signal,
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: "boom" });
  });
});

describe("McpSessionManager", () => {
  it("opens once and reuses the session", async () => {
    const store = newStore();
    store.transaction((tx) => tx.mcpServers.upsert(connector()));
    let opens = 0;
    const factory = new StreamableHttpTransportFactory(fakeFetch([{ name: "read", inputSchema: {} }]));
    const broker = new CredentialBroker({ store });
    const sessions = new McpSessionManager(
      { open: async (config, credential) => { opens += 1; return factory.open(config, credential); } },
      broker,
      store,
    );
    const first = await sessions.acquire("conn_1");
    const second = await sessions.acquire("conn_1");
    expect(first).toBe(second);
    expect(opens).toBe(1);
  });

  it("reports a disabled connector as unavailable", async () => {
    const store = newStore();
    store.transaction((tx) => tx.mcpServers.upsert(connector({ enabled: false })));
    const sessions = new McpSessionManager(
      new StreamableHttpTransportFactory(fakeFetch([])),
      new CredentialBroker({ store }),
      store,
    );
    await expect(sessions.acquire("conn_1")).rejects.toMatchObject({ code: "CONNECTOR_UNAVAILABLE" });
  });
});

describe("ToolCatalog", () => {
  const deps = { now: () => 1, newId: () => "x" };

  it("derives bounded aliases and detects collisions across connectors", () => {
    const store = newStore();
    const catalog = new ToolCatalog(deps);
    store.transaction((tx) => {
      catalog.replaceDiscovery(tx, "a_b", 1, [{ name: "read", inputSchema: {} }]);
    });
    const alias = store.read((tx) => tx.mcpTools.listLatest("a_b")[0]?.alias);
    expect(alias).toBeTruthy();
    expect(() =>
      store.transaction((tx) => {
        catalog.replaceDiscovery(tx, "ab", 1, [{ name: "read", inputSchema: {} }]);
      }),
    ).toThrow(/alias/);
  });

  it("resolves an application tool alias", () => {
    const store = newStore();
    const catalog = new ToolCatalog(deps);
    const descriptor = store.read((tx) => catalog.resolve(tx, "app__read_skill"));
    expect(descriptor?.remoteName).toBe("read_skill");
  });
});

describe("CredentialBroker", () => {
  it("refuses an expired delegated Access assertion", async () => {
    const store = newStore();
    store.transaction((tx) =>
      tx.credentials.upsert({
        id: "access:owner",
        kind: "access",
        ownerKey: "o",
        value: "assertion",
        expiresAt: Date.now() - 1000,
        version: 1,
        createdAt: 1,
      }),
    );
    const broker = new CredentialBroker({ store });
    await expect(
      broker.forConnector(connector({ authenticationMode: "cf-access", trustedOrigin: "https://helper.test" })),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("forwards an explicit header credential", async () => {
    const store = newStore();
    store.transaction((tx) => {
      tx.credentials.upsert({
        id: "cred_1",
        kind: "header",
        connectorId: "conn_1",
        value: JSON.stringify({ name: "X-Api-Key", value: "secret" }),
        version: 1,
        createdAt: 1,
      });
      tx.mcpServers.upsert(connector({ authenticationMode: "header", credentialId: "cred_1" }));
    });
    const broker = new CredentialBroker({ store });
    const lease = await broker.forConnector(connector({ authenticationMode: "header", credentialId: "cred_1" }));
    expect(lease?.headers.get("X-Api-Key")).toBe("secret");
  });
});

describe("ToolRouter", () => {
  function setup() {
    const store = newStore();
    const catalog = new ToolCatalog({ now: () => 1, newId: () => "x" });
    store.transaction((tx) => {
      tx.mcpServers.upsert(connector({ role: "container" }));
      catalog.replaceDiscovery(tx, "conn_1", 1, [
        { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        { name: "bash", inputSchema: { type: "object" } },
      ]);
    });
    const broker = new CredentialBroker({ store });
    const sessions = new McpSessionManager(
      new StreamableHttpTransportFactory(fakeFetch([{ name: "read", inputSchema: {} }])),
      broker,
      store,
    );
    const router = new ToolRouter({
      store,
      catalog,
      sessions,
      broker,
      policy: new ToolPolicyRegistry(),
      validator: new JsonSchemaValidator(),
    });
    return { store, router, catalog };
  }

  it("classifies container reads as replay-safe and bash as unsafe", async () => {
    const { router, store } = setup();
    const aliasFor = (name: string) =>
      store.read((tx) => tx.mcpTools.listLatest("conn_1").find((tool) => tool.toolName === name)?.alias) as string;
    const read = await router.prepare({ runId: "r", conversationId: "c", toolCallId: "t1", alias: aliasFor("read"), arguments: { path: "a" } });
    expect(read.replayPolicy).toBe("safe");
    const bash = await router.prepare({ runId: "r", conversationId: "c", toolCallId: "t2", alias: aliasFor("bash"), arguments: {} });
    expect(bash.replayPolicy).toBe("unsafe");
  });

  it("rejects invalid arguments before dispatch", async () => {
    const { router, store } = setup();
    const alias = store.read((tx) => tx.mcpTools.listLatest("conn_1").find((tool) => tool.toolName === "read")?.alias) as string;
    await expect(
      router.prepare({ runId: "r", conversationId: "c", toolCallId: "t1", alias, arguments: {} }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("executes a prepared call through the session", async () => {
    const { router, store } = setup();
    const alias = store.read((tx) => tx.mcpTools.listLatest("conn_1").find((tool) => tool.toolName === "read")?.alias) as string;
    const prepared = await router.prepare({
      runId: "r",
      conversationId: "c",
      toolCallId: "t1",
      alias,
      arguments: { path: "a" },
    });
    const outcome = await router.execute(prepared, new AbortController().signal);
    expect(outcome.isError).toBe(false);
  });

  it("maps a stored server record to a connector config", () => {
    const config = toConnectorConfig(connector({ authenticationMode: "cf-access", trustedOrigin: "https://helper.test" }));
    expect(config.auth).toEqual({ mode: "cf-access", trustedOrigin: "https://helper.test" });
  });
});
