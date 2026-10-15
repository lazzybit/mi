// Presentation mapping for a pi-durable `ConversationView` (ADR-0003).
//
// The client renders committed transcript entries plus the committed live
// partial. It never derives execution state of its own: everything shown comes
// from the session's committed view.

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ConversationView, EntryId, EntryRecord, SubmissionId } from "@earendil-works/pi-durable";
import type { InboxState, LiveState } from "@earendil-works/pi-durable";

export interface DisplayEntry {
  id: EntryId | string;
  kind: "user" | "assistant" | "tool_result" | "summary";
  text: string;
  streaming?: boolean;
  isError?: boolean;
  toolName?: string;
}

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

/** Committed transcript entries, oldest first. */
export function transcriptEntries(view: ConversationView | undefined): DisplayEntry[] {
  if (!view) return [];
  const entries = toDisplayEntries(view.entries);
  const partial = livePartial(view);
  if (partial) entries.push(partial);
  return entries;
}

/** Map raw entry records to display entries, skipping non-visible kinds. */
export function toDisplayEntries(records: readonly EntryRecord[]): DisplayEntry[] {
  const entries: DisplayEntry[] = [];
  for (const entry of records) {
    const display = toDisplayEntry(entry);
    if (display) entries.push(display);
  }
  return entries;
}

function toDisplayEntry(entry: EntryRecord): DisplayEntry | undefined {
  switch (entry.kind) {
    case "pi.user": {
      const message = entry.model?.[0] as UserMessage | undefined;
      return {
        id: entry.id,
        kind: "user",
        text: userContentText(message?.content ?? ""),
      };
    }
    case "pi.assistant": {
      const message = entry.model?.[0] as AssistantMessage | undefined;
      const text = assistantText(message);
      if (!text && message?.stopReason === "error") {
        // Preserve the terminal provider error so a reconnecting user sees why
        // the turn produced no answer.
        return {
          id: entry.id,
          kind: "assistant",
          text: message.errorMessage ?? "The model request failed.",
          isError: true,
        };
      }
      return {
        id: entry.id,
        kind: "assistant",
        text,
      };
    }
    case "pi.tool-result": {
      const message = entry.model?.[0] as ToolResultMessage | undefined;
      return {
        id: entry.id,
        kind: "tool_result",
        text: toolResultText(message),
        isError: message?.isError ?? false,
        toolName: message?.toolName,
      };
    }
    case "pi.compaction": {
      const message = entry.model?.[0] as UserMessage | undefined;
      return {
        id: entry.id,
        kind: "summary",
        text: userContentText(message?.content ?? ""),
      };
    }
    default:
      return undefined;
  }
}

/** The committed partial of the in-flight response, if any. */
function livePartial(view: ConversationView): DisplayEntry | undefined {
  const message = liveState(view)?.generation?.message as unknown as AssistantMessage | undefined;
  if (!message) return undefined;
  const text = assistantText(message);
  if (!text) return undefined;
  return { id: "live-generation", kind: "assistant", text, streaming: true };
}

export function userContentText(content: UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
    .join("\n");
}

function assistantText(message: AssistantMessage | undefined): string {
  if (!message) return "";
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

function toolResultText(message: ToolResultMessage | undefined): string {
  if (!message) return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
    .join("\n");
}
