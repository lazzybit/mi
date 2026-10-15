// Settings service (ADR-0002). Model settings select an application-configured
// route; the server resolves catalog metadata and never trusts client-supplied
// model identities or limits.

import { AppError, type ModelSettingsView } from "../../shared/domain";
import type { SaveModelProfileInput } from "../../shared/commands";
import { defaultRouteSettings, resolveRouteById } from "../models/ModelRoutes";import type { StoredModelSettings } from "../context/ContextAssembler";
import type { StoreTransaction } from "../storage/SqlStore";
import type { ServiceDeps, ServiceOutcome } from "../conversations/services";

export class SettingsService {
  constructor(private readonly deps: ServiceDeps) {}

  saveModelProfile(
    tx: StoreTransaction,
    input: SaveModelProfileInput,
  ): ServiceOutcome<ModelSettingsView> {
    const settings = input.settings;
    if (!settings.gatewayId || !settings.routeId) {
      throw new AppError("INVALID_INPUT", "model settings require gatewayId and routeId");
    }
    if (settings.maxOutputTokens !== undefined && settings.maxOutputTokens <= 0) {
      throw new AppError("INVALID_INPUT", "maxOutputTokens must be positive");
    }
    // ADR-0002: server-side route validation against the repository mapping
    // and the pinned catalog.
    const selection = resolveRouteById(settings.routeId);
    if (
      settings.thinkingLevel !== undefined &&
      !selection.thinkingLevels.includes(settings.thinkingLevel as never)
    ) {
      throw new AppError(
        "INVALID_INPUT",
        `thinking level ${settings.thinkingLevel} is not supported by ${selection.modelName}`,
      );
    }
    const stored: StoredModelSettings = {
      kind: "route",
      gatewayId: settings.gatewayId,
      routeId: settings.routeId,
      thinkingLevel: settings.thinkingLevel,
      maxOutputTokens: settings.maxOutputTokens,
    };
    tx.settings.writeModelProfile(JSON.stringify(stored));
    return { value: settingsView(stored, selection), changes: [] };
  }

  setWorkspaceRoot(tx: StoreTransaction, root: string): ServiceOutcome<void> {
    tx.settings.writeWorkspaceRoot(root.trim() || null);
    return { value: undefined, changes: [] };
  }

  constructorGuard(): void {
    void this.deps;
  }
}

/** Project the stored settings with resolved catalog metadata (ADR-0002). */
export function settingsView(
  stored: StoredModelSettings,
  selection: { routeId: string; modelName: string; contextWindow: number; maxTokens: number; thinkingLevels: string[] },
): ModelSettingsView {
  if ("profile" in stored) {
    throw new AppError("INVALID_INPUT", "legacy model profiles cannot be re-projected as routes");
  }
  return {
    kind: "route",
    gatewayId: stored.gatewayId,
    routeId: selection.routeId,
    label: selection.modelName,
    thinkingLevel: stored.thinkingLevel,
    maxOutputTokens: stored.maxOutputTokens,
    contextWindow: selection.contextWindow,
    maxTokens: selection.maxTokens,
    thinkingLevels: selection.thinkingLevels,
  };
}

/** The default route selection applied when nothing is configured (ADR-0002). */
export { defaultRouteSettings };
