import { env } from "cloudflare:test";
import { CatalogStore } from "../../../src/worker/catalog/CatalogStore";

/**
 * ADR-0004: the Worker test pool isolates storage per test file, not per test.
 * Tests that share the application-wide catalog clear it between cases so the
 * suite no longer needs owner keys for isolation. The schema is created first
 * (through the catalog itself) and rows are removed, so a missing-table query
 * still resolves to "no such conversation".
 */
export async function resetCatalog(): Promise<void> {
  const catalog = new CatalogStore(env.DB);
  await catalog.list();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM conversations"),
    env.DB.prepare("DELETE FROM settings"),
    env.DB.prepare("DELETE FROM commands"),
  ]);
}
