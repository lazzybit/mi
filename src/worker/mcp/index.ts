// Default tool executor: the Streamable HTTP MCP client, the tool catalog, the
// credential broker, and the reserved application tools.

import { cryptoIdGenerator } from "../runtime/Clock";
import { ToolPolicyRegistry } from "../runtime/ToolPolicy";
import { SkillTools } from "../skills/SkillTools";
import type { SqlStore } from "../storage/SqlStore";
import { CredentialBroker } from "./CredentialBroker";
import { JsonSchemaValidator } from "./JsonSchemaValidator";
import { McpSessionManager } from "./McpSessionManager";
import { StreamableHttpTransportFactory } from "./McpTransportFactory";
import { ToolCatalog } from "./ToolCatalog";
import { ToolRouter } from "./ToolRouter";
import type { ToolExecutor } from "./types";

export function createDefaultToolExecutor(_env: Env, store: SqlStore): ToolExecutor {
  const catalog = new ToolCatalog({ now: () => Date.now(), newId: () => cryptoIdGenerator.next() });
  const broker = new CredentialBroker({ store });
  const sessions = new McpSessionManager(new StreamableHttpTransportFactory(), broker, store);
  return new ToolRouter({
    store,
    catalog,
    sessions,
    broker,
    policy: new ToolPolicyRegistry(),
    validator: new JsonSchemaValidator(),
    application: new SkillTools(store),
  });
}
