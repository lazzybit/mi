// Settings service (PLAN.md -> Model boundary).

import { AppError, type ModelProfileView } from "../../shared/domain";
import type { SaveModelProfileInput } from "../../shared/commands";
import type { StoreTransaction } from "../storage/SqlStore";
import type { ServiceDeps, ServiceOutcome } from "../conversations/services";

const PROTOCOLS = new Set(["openai-responses", "openai-chat-completions", "anthropic-messages"]);

export class SettingsService {
  constructor(private readonly deps: ServiceDeps) {}

  saveModelProfile(
    tx: StoreTransaction,
    input: SaveModelProfileInput,
  ): ServiceOutcome<ModelProfileView> {
    const profile = input.profile;
    if (!profile.gatewayId || !profile.provider || !profile.model) {
      throw new AppError("INVALID_INPUT", "model profile requires gatewayId, provider, and model");
    }
    if (!PROTOCOLS.has(profile.protocol)) {
      throw new AppError("NOT_CONFIGURED", `unsupported model protocol: ${profile.protocol}`);
    }
    if (profile.contextWindow <= 0 || profile.maxOutputTokens <= 0) {
      throw new AppError("INVALID_INPUT", "contextWindow and maxOutputTokens must be positive");
    }
    tx.settings.writeModelProfile(JSON.stringify(profile));
    return { value: profile, changes: [] };
  }

  setWorkspaceRoot(tx: StoreTransaction, root: string): ServiceOutcome<void> {
    tx.settings.writeWorkspaceRoot(root.trim() || null);
    return { value: undefined, changes: [] };
  }

  constructorGuard(): void {
    void this.deps;
  }
}
