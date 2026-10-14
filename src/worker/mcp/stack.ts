// The MCP subsystem wiring (PLAN.md -> Components -> `src/worker/mcp/`).

import { AppError } from "../../shared/domain";
import type { SqlStore } from "../storage/SqlStore";
import type { Clock, IdGenerator } from "../runtime/Clock";
import { ToolPolicyRegistry } from "../runtime/ToolPolicy";
import { RepositoryContextService } from "../context/RepositoryContextService";
import { SkillTools } from "../skills/SkillTools";
import { AuthDiscovery } from "./AuthDiscovery";
import { CredentialBroker } from "./CredentialBroker";
import { JsonSchemaValidator } from "./JsonSchemaValidator";
import { McpSessionManager } from "./McpSessionManager";
import { StreamableHttpTransportFactory } from "./McpTransportFactory";
import { OAuthCoordinator } from "./OAuthCoordinator";
import { ToolCatalog } from "./ToolCatalog";
import { ToolRouter } from "./ToolRouter";
import type { DiscoveredTool, McpConnection } from "./types";

export interface McpStack {
  catalog: ToolCatalog;
  broker: CredentialBroker;
  sessions: McpSessionManager;
  discovery: AuthDiscovery;
  oauth: OAuthCoordinator;
  repository: RepositoryContextService;
  router: ToolRouter;
}

export interface McpStackDeps {
  store: SqlStore;
  clock: Clock;
  ids: IdGenerator;
  clientMetadataUrl: string;
  callbackUrl: string;
  fetchImpl?: typeof fetch;
}

export function createMcpStack(deps: McpStackDeps): McpStack {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const catalog = new ToolCatalog({ now: () => deps.clock.now(), newId: () => deps.ids.next() });
  const broker = new CredentialBroker({ store: deps.store });
  const sessions = new McpSessionManager(new StreamableHttpTransportFactory(fetchImpl), broker, deps.store);
  const discovery = new AuthDiscovery(fetchImpl);
  const oauth = new OAuthCoordinator({
    store: deps.store,
    clock: deps.clock,
    ids: deps.ids,
    discovery,
    clientMetadataUrl: deps.clientMetadataUrl,
    callbackUrl: deps.callbackUrl,
    fetchImpl,
  });
  const repository = new RepositoryContextService({
    store: deps.store,
    clock: deps.clock,
    ids: deps.ids,
    workspaceRoot: () => deps.store.read((tx) => tx.settings.read().workspaceRoot),
    readFile: (path) => readContainerFile(deps.store, sessions, deps.ids, path),
  });
  const router = new ToolRouter({
    store: deps.store,
    catalog,
    sessions,
    broker,
    policy: new ToolPolicyRegistry(),
    validator: new JsonSchemaValidator(),
    application: new SkillTools(deps.store, repository),
  });
  return { catalog, broker, sessions, discovery, oauth, repository, router };
}

export async function listAllTools(connection: McpConnection): Promise<DiscoveredTool[]> {
  const tools: DiscoveredTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await connection.listTools(cursor);
    tools.push(...result.tools);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** A recorded instruction read through the configured container connector. */
async function readContainerFile(
  store: SqlStore,
  sessions: McpSessionManager,
  ids: IdGenerator,
  path: string,
): Promise<string> {
  const connector = store.read((tx) =>
    tx.mcpServers.list().find((server) => server.role === "container" && server.enabled && server.state === "ready"),
  );
  if (!connector) {
    throw new AppError("NOT_CONFIGURED", "no container connector is configured");
  }
  const session = await sessions.acquire(connector.id);
  const result = await session.connection.callTool(
    { requestId: ids.next("read"), name: "read", arguments: { path } },
    new AbortController().signal,
  );
  if (result.isError) {
    throw new AppError("NOT_FOUND", `unable to read ${path} from the container`);
  }
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n");
}
