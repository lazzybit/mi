// Pending submission store (ADR-0003).
//
// A submission is acknowledged by the session with its upstream submission id.
// Until that acknowledgement arrives the client keeps the logical request keyed
// by conversation and `requestId`, so a reconnect can resend the same request
// and the harness deduplicates it. Management actions are not stored here:
// they report their result directly and are not automatically replayed.

export interface PendingSubmission {
  requestId: string;
  conversationId: string;
  text: string;
  whenBusy: "followUp" | "steer";
  createdAt: number;
}

const KEY = "mi:pending-submissions";

export class PendingSubmissionStore {
  private entries = new Map<string, PendingSubmission>();

  constructor() {
    this.load();
  }

  add(entry: PendingSubmission): void {
    this.entries.set(entry.requestId, entry);
    this.save();
  }

  remove(requestId: string): void {
    if (this.entries.delete(requestId)) this.save();
  }

  list(conversationId?: string): PendingSubmission[] {
    const all = [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
    return conversationId ? all.filter((entry) => entry.conversationId === conversationId) : all;
  }

  clearConversation(conversationId: string): void {
    let changed = false;
    for (const [requestId, entry] of this.entries) {
      if (entry.conversationId === conversationId) {
        this.entries.delete(requestId);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PendingSubmission[];
      for (const entry of parsed) {
        if (entry && typeof entry.requestId === "string") this.entries.set(entry.requestId, entry);
      }
    } catch {
      // A corrupt store is discarded; the harness deduplicates what was sent.
    }
  }

  private save(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.entries.values()]));
    } catch {
      // Storage may be unavailable; the in-memory copy still works.
    }
  }
}
