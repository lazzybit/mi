// Context assembly (PLAN.md -> Skills and context). `prepare()` returns either
// a ready snapshot or a compaction request; it never makes an untracked model
// call.

import { AppError, type ArtifactId, type ContextSnapshotId } from "../../shared/domain";
import { hashPayload } from "../../shared/json";
import type { ModelHistoryItem, ModelRequest, ModelToolDefinition } from "../models/types";
import type { ToolDescriptor } from "../mcp/types";
import type { StoreTransaction } from "../storage/SqlStore";
import type { EntryRecord, PersistedToolCall, RunRecord } from "../storage/records";
import type { ModelProfile } from "../types";
import { parseJson } from "../storage/Sql";
import type { Clock, IdGenerator } from "../runtime/Clock";
import { ContextBudget, CompactionPlanner, type CompactionPlan } from "./ContextBudget";

export interface PromptSection {
  id: string;
  text: string;
}

export type ContextPreparation =
  | { kind: "ready"; snapshotId: ContextSnapshotId }
  | { kind: "compaction_required"; requestArtifactId: ArtifactId; plan: CompactionPlan };

export interface ContextAssemblerDeps {
  clock: Clock;
  ids: IdGenerator;
  budget: ContextBudget;
  compaction: CompactionPlanner;
  listTools(tx: StoreTransaction, conversationId: string): ToolDescriptor[];
  baseInstructions?: string;
}

export class ContextAssembler {
  constructor(private readonly deps: ContextAssemblerDeps) {}

  prepare(tx: StoreTransaction, run: RunRecord): ContextPreparation {
    const profile = this.requireProfile(tx);
    const systemSections = this.buildSystemSections(tx, run.conversationId);
    const tools = this.deps.listTools(tx, run.conversationId);
    const lastSequence = tx.conversations.maxEntrySequence(run.conversationId);
    // Summaries coexist with the original entries; the model context starts at
    // the latest summary so compaction is bounded instead of repeating forever.
    const allEntries = tx.entries.listRecent(run.conversationId, 500);
    let startIndex = 0;
    for (let i = allEntries.length - 1; i >= 0; i--) {
      if (allEntries[i]?.kind === "summary") {
        startIndex = i;
        break;
      }
    }
    const entries = allEntries.slice(startIndex);
    const firstSequence = entries[0]?.sequence ?? Math.max(1, lastSequence);
    const history = buildHistory(entries);

    const request: ModelRequest = {
      attemptId: "context-preview",
      profile,
      system: systemSections.map((section) => section.text).join("\n\n"),
      history,
      tools: tools.map((tool) => toModelTool(tool)),
    };
    const assessment = this.deps.budget.assess(profile, request);

    if (assessment.overBudget) {
      const plan = this.deps.compaction.plan(entries);
      if (plan) {
        const artifactId = this.deps.ids.next("artifact");
        tx.artifacts.create({
          id: artifactId,
          mimeType: "application/json",
          encoding: "utf8",
          byteCount: 0,
          complete: false,
          createdAt: this.deps.clock.now(),
        });
        tx.artifacts.appendChunk(artifactId, 0, JSON.stringify(plan), JSON.stringify(plan).length);
        tx.artifacts.complete(artifactId, hashPayload(plan));
        return { kind: "compaction_required", requestArtifactId: artifactId, plan };
      }
    }

    const id = this.deps.ids.next("ctx");
    const skillVersions = this.resolveSelectedSkills(tx, run.conversationId);
    const digest = hashPayload({ systemSections, tools: tools.map((t) => t.alias), history, skillVersions });
    tx.contextSnapshots.insert({
      id,
      conversationId: run.conversationId,
      runId: run.id,
      turnNumber: run.checkpoint.turnNumber,
      modelProfileJson: JSON.stringify(profile),
      skillVersionsJson: JSON.stringify(skillVersions),
      toolCatalogJson: JSON.stringify(tools),
      systemSectionsJson: JSON.stringify(systemSections),
      historyFirst: firstSequence,
      historyLast: lastSequence,
      summaryEntryId: run.checkpoint.assistantEntryId,
      digest,
      createdAt: this.deps.clock.now(),
    });
    return { kind: "ready", snapshotId: id };
  }

  materialize(tx: StoreTransaction, snapshotId: ContextSnapshotId): ModelRequest {
    const snapshot = tx.contextSnapshots.get(snapshotId);
    if (!snapshot) throw new AppError("NOT_FOUND", "context snapshot not found");
    const profile = parseJson<ModelProfile | undefined>(snapshot.modelProfileJson, undefined);
    if (!profile) throw new AppError("NOT_CONFIGURED", "context snapshot has no model profile");
    const sections = parseJson<PromptSection[]>(snapshot.systemSectionsJson, []);
    const tools = parseJson<ToolDescriptor[]>(snapshot.toolCatalogJson, []);
    const entries = tx.entries.listRange(
      snapshot.conversationId,
      snapshot.historyFirst,
      snapshot.historyLast,
    );
    return {
      attemptId: snapshot.runId,
      profile,
      system: sections.map((section) => section.text).join("\n\n"),
      history: buildHistory(entries),
      tools: tools.map((tool) => toModelTool(tool)),
    };
  }

  requireProfile(tx: StoreTransaction): ModelProfile {
    const settings = tx.settings.read();
    const profile = parseJson<ModelProfile | undefined>(settings.modelProfileJson, undefined);
    if (!profile) {
      throw new AppError("NOT_CONFIGURED", "no model profile configured", false);
    }
    return profile;
  }

  private buildSystemSections(tx: StoreTransaction, conversationId: string): PromptSection[] {
    const sections: PromptSection[] = [
      {
        id: "base",
        text:
          this.deps.baseInstructions ??
          "You are the owner's coding and research assistant. Use the provided tools when they help. Prefer reading before writing. Never claim an uncertain remote outcome succeeded.",
      },
    ];
    const settings = tx.settings.read();
    if (settings.workspaceRoot) {
      sections.push({ id: "workspace", text: `Workspace root: ${settings.workspaceRoot}` });
      // Repository instructions are read only from committed records; no remote
      // I/O happens during prompt rendering.
      const instructions = tx.repositoryInstructions.list(settings.workspaceRoot).filter((record) => record.present);
      if (instructions.length > 0) {
        const text = instructions
          .map((record) => {
            const content = tx.artifacts
              .readChunks(record.artifactId)
              .map((chunk) => chunk.data)
              .join("");
            return `# ${record.path}\n${content}`;
          })
          .join("\n\n");
        sections.push({ id: "repository", text: `Repository instructions:\n${text}` });
      }
    }
    const selected = this.resolveSelectedSkills(tx, conversationId);
    if (selected.length > 0) {
      const catalog = selected
        .map((entry) => {
          const version = tx.skills.getVersion(entry.skillId, entry.version);
          return version ? `- ${version.name}: ${version.description}` : undefined;
        })
        .filter((line): line is string => line !== undefined)
        .join("\n");
      if (catalog) {
        sections.push({
          id: "skills",
          text: `Available skills (read with read_skill):\n${catalog}`,
        });
      }
    }
    return sections;
  }

  private resolveSelectedSkills(
    tx: StoreTransaction,
    conversationId: string,
  ): { skillId: string; version: number }[] {
    const selection = tx.skills.selectedForConversation(conversationId);
    const resolved: { skillId: string; version: number }[] = [];
    for (const entry of selection) {
      const skill = tx.skills.get(entry.skillId);
      if (!skill || skill.deleted || !skill.enabled) continue;
      resolved.push({ skillId: skill.id, version: skill.currentVersion });
    }
    return resolved;
  }
}

export function buildHistory(entries: EntryRecord[]): ModelHistoryItem[] {
  const history: ModelHistoryItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      history.push({ role: "user", text: entry.text ?? "" });
    } else if (entry.kind === "assistant") {
      const metadata = parseJson<{
        toolCalls?: PersistedToolCall[];
        native?: unknown;
      }>(entry.metadataJson, {});
      const item: ModelHistoryItem = { role: "assistant", text: entry.text ?? "" };
      if (metadata.toolCalls) {
        item.toolCalls = metadata.toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          name: call.alias,
          arguments: call.arguments,
        }));
      }
      if (metadata.native !== undefined) item.native = metadata.native;
      history.push(item);
    } else if (entry.kind === "tool_result") {
      history.push({
        role: "tool",
        toolCallId: entry.toolCallId ?? "",
        name: entry.toolName ?? "tool",
        text: entry.text ?? "",
        isError: entry.isError,
      });
    } else if (entry.kind === "summary") {
      history.push({ role: "summary", text: entry.text ?? "" });
    }
    // tool_call display entries are folded into the assistant item's toolCalls.
  }
  return history;
}

export function toModelTool(descriptor: ToolDescriptor): ModelToolDefinition {
  return {
    name: descriptor.alias,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  };
}
