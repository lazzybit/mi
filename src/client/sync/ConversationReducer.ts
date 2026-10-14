// Reduces append-only view changes into a current snapshot
// (PLAN.md -> Client -> ConversationFeed).

import type {
  ConversationSummaryView,
  OwnerSnapshot,
  TranscriptEntryView,
} from "../../shared/domain";
import type { ViewChange } from "../../shared/wire";

export function applyChanges(snapshot: OwnerSnapshot, changes: ViewChange[]): OwnerSnapshot {
  let next = snapshot;
  for (const change of changes) next = applyChange(next, change);
  return next;
}

export function applyChange(snapshot: OwnerSnapshot, change: ViewChange): OwnerSnapshot {
  switch (change.kind) {
    case "conversation.upsert": {
      const conversations = upsertConversation(snapshot.conversations, change.value);
      const selected = snapshot.selectedConversation;
      return {
        ...snapshot,
        conversations,
        selectedConversation:
          selected && selected.conversation.id === change.value.id
            ? { ...selected, conversation: change.value }
            : selected,
      };
    }
    case "conversation.remove": {
      // ADR-0001: removing the selected conversation clears its snapshot so
      // the existing empty screen is shown; other selections are preserved.
      const selected = snapshot.selectedConversation;
      return {
        ...snapshot,
        conversations: snapshot.conversations.filter((c) => c.id !== change.conversationId),
        selectedConversation:
          selected && selected.conversation.id === change.conversationId ? undefined : selected,
      };
    }
    case "entry.append":
    case "entry.update": {
      const selected = snapshot.selectedConversation;
      if (!selected || selected.conversation.id !== change.conversationId) return snapshot;
      const entries = upsertEntry(selected.entries, change.value);
      return { ...snapshot, selectedConversation: { ...selected, entries } };
    }
    case "attempt.update": {
      const selected = snapshot.selectedConversation;
      if (!selected || selected.conversation.id !== change.conversationId) return snapshot;
      return { ...snapshot, selectedConversation: { ...selected, activeAttempt: change.value } };
    }
    case "run.update": {
      const selected = snapshot.selectedConversation;
      if (!selected || selected.conversation.id !== change.conversationId) return snapshot;
      const terminal = ["completed", "cancelled", "failed"].includes(change.value.state);
      return {
        ...snapshot,
        selectedConversation: {
          ...selected,
          activeRun: terminal ? undefined : change.value,
          activeAttempt: terminal ? undefined : selected.activeAttempt,
        },
      };
    }
    case "inbox.replace": {
      const selected = snapshot.selectedConversation;
      if (!selected || selected.conversation.id !== change.conversationId) return snapshot;
      return { ...snapshot, selectedConversation: { ...selected, queuedInputs: change.values } };
    }
    case "conversation.skills": {
      const selected = snapshot.selectedConversation;
      if (!selected || selected.conversation.id !== change.conversationId) return snapshot;
      return {
        ...snapshot,
        selectedConversation: { ...selected, selectedSkillIds: change.skillIds },
      };
    }
    case "configuration.update":
      return { ...snapshot, configuration: change.value };
    default:
      return snapshot;
  }
}

function upsertConversation(
  conversations: ConversationSummaryView[],
  value: ConversationSummaryView,
): ConversationSummaryView[] {
  const index = conversations.findIndex((conversation) => conversation.id === value.id);
  if (index === -1) return [value, ...conversations];
  const next = [...conversations];
  next[index] = value;
  return next;
}

function upsertEntry(
  entries: TranscriptEntryView[],
  value: TranscriptEntryView,
): TranscriptEntryView[] {
  const index = entries.findIndex((entry) => entry.id === value.id);
  if (index === -1) return [...entries, value];
  const next = [...entries];
  next[index] = value;
  return next;
}
