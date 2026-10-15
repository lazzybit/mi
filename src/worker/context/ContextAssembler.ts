// Context assembly (ADR-0002). `prepare()` returns either a ready snapshot, a
// compaction request, or an explicit over-budget refusal; it never makes an
// untracked model call.

import type { Context, Message, ModelThinkingLevel, Tool } from "@earendil-works/pi-ai";
import { AppError, type ContextSnapshotId } from "../../shared/domain";
import { hashPayload } from "../../shared/json";
import type { ToolDescriptor } from "../mcp/types";
import type {
  CanonicalModelRequest,
  FrozenModelProfile,
  LegacyHistoryItem,
  PersistedModelToolCall,
} from "../models/types";
import type { StoreTransaction } from "../storage/SqlStore";
import type { EntryRecord, RunRecord } from "../storage/records";
import { parseJson } from "../storage/Sql";
import type { ModelProfile } from "../types";
import type { Clock, IdGenerator } from "../runtime/Clock";
import { resolveRouteById, defaultRouteSettings, type RouteSettingsShape } from "../models/ModelRoutes";
import { ContextBudget, CompactionPlanner, type CompactionPlan } from "./ContextBudget";

export interface PromptSection {
  id: string;
  text: string;
}

export type ContextPreparation =
  | { kind: "ready"; snapshotId: ContextSnapshotId }
  | { kind: "compaction_required"; plan: CompactionPlan }
  | { kind: "over_budget" };

export interface ContextAssemblerDeps {
  clock: Clock;
  ids: IdGenerator;
  budget: ContextBudget;
  compaction: CompactionPlanner;
  listTools(tx: StoreTransaction, conversationId: string): ToolDescriptor[];
  baseInstructions?: string;
}

/**
 * The stored settings profile: either an ADR-0002 route selection or a
 * historical concrete model profile.
 */
export type StoredModelSettings = RouteSettingsShape | { profile: ModelProfile };

export class ContextAssembler {
  constructor(private readonly deps: ContextAssemblerDeps) {}

  prepare(tx: StoreTransaction, run: RunRecord): ContextPreparation {
    const profile = this.requireFrozenProfile(tx);
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
    const messages = buildMessages(entries);

    const assessment = this.deps.budget.assess(
      { systemPrompt: sectionsText(systemSections), messages, tools: tools.map(toModelTool) },
      profile,
    );

    if (assessment.overBudget) {
      const plan = this.deps.compaction.plan(entries);
      if (plan) {
        // ADR-0001: no compaction-plan artifact is persisted; the driver does
        // not consume its effect id and the actual compaction request is
        // recorded through its attempt.
        return { kind: "compaction_required", plan };
      }
      // ADR-0002: an over-budget request without a safe compaction path must
      // not dispatch; it becomes an explicit terminal failure.
      return { kind: "over_budget" };
    }

    const id = this.deps.ids.next("ctx");
    const skillVersions = this.resolveSelectedSkills(tx, run.conversationId);
    const digest = hashPayload({
      systemSections,
      tools: tools.map((tool) => tool.alias),
      messages,
      skillVersions,
    });
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

  materialize(
    tx: StoreTransaction,
    snapshotId: ContextSnapshotId,
    attemptId: CanonicalModelRequest["attemptId"],
  ): CanonicalModelRequest {
    const snapshot = tx.contextSnapshots.get(snapshotId);
    if (!snapshot) throw new AppError("NOT_FOUND", "context snapshot not found");
    const frozen = parseJson<FrozenModelProfile | undefined>(snapshot.modelProfileJson, undefined);
    if (!frozen) throw new AppError("NOT_CONFIGURED", "context snapshot has no model profile");
    const sections = parseJson<PromptSection[]>(snapshot.systemSectionsJson, []);
    const tools = parseJson<ToolDescriptor[]>(snapshot.toolCatalogJson, []);
    const entries = tx.entries.listRange(
      snapshot.conversationId,
      snapshot.historyFirst,
      snapshot.historyLast,
    );
    return {
      version: 2,
      attemptId,
      profile: frozen,
      context: {
        systemPrompt: sectionsText(sections),
        messages: buildMessages(entries),
        tools: tools.map(toModelTool),
      },
    };
  }

  /** The frozen profile recorded in a context snapshot (ADR-0002). */
  snapshotProfile(tx: StoreTransaction, snapshotId: ContextSnapshotId): FrozenModelProfile {
    const snapshot = tx.contextSnapshots.get(snapshotId);
    if (!snapshot) throw new AppError("NOT_FOUND", "context snapshot not found");
    const frozen = parseJson<FrozenModelProfile | undefined>(snapshot.modelProfileJson, undefined);
    if (!frozen) throw new AppError("NOT_CONFIGURED", "context snapshot has no model profile");
    return frozen;
  }

  requireFrozenProfile(tx: StoreTransaction): FrozenModelProfile {
    const settings = tx.settings.read();
    const stored = parseStoredSettings(settings.modelProfileJson);
    // ADR-0002: with the initial route selected by default, an unconfigured
    // owner still runs against the repository-configured default route.
    return this.freezeProfile(stored ?? defaultRouteSettings());
  }

  freezeProfile(stored: StoredModelSettings): FrozenModelProfile {
    if ("profile" in stored) {
      return { kind: "legacy", profile: stored.profile };
    }
    const selection = resolveRouteById(stored.routeId);
    return {
      kind: "route",
      gatewayId: stored.gatewayId,
      routeId: selection.routeId,
      provider: selection.provider,
      modelId: selection.modelId,
      api: selection.api,
      model: selection.model,
      thinkingLevel: validThinking(stored.thinkingLevel, selection),
      maxTokens: outputCap(stored.maxOutputTokens, selection.maxTokens),
    };
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

/**
 * Read stored settings in every historical shape (ADR-0002): route settings,
 * a wrapped legacy profile, or the bare legacy profile JSON.
 */
export function parseStoredSettings(json: string | undefined): StoredModelSettings | undefined {
  const raw = parseJson<Record<string, unknown> | undefined>(json, undefined);
  if (!raw || typeof raw !== "object") return undefined;
  if (raw.kind === "route" && typeof raw.routeId === "string") {
    return raw as unknown as StoredModelSettings;
  }
  if ("profile" in raw && typeof raw.profile === "object" && raw.profile !== null) {
    return { profile: raw.profile as unknown as ModelProfile };
  }
  if (typeof raw.protocol === "string" && typeof raw.model === "string") {
    return { profile: raw as unknown as ModelProfile };
  }
  return undefined;
}

function sectionsText(sections: PromptSection[]): string {
  return sections.map((section) => section.text).join("\n\n");
}

function validThinking(
  level: string | undefined,
  selection: { thinkingLevels: string[] },
): ModelThinkingLevel | undefined {
  return level && selection.thinkingLevels.includes(level)
    ? (level as ModelThinkingLevel)
    : undefined;
}

function outputCap(configured: number | undefined, catalogMax: number): number {
  const fallback = catalogMax > 0 ? Math.min(4096, catalogMax) : 4096;
  const requested = configured && configured > 0 ? configured : fallback;
  return catalogMax > 0 ? Math.min(requested, catalogMax) : requested;
}

/**
 * ADR-0002: project persisted entries into canonical pi-ai messages. Both the
 * canonical `modelMessage` metadata and the legacy representations are read;
 * legacy thinking signatures cannot be reconstructed and are not invented.
 */
export function buildMessages(entries: EntryRecord[]): Message[] {
  const messages: Message[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      messages.push({ role: "user", content: entry.text ?? "", timestamp: entry.createdAt });
    } else if (entry.kind === "assistant") {
      messages.push(assistantMessage(entry));
    } else if (entry.kind === "tool_result") {
      const text = entry.isError ? `Error: ${entry.text ?? ""}` : (entry.text ?? "");
      messages.push({
        role: "toolResult",
        toolCallId: entry.toolCallId ?? "",
        toolName: entry.toolName ?? "tool",
        content: [{ type: "text", text }],
        isError: entry.isError,
        timestamp: entry.createdAt,
      });
    } else if (entry.kind === "summary") {
      messages.push({
        role: "system",
        content: `Conversation summary:\n${entry.text ?? ""}`,
        timestamp: entry.createdAt,
      });
    }
    // tool_call display entries are folded into the assistant message's
    // toolCall content blocks.
  }
  return messages;
}

interface StoredModelMessage {
  version: number;
  message: Message;
}

export function assistantMessage(entry: EntryRecord): Message {
  const metadata = parseJson<Record<string, unknown>>(entry.metadataJson, {});
  const stored = metadata.modelMessage;
  if (
    typeof stored === "object" &&
    stored !== null &&
    (stored as StoredModelMessage).version === 1 &&
    typeof (stored as StoredModelMessage).message === "object"
  ) {
    return (stored as StoredModelMessage).message;
  }
  return legacyAssistantMessage(entry, metadata);
}

function legacyAssistantMessage(entry: EntryRecord, metadata: Record<string, unknown>): Message {
  const content: (Extract<Message, { role: "assistant" }>["content"][number])[] = [];
  if (entry.text) content.push({ type: "text", text: entry.text });
  const rawCalls = metadata.toolCalls;
  if (Array.isArray(rawCalls)) {
    for (const call of rawCalls as PersistedModelToolCall[]) {
      if (typeof call !== "object" || call === null) continue;
      const name = typeof call.name === "string" ? call.name : (call as { alias?: unknown }).alias;
      if (typeof name !== "string") continue;
      content.push({
        type: "toolCall",
        id: typeof call.toolCallId === "string" ? call.toolCallId : "",
        name,
        arguments:
          typeof call.arguments === "object" && call.arguments !== null
            ? (call.arguments as Record<string, never>)
            : {},
      });
    }
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "legacy",
    model: "legacy",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: entry.createdAt,
  };
}

/** Canonical tool declaration for the model context (ADR-0002). */
export function toModelTool(descriptor: ToolDescriptor): Tool {
  return {
    name: descriptor.alias,
    description: descriptor.description,
    parameters: descriptor.inputSchema as Tool["parameters"],
  };
}

/**
 * Legacy history projection kept for reading pre-ADR-0002 request artifacts.
 * New requests always carry canonical messages.
 */
export function buildHistory(entries: EntryRecord[]): LegacyHistoryItem[] {
  const history: LegacyHistoryItem[] = [];
  for (const entry of entries) {
    if (entry.kind === "user") {
      history.push({ role: "user", text: entry.text ?? "" });
    } else if (entry.kind === "assistant") {
      const metadata = parseJson<Record<string, unknown>>(entry.metadataJson, {});
      const item: LegacyHistoryItem = { role: "assistant", text: entry.text ?? "" };
      const rawCalls = metadata.toolCalls;
      if (Array.isArray(rawCalls)) {
        item.toolCalls = (rawCalls as Record<string, unknown>[]).map((call) => ({
          toolCallId: String(call.toolCallId ?? ""),
          name: String(call.name ?? call.alias ?? ""),
          arguments: call.arguments,
        }));
      }
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
  }
  return history;
}

/** Compose the canonical context for a compaction request over a fixed range. */
export function compactionRequest(
  attemptId: string,
  frozen: FrozenModelProfile,
  entries: EntryRecord[],
): CanonicalModelRequest {
  return {
    version: 2,
    attemptId,
    profile: frozen,
    context: {
      systemPrompt:
        "Summarize the conversation so far. Preserve the objective, corrections, accepted decisions, files and commits, completed verification, outstanding work, and any unresolved remote-operation outcomes. Do not claim uncertain outcomes succeeded.",
      messages: buildMessages(entries),
      tools: [],
    },
  };
}

export type { Context };
