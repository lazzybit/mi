"use server";

// Model settings server function (ADR-0002, ADR-0003). Settings live in the
// owner-scoped D1 row, not in an owner Durable Object.

import type { ModelSettingsView, SaveModelProfileInput } from "../shared/domain";
import { requireRpcContext } from "../worker/rpc/RpcContext";

export async function saveModelProfile(input: SaveModelProfileInput): Promise<ModelSettingsView> {
  const context = requireRpcContext();
  return context.catalog.saveModelProfile(context.key, input);
}
