// Default model gateway factory (ADR-0002). Production dispatches through the
// AI binding, resolved lazily so ordinary Worker construction stays
// credential-free. Browser acceptance points the same adapter at a local
// fixture model service.

import type { FetchFunction } from "@earendil-works/pi-ai";
import { createAiBindingFetch } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { GatewayModelGateway, type GatewayTransportBinding } from "./GatewayModelGateway";
import type { ModelGateway } from "./types";

export function createDefaultModelGateway(env: Env): ModelGateway {
  const fixtureUrl = readFixtureModelUrl(env);
  const binding: GatewayTransportBinding = fixtureUrl
    ? { fetch: () => fetch, baseUrlOverride: fixtureUrl }
    : { fetch: () => resolveBindingFetch(env) };
  return new GatewayModelGateway(binding);
}

function resolveBindingFetch(env: Env): FetchFunction {
  const binding = env.AI as unknown as Parameters<typeof createAiBindingFetch>[0];
  if (!binding || typeof binding.fetch !== "function") {
    throw new Error("AI binding is not available in this environment");
  }
  return createAiBindingFetch(binding);
}

function readFixtureModelUrl(env: Env): string | undefined {
  const value = (env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export { GatewayModelGateway } from "./GatewayModelGateway";
export { listRouteViews, resolveRouteById, DEFAULT_ROUTE_ID } from "./ModelRoutes";
export type { ModelRouteSelection, ModelRouteView } from "./ModelRoutes";
