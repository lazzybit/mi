// The MCP subsystem wiring (PLAN.md -> Components -> `src/worker/mcp/`).

import type { SqlStore } from "../storage/SqlStore";
import type { Clock, IdGenerator } from "../runtime/Clock";
import { ToolPolicyRegistry } from "../runtime/ToolPolicy";
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
  const router = new ToolRouter({
    store: deps.store,
    catalog,
    sessions,
    broker,
    policy: new ToolPolicyRegistry(),
    validator: new JsonSchemaValidator(),
    application: new SkillTools(deps.store),
  });
  return { catalog, broker, sessions, discovery, oauth, router };
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
