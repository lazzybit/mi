// Pure record -> view projection. Display types stay separate from persistence
// records (PLAN.md -> Shared contracts).

import type {
  AttemptView,
  ConversationView,
  RunView,
  SubmissionView,
  TranscriptEntryView,
} from "../../shared/domain";
import type {
  AttemptRecord,
  ConversationRecord,
  EntryRecord,
  RunRecord,
  SubmissionRecord,
} from "./records";

export function projectConversation(record: ConversationRecord): ConversationView {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function projectEntry(record: EntryRecord, streaming = false): TranscriptEntryView {
  const view: TranscriptEntryView = {
    id: record.id,
    conversationId: record.conversationId,
    sequence: record.sequence,
    kind: record.kind as TranscriptEntryView["kind"],
    createdAt: record.createdAt,
  };
  if (record.attemptId !== undefined) view.attemptId = record.attemptId;
  if (record.text !== undefined) view.text = record.text;
  if (record.artifactId !== undefined) view.artifactId = record.artifactId;
  if (record.toolName !== undefined) view.toolName = record.toolName;
  if (record.toolCallId !== undefined) view.toolCallId = record.toolCallId;
  if (record.isError) view.isError = true;
  if (streaming) view.streaming = true;
  if (record.metadataJson) {
    try {
      view.metadata = JSON.parse(record.metadataJson) as Record<string, unknown>;
    } catch {
      /* ignore malformed metadata */
    }
  }
  return view;
}

export function projectRun(record: RunRecord): RunView {
  const view: RunView = {
    id: record.id,
    conversationId: record.conversationId,
    state: record.state,
    phase: record.phase,
    turnNumber: record.checkpoint.turnNumber,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.cancelRequestedAt !== undefined) view.cancelRequestedAt = record.cancelRequestedAt;
  return view;
}

export function projectAttempt(record: AttemptRecord): AttemptView {
  const view: AttemptView = {
    id: record.id,
    runId: record.runId,
    conversationId: record.conversationId,
    kind: record.kind,
    state: record.state,
    replayPolicy: record.replayPolicy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.toolName !== undefined) view.toolName = record.toolName;
  if (record.remoteName !== undefined) view.remoteName = record.remoteName;
  if (record.errorCode !== undefined) view.errorCode = record.errorCode;
  if (record.errorMessage !== undefined) view.errorMessage = record.errorMessage;
  if (record.resultArtifactId !== undefined) view.resultArtifactId = record.resultArtifactId;
  return view;
}

export function projectSubmission(record: SubmissionRecord): SubmissionView {
  const view: SubmissionView = {
    id: record.id,
    conversationId: record.conversationId,
    mode: record.mode,
    content: record.content,
    state: record.state,
    ownerSequence: record.ownerSequence,
    createdAt: record.createdAt,
  };
  if (record.runId !== undefined) view.runId = record.runId;
  return view;
}
