// WebSocket wire protocol (PLAN.md -> Shared contracts -> ServerFrame / ClientFrame).

import type {
  AttemptView,
  ConfigurationStatusView,
  ConversationId,
  ConversationSummaryView,
  OwnerSnapshot,
  RunView,
  SubmissionView,
  TranscriptEntryView,
} from "./domain";

export type ViewChange =
  | { kind: "conversation.upsert"; value: ConversationSummaryView }
  | { kind: "conversation.remove"; conversationId: ConversationId }
  | { kind: "entry.append"; conversationId: ConversationId; value: TranscriptEntryView }
  | { kind: "entry.update"; conversationId: ConversationId; value: TranscriptEntryView }
  | { kind: "attempt.update"; conversationId: ConversationId; value: AttemptView }
  | { kind: "run.update"; conversationId: ConversationId; value: RunView }
  | { kind: "inbox.replace"; conversationId: ConversationId; values: SubmissionView[] }
  | { kind: "configuration.update"; value: ConfigurationStatusView };

export type ServerFrame =
  | { type: "snapshot"; streamId: string; sequence: 0; value: OwnerSnapshot }
  | {
      type: "changes";
      streamId: string;
      sequence: number;
      revision: number;
      changes: ViewChange[];
    };

export type ClientFrame =
  | { type: "subscribe"; conversationId?: ConversationId }
  | { type: "resnapshot" };

export function encodeFrame(frame: ServerFrame | ClientFrame): string {
  return JSON.stringify(frame);
}

export function decodeServerFrame(raw: string): ServerFrame | undefined {
  try {
    const value = JSON.parse(raw) as ServerFrame;
    if (value && (value.type === "snapshot" || value.type === "changes")) return value;
    return undefined;
  } catch {
    return undefined;
  }
}

export function decodeClientFrame(raw: string): ClientFrame | undefined {
  try {
    const value = JSON.parse(raw) as ClientFrame;
    if (value && (value.type === "subscribe" || value.type === "resnapshot")) return value;
    return undefined;
  } catch {
    return undefined;
  }
}
