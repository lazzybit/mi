// Model access for the pi-durable harness (ADR-0002, ADR-0003).
//
// The harness consumes a pi-ai `Models` collection. This module registers the
// deployment's gateway route as a pi-ai provider so generation resolves
// `getModel("gateway", "<routeId>")`. Provider wire encoding, streaming
// events, thinking control, stop reasons, usage, and error classification come
// from pi-ai; retries belong to the harness.

import type { FetchFunction, Model, MutableModels, ProviderStreams } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL,
  createAiBindingFetch,
  type AiBinding,
} from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import {
  BINDING_BASE_URL,
  DEFAULT_ROUTE_ID,
  defaultRouteSettings,
  resolveRouteById,
  type ModelRouteSelection,
} from "./ModelRoutes";
import { parseStoredRouteSettings, type StoredRouteSettings } from "./StoredSettings";

/** Internal provider id every managed route dispatches through. */
export const GATEWAY_PROVIDER_ID = "gateway";

export interface GatewayModelOptions {
  /** Stored route settings; absent selects the default route. */
  settings?: StoredRouteSettings;
}

/**
 * Build the pi-ai `Models` collection the harness generation uses. The AI
 * binding fetch is resolved lazily so opening a session stays credential-free
 * and tests can point the route at a fixture service.
 */
export function createGatewayModels(env: Env, options: GatewayModelOptions = {}): MutableModels {
  const models = createModels({
    // No ambient credentials and no filesystem probing inside the Worker.
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  registerGatewayProvider(models, env, options);
  return models;
}

/**
 * (Re-)register the gateway provider for the given settings. Replacing the
 * provider in the same collection is what makes a saved model setting affect
 * the next generation request.
 */
export function registerGatewayProvider(
  models: MutableModels,
  env: Env,
  options: GatewayModelOptions = {},
): void {
  const settings = options.settings ?? defaultRouteSettings();
  const selection = resolveRouteById(settings.routeId);
  const baseUrl = resolveBaseUrl(env, settings.gatewayId, selection);
  const fetch = lazyGatewayFetch(env);

  const model = {
    ...selection.model,
    id: selection.routeId,
    name: selection.modelName,
    provider: GATEWAY_PROVIDER_ID,
    api: "openai-completions",
    baseUrl,
    // ADR-0002: the application output policy is bounded by the catalog limit.
    maxTokens: clampMaxTokens(settings.maxOutputTokens, selection.maxTokens),
  } as unknown as Model<"openai-completions">;

  const base = openAICompletionsApi();
  const api: ProviderStreams = {
    stream: (target, context, streamOptions) =>
      base.stream(target, context, { ...streamOptions, fetch: fetch() }),
    streamSimple: (target, context, streamOptions) =>
      base.streamSimple(target, context, { ...streamOptions, fetch: fetch() }),
  };

  const provider = createProvider({
    id: GATEWAY_PROVIDER_ID,
    name: "AI Gateway",
    models: [model],
    // ADR-0002: keyless binding authentication. Provider credential defaults
    // are suppressed so an ambient key can never reach the gateway.
    auth: {
      apiKey: {
        name: "Cloudflare AI Gateway binding",
        resolve: async () => ({
          auth: {
            headers: {
              "cf-aig-authorization": `Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`,
              Authorization: null,
              "x-api-key": null,
            },
          },
        }),
      },
    },
    api: { "openai-completions": api },
  });
  models.setProvider(provider);
}

/** The agent model reference generation resolves through `Models`. */
export function gatewayModelRef(settings?: StoredRouteSettings): { provider: string; modelId: string } {
  return {
    provider: GATEWAY_PROVIDER_ID,
    modelId: (settings ?? defaultRouteSettings()).routeId,
  };
}

function resolveBaseUrl(env: Env, gatewayId: string, selection: ModelRouteSelection): string {
  const fixture = readFixtureModelUrl(env);
  if (fixture !== undefined) {
    const base = fixture.replace(/\/+$/, "");
    return selection.api === "anthropic-messages" ? base : `${base}/v1`;
  }
  return `${BINDING_BASE_URL}/${gatewayId}/compat`;
}

/** Resolve the transport fetch once, on first dispatch. */
function lazyGatewayFetch(env: Env): () => FetchFunction {
  let resolved: FetchFunction | undefined;
  return () => {
    if (resolved) return resolved;
    const fixture = readFixtureModelUrl(env);
    if (fixture !== undefined) {
      resolved = ((input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, init)) as FetchFunction;
      return resolved;
    }
    const binding = env.AI as unknown as AiBinding | undefined;
    if (!binding || typeof binding.fetch !== "function") {
      throw new Error("AI binding is not available in this environment");
    }
    resolved = createAiBindingFetch(binding);
    return resolved;
  };
}

function readFixtureModelUrl(env: Env): string | undefined {
  const value = (env as unknown as Record<string, unknown>).MI_FIXTURE_MODEL_URL;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clampMaxTokens(requested: number | undefined, catalogLimit: number): number {
  if (catalogLimit <= 0) return requested ?? 0;
  if (requested === undefined) return catalogLimit;
  return Math.min(requested, catalogLimit);
}

export {
  BINDING_BASE_URL,
  DEFAULT_ROUTE_ID,
  defaultRouteSettings,
  listRouteViews,
  resolveRouteById,
  type ModelRouteSelection,
} from "./ModelRoutes";
export { parseStoredRouteSettings, type StoredRouteSettings } from "./StoredSettings";
