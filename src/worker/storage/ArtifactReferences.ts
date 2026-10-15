// ADR-0001: bounded artifact reference inventory for conversation deletion.
//
// Only ownership-linked request/result payloads and established entry
// attachments become deletion candidates. Surviving records protect a
// candidate. Resolution evidence and application-tool inputs are references,
// not ownership proof. Explicit readers cover the known persisted
// representations; arbitrary external ids are never interpreted as local
// references.

import { parseJson } from "./Sql";
import type { StoreTransaction } from "./SqlStore";
import type { EntryRecord } from "./records";

const READ_TOOL_RESULT = "app__read_tool_result";

/**
 * Collect artifacts owned by the conversation through an established
 * relationship: attempt request/result links and entry attachment links.
 */
export function collectArtifactCandidates(
  tx: StoreTransaction,
  conversationId: string,
): Set<string> {
  const candidates = new Set<string>();
  for (const attempt of tx.attempts.listForConversation(conversationId)) {
    if (attempt.requestArtifactId) candidates.add(attempt.requestArtifactId);
    if (attempt.resultArtifactId) candidates.add(attempt.resultArtifactId);
  }
  for (const entry of tx.entries.listForConversation(conversationId)) {
    if (entry.artifactId) candidates.add(entry.artifactId);
  }
  return candidates;
}

/**
 * Collect artifacts referenced by records that survive the deletion. A
 * candidate in this set must not be removed.
 */
export function collectSurvivingReferences(
  tx: StoreTransaction,
  conversationId: string,
): Set<string> {
  const references = new Set<string>();
  const survivingAttemptIds = new Set<string>();

  for (const attempt of tx.attempts.listAll()) {
    if (attempt.conversationId === conversationId) continue;
    survivingAttemptIds.add(attempt.id);
    if (attempt.requestArtifactId) references.add(attempt.requestArtifactId);
    if (attempt.resultArtifactId) references.add(attempt.resultArtifactId);
    // Persisted tool arguments retained for an unresolved remote outcome.
    if (attempt.toolName === READ_TOOL_RESULT || attempt.remoteName === READ_TOOL_RESULT) {
      const uncertainty = parseJson<{ arguments?: unknown }>(attempt.uncertaintyJson, {});
      addReadToolResultArgument(uncertainty.arguments, references);
    }
  }

  for (const entry of tx.entries.listAll()) {
    if (entry.conversationId === conversationId) continue;
    if (entry.artifactId) references.add(entry.artifactId);
    collectEntryMetadataReferences(entry, references);
  }

  for (const resolution of tx.attemptResolutions.listAll()) {
    if (!survivingAttemptIds.has(resolution.attemptId)) continue;
    const evidence = parseJson<unknown>(resolution.evidenceJson, []);
    if (Array.isArray(evidence)) {
      for (const id of evidence) if (typeof id === "string") references.add(id);
    }
  }

  for (const run of tx.runs.listAll()) {
    if (run.conversationId === conversationId) continue;
    for (const tool of run.checkpoint.pendingToolCalls) {
      if (tool.alias === READ_TOOL_RESULT) addReadToolResultArgument(tool.arguments, references);
    }
  }

  for (const resource of tx.skills.listAllResources()) references.add(resource.artifactId);
  for (const instruction of tx.repositoryInstructions.listAll()) {
    references.add(instruction.artifactId);
  }

  return references;
}

/**
 * Entry metadata carries tool-call display arguments, the legacy assistant
 * tool-call history, and (ADR-0002) the canonical pi-ai assistant message.
 * All established representations are supported.
 */
function collectEntryMetadataReferences(entry: EntryRecord, out: Set<string>): void {
  if (!entry.metadataJson) return;
  const metadata = parseJson<Record<string, unknown>>(entry.metadataJson, {});
  if (entry.kind === "tool_call" && entry.toolName === READ_TOOL_RESULT) {
    addReadToolResultArgument(metadata.arguments, out);
  }
  const toolCalls = metadata.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      if (call.name === READ_TOOL_RESULT || call.alias === READ_TOOL_RESULT) {
        addReadToolResultArgument(call.arguments, out);
      }
    }
  }
  // ADR-0002: canonical assistant content (pi-ai ToolCall blocks).
  const stored = metadata.modelMessage;
  if (isRecord(stored) && isRecord(stored.message)) {
    const content = stored.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall") continue;
        if (block.name === READ_TOOL_RESULT) {
          addReadToolResultArgument(block.arguments, out);
        }
      }
    }
  }
}

function addReadToolResultArgument(value: unknown, out: Set<string>): void {
  if (!isRecord(value)) return;
  const artifactId = value.artifactId;
  if (typeof artifactId === "string" && artifactId.length > 0) out.add(artifactId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
