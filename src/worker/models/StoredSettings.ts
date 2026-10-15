// Stored model settings (ADR-0002, ADR-0003).
//
// Route settings are the only supported shape: the deployment owns the
// gateway, and the server resolves catalog metadata. Every reader normalizes
// through `parseStoredRouteSettings` so an unknown or historical shape is
// never treated as a valid route.

import { AI_GATEWAY_ID } from "./ModelRoutes";

export interface StoredRouteSettings {
  kind: "route";
  gatewayId: string;
  routeId: string;
  thinkingLevel?: string;
  maxOutputTokens?: number;
}

/**
 * The gateway is deployment-owned. Historical records may carry the old
 * `"default"` placeholder (or nothing); resolve those to the configured
 * gateway so the binding request targets the right gateway.
 */
function normalizeGatewayId(gatewayId: unknown): string {
  return typeof gatewayId === "string" && gatewayId.length > 0 && gatewayId !== "default"
    ? gatewayId
    : AI_GATEWAY_ID;
}

/** Parse stored route settings; an unknown shape is `undefined`. */
export function parseStoredRouteSettings(json: string | undefined | null): StoredRouteSettings | undefined {
  if (!json) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.kind !== "route" || typeof record.routeId !== "string") return undefined;
  return {
    kind: "route",
    gatewayId: normalizeGatewayId(record.gatewayId),
    routeId: record.routeId,
    thinkingLevel: typeof record.thinkingLevel === "string" ? record.thinkingLevel : undefined,
    maxOutputTokens:
      typeof record.maxOutputTokens === "number" && record.maxOutputTokens > 0
        ? record.maxOutputTokens
        : undefined,
  };
}
