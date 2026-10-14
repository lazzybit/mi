// Device-local drafts (PLAN.md -> Client). Unsent drafts never leave the device.

const KEY_PREFIX = "mi:draft:";

export class DraftStore {
  private readonly memory = new Map<string, string>();

  get(conversationId: string): string {
    if (typeof localStorage === "undefined") return this.memory.get(conversationId) ?? "";
    return localStorage.getItem(KEY_PREFIX + conversationId) ?? "";
  }

  set(conversationId: string, value: string): void {
    if (typeof localStorage === "undefined") {
      this.memory.set(conversationId, value);
      return;
    }
    try {
      if (value) localStorage.setItem(KEY_PREFIX + conversationId, value);
      else localStorage.removeItem(KEY_PREFIX + conversationId);
    } catch {
      this.memory.set(conversationId, value);
    }
  }

  clear(conversationId: string): void {
    this.set(conversationId, "");
  }

  /** Enumerate stored drafts so reconnect cleanup can discard deleted ones. */
  list(): { conversationId: string; value: string }[] {
    if (typeof localStorage === "undefined") {
      return [...this.memory].map(([conversationId, value]) => ({ conversationId, value }));
    }
    const drafts: { conversationId: string; value: string }[] = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith(KEY_PREFIX)) continue;
        drafts.push({
          conversationId: key.slice(KEY_PREFIX.length),
          value: localStorage.getItem(key) ?? "",
        });
      }
    } catch {
      return [...this.memory].map(([conversationId, value]) => ({ conversationId, value }));
    }
    return drafts;
  }
}
