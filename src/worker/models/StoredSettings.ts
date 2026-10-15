// Stored model settings (ADR-0002). Historical owners persisted a bare
// `ModelProfile` JSON; route settings are discriminated by `kind: "route"`.
// Every reader normalizes through `parseStoredSettings` so the two shapes are
// never confused (a bare legacy profile has no `routeId` and must never be
// resolved as a route).

import { parseJson } from "../storage/Sql";
import type { ModelProfile } from "../types";
import { AI_GATEWAY_ID, type RouteSettingsShape } from "./ModelRoutes";

export type StoredModelSettings = RouteSettingsShape | { profile: ModelProfile };

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

/**
 * Read stored settings in every historical shape: route settings, a wrapped
 * legacy profile, or the bare legacy profile JSON.
 */
export function parseStoredSettings(json: string | undefined): StoredModelSettings | undefined {
  const raw = parseJson<Record<string, unknown> | undefined>(json, undefined);
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.kind === "route" && typeof raw.routeId === "string") {
    const settings = raw as unknown as RouteSettingsShape;
    return { ...settings, gatewayId: normalizeGatewayId(settings.gatewayId) };
  }
  if ("profile" in raw && typeof raw.profile === "object" && raw.profile !== null) {
    const profile = raw.profile as unknown as ModelProfile;
    return { profile: { ...profile, gatewayId: normalizeGatewayId(profile.gatewayId) } };
  }
  if (typeof raw.protocol === "string" && typeof raw.model === "string") {
    const profile = raw as unknown as ModelProfile;
    return { profile: { ...profile, gatewayId: normalizeGatewayId(profile.gatewayId) } };
  }
  return undefined;
}
