// Presentation mapping for a pi-durable `ConversationView` (ADR-0003).
//
// The client renders committed transcript entries plus the committed live
// partial. It never derives execution state of its own: everything shown comes
// from the session's committed view.
//
// ADR-0005: mi prioritizes user-relevant information. This module is the pure
// projection layer: it preserves assistant content structure, emits ordered
// text, thinking, and tool rows, pairs tool results with their calls, and never
// mutates the committed conversation data.

import type { AssistantMessage, JsonObject, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryId, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import type { InboxState, LiveState } from "@earendil-works/pi-durable";

export interface UserRow {
  kind: "user";
  key: string;
  entryId: EntryId;
  text: string;
}

export interface SummaryRow {
  kind: "summary";
  key: string;
  entryId: EntryId;
  text: string;
}

export interface AssistantTextRow {
  kind: "assistant";
  key: string;
  entryId?: EntryId;
  text: string;
  streaming?: boolean;
  isError?: boolean;
}

export interface ThinkingRow {
  kind: "thinking";
  key: string;
  entryId?: EntryId;
  text: string;
  streaming?: boolean;
}

export interface ToolResultDetails {
  text: string;
  isError: boolean;
  durationMs?: number;
}

export interface ToolRow {
  kind: "tool";
  key: string;
  entryId?: EntryId;
  callId?: string;
  toolName: string;
  arguments?: JsonObject;
  /** False while a live call is still streaming its arguments. */
  argumentsComplete: boolean;
  result?: ToolResultDetails;
  /** Result entry that supplied `result`, so presentation state can follow a merge. */
  resultEntryId?: EntryId;
  /** A historical result whose call record is not loaded yet. */
  standalone?: boolean;
  streaming?: boolean;
}

export type DisplayRow = UserRow | SummaryRow | AssistantTextRow | ThinkingRow | ToolRow;

export interface QueuedInput {
  id: SubmissionId;
  mode: "steer" | "followUp";
  text: string;
}

export interface LiveSummary {
  active: boolean;
  attempt?: number;
  retryError?: string;
}

export function liveState(view: ConversationView | undefined): LiveState | undefined {
  return view?.docs["pi.live"] as unknown as LiveState | undefined;
}

export function inboxState(view: ConversationView | undefined): InboxState | undefined {
  return view?.docs["pi.inbox"] as unknown as InboxState | undefined;
}

export function queuedInputs(view: ConversationView | undefined): QueuedInput[] {
  const items = inboxState(view)?.items ?? [];
  const queued: QueuedInput[] = [];
  for (const item of items) {
    if (item.mode === "write") continue;
    queued.push({
      id: item.id,
      mode: item.mode,
      text: userContentText(item.content as unknown as UserMessage["content"]),
    });
  }
  return queued;
}

export function liveSummary(view: ConversationView | undefined): LiveSummary {
  const live = liveState(view);
  if (!live?.run) return { active: false };
  return {
    active: true,
    attempt: live.generation?.attempt,
    retryError: live.generation?.retry?.error,
  };
}

/** The committed partial of the in-flight response, if any. */
export function livePartialMessage(view: ConversationView | undefined): AssistantMessage | undefined {
  const message = liveState(view)?.generation?.message as unknown as AssistantMessage | undefined;
  return message;
}

/** Stable identity for one observed live generation. */
export function liveIdentity(message: AssistantMessage): string {
  return `live:${message.timestamp}`;
}

/** Key prefix for the rows of one live generation. */
export function liveKeyPrefix(message: AssistantMessage): string {
  return `${liveIdentity(message)}:`;
}

/** Project the live partial with the same content rules as committed entries. */
export function projectLiveRows(message: AssistantMessage): DisplayRow[] {
  return projectAssistant(message, liveKeyPrefix(message), undefined, true).rows;
}

/**
 * Project committed entries into ordered display rows.
 *
 * Tool rows are established from assistant tool calls and results are attached
 * by call identifier within the same assistant round, so call order is
 * preserved even when results arrive out of order. A result whose call is not
 * loaded stays visible as a standalone tool row.
 */
export function projectTranscript(entries: readonly EntryRecord[]): DisplayRow[] {
  const rows: DisplayRow[] = [];
  let round: ToolRow[] = [];
  for (const entry of entries) {
    switch (entry.kind) {
      case "pi.user": {
        const message = entry.model?.[0] as UserMessage | undefined;
        rows.push({
          kind: "user",
          key: String(entry.id),
          entryId: entry.id,
          text: userContentText(message?.content ?? ""),
        });
        round = [];
        break;
      }
      case "pi.assistant": {
        const message = entry.model?.[0] as AssistantMessage | undefined;
        const projected = projectAssistant(message, `${entry.id}:`, entry.id, false);
        rows.push(...projected.rows);
        round = projected.round;
        break;
      }
      case "pi.tool-result": {
        const message = entry.model?.[0] as ToolResultMessage | undefined;
        const details: ToolResultDetails = {
          text: toolResultText(message),
          isError: message?.isError ?? false,
          ...(typeof message?.durationMs === "number" ? { durationMs: message.durationMs } : {}),
        };
        const callId = message?.toolCallId;
        const matched = callId
          ? round.find((row) => row.callId === callId && row.result === undefined)
          : undefined;
        if (matched) {
          matched.result = details;
          matched.resultEntryId = entry.id;
        } else {
          rows.push({
            kind: "tool",
            key: `result:${entry.id}`,
            entryId: entry.id,
            toolName: message?.toolName ?? "tool",
            argumentsComplete: true,
            result: details,
            resultEntryId: entry.id,
            standalone: true,
          });
        }
        break;
      }
      case "pi.compaction": {
        const message = entry.model?.[0] as UserMessage | undefined;
        rows.push({
          kind: "summary",
          key: String(entry.id),
          entryId: entry.id,
          text: userContentText(message?.content ?? ""),
        });
        round = [];
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

function projectAssistant(
  message: AssistantMessage | undefined,
  keyPrefix: string,
  entryId: EntryId | undefined,
  streaming: boolean,
): { rows: DisplayRow[]; round: ToolRow[] } {
  const rows: DisplayRow[] = [];
  const round: ToolRow[] = [];
  let hasText = false;
  const content = message?.content ?? [];
  content.forEach((block, index) => {
    if (block.type === "text") {
      if (block.text.length === 0) return;
      hasText = true;
      rows.push({
        kind: "assistant",
        key: `${keyPrefix}t${index}`,
        entryId,
        text: block.text,
        ...(streaming ? { streaming: true } : {}),
      });
      return;
    }
    if (block.type === "thinking") {
      rows.push({
        kind: "thinking",
        key: `${keyPrefix}k${index}`,
        entryId,
        text: block.thinking,
        ...(streaming ? { streaming: true } : {}),
      });
      return;
    }
    if (block.type === "toolCall") {
      const row: ToolRow = {
        kind: "tool",
        key: `${keyPrefix}c${block.id}`,
        entryId,
        callId: block.id,
        toolName: block.name,
        arguments: block.arguments,
        argumentsComplete: !streaming,
        ...(streaming ? { streaming: true } : {}),
      };
      rows.push(row);
      round.push(row);
    }
  });
  if (!streaming && !hasText && message?.stopReason === "error") {
    // Preserve the terminal provider error so a reconnecting user sees why the
    // turn produced no answer. Thinking content is never a substitute message.
    rows.push({
      kind: "assistant",
      key: `${keyPrefix}err`,
      entryId,
      text: message.errorMessage ?? "The model request failed.",
      isError: true,
    });
  }
  return { rows, round };
}

/** Format a recorded tool duration in whole seconds, or nothing when absent. */
export function formatDuration(durationMs: number | undefined): string | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  return `${Math.round(durationMs / 1000)}s`;
}

/** The disclosure label: tool name plus an available recorded duration. */
export function formatToolLabel(row: ToolRow): string {
  const duration = formatDuration(row.result?.durationMs);
  return duration === undefined ? row.toolName : `${row.toolName}\uFF0E${duration}`;
}

export function userContentText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
    .join("\n");
}

function toolResultText(message: ToolResultMessage | undefined): string {
  if (!message) return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
    .join("\n");
}
