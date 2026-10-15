// ADR-0002: repository-owned route-to-catalog mapping. The deployment maps
// application route ids onto qualified pi-ai catalog references; users never
// supply provider identifiers, model ids, protocols, or token limits.

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { DEEPSEEK_MODELS } from "@earendil-works/pi-ai/providers/deepseek.models";
import { AppError, type ModelRouteView } from "../../shared/domain";

/** The binding's OpenAI-compatible endpoint for dynamic gateway routes. */
export const BINDING_BASE_URL = "https://workers-binding.ai/ai-gateway/gateways";

/** pi-ai catalog providers referenced by configured routes. */
const CATALOGS: Record<string, Record<string, unknown>> = {
  deepseek: DEEPSEEK_MODELS as Record<string, unknown>,
};

export interface ModelRouteMapping {
  route: string;
  provider: string;
  modelId: string;
}

/** The initial deployment mapping (ADR-0002): dynamic/runner -> deepseek/deepseek-flash. */
export const ROUTE_MAPPINGS: readonly ModelRouteMapping[] = [
  { route: "dynamic/runner", provider: "deepseek", modelId: "deepseek-flash" },
];

export const DEFAULT_ROUTE_ID = ROUTE_MAPPINGS[0]?.route ?? "";

/** The default route selection applied when nothing is configured (ADR-0002). */
export interface RouteSettingsShape {
  kind: "route";
  gatewayId: string;
  routeId: string;
  thinkingLevel?: string;
  maxOutputTokens?: number;
}

export function defaultRouteSettings(): RouteSettingsShape {
  return { kind: "route", gatewayId: "default", routeId: DEFAULT_ROUTE_ID };
}

/**
 * A resolved route: the catalog entry stays provider-owned metadata; the
 * dispatched identity remains the route itself (`model: "dynamic/runner"`).
 * Catalog prices are source-specific estimates and never a proof of billing.
 */
export interface ModelRouteSelection {
  routeId: string;
  provider: string;
  modelId: string;
  api: string;
  /** Resolved catalog entry (plain JSON, safe to freeze in request artifacts). */
  model: Record<string, unknown>;
  modelName: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevels: ModelThinkingLevel[];
}

function catalogModel(provider: string, modelId: string): Record<string, unknown> {
  const catalog = CATALOGS[provider];
  if (!catalog) {
    throw new AppError("NOT_CONFIGURED", `no catalog for provider: ${provider}`, false);
  }
  const entry = catalog[modelId];
  if (typeof entry !== "object" || entry === null) {
    throw new AppError(
      "NOT_CONFIGURED",
      `model ${provider}/${modelId} is missing from its catalog`,
      false,
    );
  }
  return entry as Record<string, unknown>;
}

/** Resolve and validate one configured route against its catalog (ADR-0002). */
export function resolveRoute(mapping: ModelRouteMapping): ModelRouteSelection {
  const entry = catalogModel(mapping.provider, mapping.modelId);
  const api = typeof entry.api === "string" ? entry.api : "";
  // Dynamic gateway routes always speak the OpenAI-compatible chat protocol;
  // the metadata source must not redirect requests to its hosting provider.
  if (mapping.route.startsWith("dynamic/") && api !== "openai-completions") {
    throw new AppError(
      "NOT_CONFIGURED",
      `route ${mapping.route} requires the openai-completions API, catalog reports ${api || "unknown"}`,
      false,
    );
  }
  const model = entry as unknown as Model<string>;
  return {
    routeId: mapping.route,
    provider: mapping.provider,
    modelId: mapping.modelId,
    api,
    model: entry,
    modelName: typeof model.name === "string" ? model.name : mapping.modelId,
    contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 0,
    maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 0,
    thinkingLevels: getSupportedThinkingLevels(model as Model<never>),
  };
}

export function resolveRouteById(routeId: string): ModelRouteSelection {
  const mapping = ROUTE_MAPPINGS.find((entry) => entry.route === routeId);
  if (!mapping) {
    throw new AppError("NOT_CONFIGURED", `unknown model route: ${routeId}`, false);
  }
  return resolveRoute(mapping);
}

/** Serializable route choices for the settings interface (ADR-0002). */
export type { ModelRouteView } from "../../shared/domain";

export function listRouteViews(): ModelRouteView[] {
  return ROUTE_MAPPINGS.map((mapping) => {
    const selection = resolveRoute(mapping);
    return {
      routeId: selection.routeId,
      label: selection.modelName,
      provider: selection.provider,
      modelId: selection.modelId,
      api: selection.api,
      contextWindow: selection.contextWindow,
      maxTokens: selection.maxTokens,
      thinkingLevels: selection.thinkingLevels,
    };
  });
}
