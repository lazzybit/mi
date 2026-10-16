// Conversation-scoped disclosure state (ADR-0005).
//
// The client keeps expansion choices outside the projection so streaming
// updates, live-to-committed replacement, and history reconciliation never
// reset them. This module owns presentation state only: it does not reconstruct
// execution state, persist data, or introduce another session protocol.

import { createSignal, type Accessor, type Setter } from "solid-js";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { liveIdentity, type DisplayRow } from "./view";

export interface DisclosureController {
  expanded(key: string): boolean;
  set(key: string, expanded: boolean): void;
}

export interface DisclosureObservation {
  conversationId?: string;
  entries: readonly EntryRecord[];
  rows: readonly DisplayRow[];
  liveMessage?: AssistantMessage;
}

export class DisclosureState implements DisclosureController {
  private readonly choices = new Map<string, boolean>();
  private readonly version: Accessor<number>;
  private readonly setVersion: Setter<number>;
  private conversationId?: string;
  private activeLive?: string;
  private liveStartEntryIds = new Set<string>();
  private lastLiveMessage?: AssistantMessage;

  constructor() {
    const [version, setVersion] = createSignal(0);
    this.version = version;
    this.setVersion = setVersion;
  }

  /** Read one row's expansion choice, subscribing the caller to later changes. */
  expanded(key: string): boolean {
    this.version();
    return this.choices.get(key) ?? false;
  }

  /** Record an explicit choice; newly encountered rows default to collapsed. */
  set(key: string, expanded: boolean): void {
    if ((this.choices.get(key) ?? false) === expanded) return;
    this.choices.set(key, expanded);
    this.bump();
  }

  /**
   * Reconcile presentation state with one observed view.
   *
   * Call once per relevant view or history update, not from render getters.
   * A live generation is reconciled with its committed counterpart when it
   * disappears; a standalone historical result follows its call when the call
   * later loads.
   */
  observe(input: DisclosureObservation): void {
    if (input.conversationId !== this.conversationId) {
      this.conversationId = input.conversationId;
      this.choices.clear();
      this.activeLive = undefined;
      this.liveStartEntryIds = new Set();
      this.lastLiveMessage = undefined;
      this.bump();
    }

    this.reconcileStandaloneResults(input.rows);

    const assistantIds = new Set<string>();
    for (const entry of input.entries) {
      if (entry.kind === "pi.assistant") assistantIds.add(String(entry.id));
    }

    if (input.liveMessage) {
      const token = liveIdentity(input.liveMessage);
      if (this.activeLive !== token) {
        if (this.activeLive !== undefined) this.finishLive(input.entries);
        this.activeLive = token;
        this.liveStartEntryIds = new Set(assistantIds);
      }
      this.lastLiveMessage = input.liveMessage;
    } else if (this.activeLive !== undefined) {
      this.finishLive(input.entries);
    }
  }

  /** Move state from a standalone result row to its matched call row. */
  private reconcileStandaloneResults(rows: readonly DisplayRow[]): void {
    for (const row of rows) {
      if (row.kind !== "tool" || row.callId === undefined || row.resultEntryId === undefined) continue;
      const from = `result:${row.resultEntryId}`;
      if (!this.choices.has(from)) continue;
      if (!this.choices.has(row.key)) this.choices.set(row.key, this.choices.get(from)!);
      this.choices.delete(from);
      this.bump();
    }
  }

  /** Transfer the ended live generation's choices to its committed entry. */
  private finishLive(entries: readonly EntryRecord[]): void {
    const token = this.activeLive;
    const message = this.lastLiveMessage;
    const started = this.liveStartEntryIds;
    this.activeLive = undefined;
    this.lastLiveMessage = undefined;
    this.liveStartEntryIds = new Set();
    if (token === undefined) return;
    const prefix = `${token}:`;
    if (message !== undefined) {
      let committedId: string | undefined;
      for (const entry of entries) {
        if (entry.kind === "pi.assistant" && !started.has(String(entry.id))) {
          committedId = String(entry.id);
        }
      }
      if (committedId !== undefined) this.transferLive(prefix, `${committedId}:`, message);
    }
    // Never retain live state that a later generation could reuse.
    this.deletePrefix(prefix);
  }

  private transferLive(fromPrefix: string, toPrefix: string, message: AssistantMessage): void {
    const content = message.content ?? [];
    content.forEach((block, index) => {
      let from: string | undefined;
      let to: string | undefined;
      if (block.type === "text") {
        from = `${fromPrefix}t${index}`;
        to = `${toPrefix}t${index}`;
      } else if (block.type === "thinking") {
        from = `${fromPrefix}k${index}`;
        to = `${toPrefix}k${index}`;
      } else if (block.type === "toolCall") {
        from = `${fromPrefix}c${block.id}`;
        to = `${toPrefix}c${block.id}`;
      }
      if (from === undefined || to === undefined) return;
      if (!this.choices.has(from)) return;
      if (!this.choices.has(to)) this.choices.set(to, this.choices.get(from)!);
      this.choices.delete(from);
      this.bump();
    });
  }

  private deletePrefix(prefix: string): void {
    let changed = false;
    for (const key of [...this.choices.keys()]) {
      if (key.startsWith(prefix)) {
        this.choices.delete(key);
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  private bump(): void {
    this.setVersion((value) => value + 1);
  }
}
