// Skill registry (PLAN.md -> Skills and context). Editing a skill creates a
// new immutable version; deleting hides it from future selection while
// preserving versions referenced by past turns.

import { AppError, type SkillId, type SkillView } from "../../shared/domain";
import type { CreateSkillInput, SkillResourceInput, UpdateSkillInput } from "../../shared/commands";
import { hashPayload, normalizeResourcePath } from "../../shared/json";
import type { StoreTransaction } from "../storage/SqlStore";
import type { SkillVersionRecord } from "../storage/records";
import type { ServiceDeps, ServiceOutcome } from "../conversations/services";

export class SkillRegistry {
  constructor(private readonly deps: ServiceDeps) {}

  create(tx: StoreTransaction, input: CreateSkillInput): ServiceOutcome<SkillView> {
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_INPUT", "skill name must not be empty");
    const now = this.deps.now();
    const id = this.deps.newId();
    tx.skills.upsertSkill({
      id,
      name,
      description: input.description,
      enabled: true,
      deleted: false,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    tx.skills.insertVersion({
      skillId: id,
      version: 1,
      name,
      description: input.description,
      instructions: input.instructions,
      createdAt: now,
    });
    this.writeResources(tx, id, 1, input.resources ?? []);
    return { value: this.view(tx, id), changes: [] };
  }

  update(tx: StoreTransaction, input: UpdateSkillInput): ServiceOutcome<SkillView> {
    const skill = tx.skills.get(input.skillId);
    if (!skill || skill.deleted) throw new AppError("NOT_FOUND", "skill not found");
    const name = input.name.trim();
    if (!name) throw new AppError("INVALID_INPUT", "skill name must not be empty");
    const now = this.deps.now();
    const version = skill.currentVersion + 1;
    tx.skills.insertVersion({
      skillId: skill.id,
      version,
      name,
      description: input.description,
      instructions: input.instructions,
      createdAt: now,
    });
    this.writeResources(tx, skill.id, version, input.resources ?? []);
    tx.skills.upsertSkill({
      ...skill,
      name,
      description: input.description,
      currentVersion: version,
      updatedAt: now,
    });
    return { value: this.view(tx, skill.id), changes: [] };
  }

  disable(tx: StoreTransaction, skillId: SkillId): ServiceOutcome<void> {
    const skill = tx.skills.get(skillId);
    if (!skill) throw new AppError("NOT_FOUND", "skill not found");
    tx.skills.upsertSkill({ ...skill, enabled: false, updatedAt: this.deps.now() });
    return { value: undefined, changes: [] };
  }

  remove(tx: StoreTransaction, skillId: SkillId): ServiceOutcome<void> {
    const skill = tx.skills.get(skillId);
    if (!skill) throw new AppError("NOT_FOUND", "skill not found");
    tx.skills.upsertSkill({ ...skill, enabled: false, deleted: true, updatedAt: this.deps.now() });
    return { value: undefined, changes: [] };
  }

  resolveForTurn(tx: StoreTransaction, conversationId: string): SkillVersionRecord[] {
    const resolved: SkillVersionRecord[] = [];
    for (const selection of tx.skills.selectedForConversation(conversationId)) {
      const skill = tx.skills.get(selection.skillId);
      if (!skill || skill.deleted || !skill.enabled) continue;
      const version = tx.skills.getVersion(skill.id, skill.currentVersion);
      if (version) resolved.push(version);
    }
    return resolved;
  }

  list(tx: StoreTransaction): SkillView[] {
    return tx.skills.list().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      deleted: skill.deleted,
      currentVersion: skill.currentVersion,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    }));
  }

  private view(tx: StoreTransaction, skillId: SkillId): SkillView {
    const skill = tx.skills.get(skillId);
    if (!skill) throw new AppError("NOT_FOUND", "skill not found");
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      deleted: skill.deleted,
      currentVersion: skill.currentVersion,
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };
  }

  private writeResources(
    tx: StoreTransaction,
    skillId: SkillId,
    version: number,
    resources: SkillResourceInput[],
  ): void {
    const seen = new Set<string>();
    for (const resource of resources) {
      const path = normalizeResourcePath(resource.path);
      if (seen.has(path)) throw new AppError("INVALID_INPUT", `duplicate resource path: ${path}`);
      seen.add(path);
      const artifactId = this.deps.newId();
      tx.artifacts.create({
        id: artifactId,
        mimeType: resource.mediaType,
        encoding: resource.encoding,
        byteCount: 0,
        complete: false,
        createdAt: this.deps.now(),
      });
      tx.artifacts.appendChunk(artifactId, 0, resource.content, resource.content.length);
      tx.artifacts.complete(artifactId, hashPayload(resource.content));
      tx.skills.insertResource({
        skillId,
        version,
        path,
        mediaType: resource.mediaType,
        artifactId,
      });
    }
  }
}
