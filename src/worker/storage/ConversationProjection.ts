// ADR-0001: One summary builder serves full snapshots and live mutations so a
// rename or queue transition never publishes a partial conversation summary.

import type { ConversationSummaryView } from "../../shared/domain";
import type { ViewChange } from "../../shared/wire";
import type { StoreTransaction } from "./SqlStore";
import type { ConversationRecord } from "./records";
import { projectConversation } from "./projections";

export function projectConversationSummary(
  tx: StoreTransaction,
  record: ConversationRecord,
): ConversationSummaryView {
  const activeRun = tx.runs.activeForConversation(record.id);
  const lastEntry = tx.entries.last(record.id);
  const queuedCount = tx.submissions.listQueuedForConversation(record.id).length;
  const summary: ConversationSummaryView = {
    ...projectConversation(record),
    queuedCount,
  };
  if (activeRun) summary.activeRunState = activeRun.state;
  if (lastEntry?.text) summary.lastEntryPreview = lastEntry.text.slice(0, 120);
  return summary;
}

/**
 * Build the `conversation.upsert` change for a conversation whose execution
 * state or queue count may have changed. Returns `undefined` when the
 * conversation no longer exists (for example after deletion).
 */
export function conversationSummaryChange(
  tx: StoreTransaction,
  conversationId: string,
): ViewChange | undefined {
  const record = tx.conversations.get(conversationId);
  if (!record) return undefined;
  return { kind: "conversation.upsert", value: projectConversationSummary(tx, record) };
}
