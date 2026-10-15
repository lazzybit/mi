// Session WebSocket wire protocol (ADR-0003).
//
// One managed conversation is observed through one socket directly to its
// session object. The first server frame is the current pi-durable
// `ConversationView`; later frames are the exact Chord operation batches of
// each commit, applied with `applyImmutable`. Submission, withdrawal,
// cancellation, and history paging travel back as small control frames.

import type { Op } from "@earendil-works/chord/delta";
import type { ConversationView, Cursor, EntryId, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";

export type SessionServerFrame =
  | { type: "view"; value: ConversationView }
  | { type: "ops"; ops: readonly Op[] }
  | { type: "submitted"; requestId: string; submissionId: SubmissionId }
  | { type: "result"; requestId: string; value?: unknown }
  | { type: "history"; requestId: string; entries: EntryRecord[]; next?: Cursor }
  | { type: "notice"; code: string; message: string }
  | { type: "error"; requestId?: string; code: string; message: string };

export type SessionClientFrame =
  | { type: "submit"; requestId: string; text: string; whenBusy?: "followUp" | "steer" }
  | { type: "withdraw"; requestId: string; submissionId: SubmissionId }
  | { type: "abort"; requestId: string }
  | { type: "history"; requestId: string; before?: EntryId; cursor?: Cursor; limit?: number };

export function encodeSessionFrame(frame: SessionServerFrame | SessionClientFrame): string {
  return JSON.stringify(frame);
}

export function decodeSessionServerFrame(raw: string): SessionServerFrame | undefined {
  try {
    const value = JSON.parse(raw) as SessionServerFrame;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function decodeSessionClientFrame(raw: string): SessionClientFrame | undefined {
  try {
    const value = JSON.parse(raw) as SessionClientFrame;
    if (!value || typeof value !== "object" || typeof value.type !== "string") return undefined;
    if (
      value.type !== "submit" &&
      value.type !== "withdraw" &&
      value.type !== "abort" &&
      value.type !== "history"
    ) {
      return undefined;
    }
    if (typeof (value as { requestId?: unknown }).requestId !== "string") return undefined;
    if (!(value as { requestId: string }).requestId) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export type { ConversationView, Cursor, EntryId, EntryRecord, Op, SubmissionId };
