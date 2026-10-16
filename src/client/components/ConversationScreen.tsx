import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConversationView, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { ConnectionStatus } from "../session/SessionFeed";
import { DisclosureState } from "../DisclosureState";
import {
  livePartialMessage,
  liveSummary,
  projectLiveRows,
  projectTranscript,
  queuedInputs,
  type DisplayRow,
} from "../view";
import { Composer } from "./Composer";
import { QueuePanel } from "./QueuePanel";
import { RunStatusBar } from "./RunStatusBar";
import { Transcript } from "./Transcript";
import type { AppActions } from "./types";

export function ConversationScreen(props: {
  conversationId?: string;
  view?: ConversationView;
  title?: string;
  status: ConnectionStatus;
  actions: AppActions;
  draft: string;
  onDraft: (value: string) => void;
  onHistory: (
    before: EntryId | undefined,
    cursor: Cursor | undefined,
    limit: number,
  ) => Promise<{ entries: EntryRecord[]; next?: Cursor }>;
}): JSX.Element {
  // ADR-0005: presentation state is scoped to the managed conversation and
  // survives projection, streaming, and history reconciliation.
  const disclosure = new DisclosureState();
  const [older, setOlder] = createSignal<EntryRecord[]>([]);
  const [cursor, setCursor] = createSignal<Cursor>();
  const [exhausted, setExhausted] = createSignal(false);
  const [historyBefore, setHistoryBefore] = createSignal<EntryId>();
  // Synchronous in-flight token: each load owns its token, so a stale request's
  // completion never releases a newer conversation's load guard.
  let loadCounter = 0;
  let activeLoad: number | undefined;
  // Every session's pi-durable root has numeric id 1, so selection-scoped state
  // must key on the external managed conversation id.
  const [selectionGeneration, setSelectionGeneration] = createSignal(0);
  createEffect(
    () => props.conversationId,
    () => {
      setOlder([]);
      setCursor(undefined);
      setExhausted(false);
      setHistoryBefore(undefined);
      activeLoad = undefined;
      setSelectionGeneration((generation) => generation + 1);
    },
  );

  // ADR-0005: keep loaded history as raw entries so projection can pair a call
  // and its result across a page boundary. Deduplicate by raw entry identity
  // while preserving upstream ordering.
  const combinedEntries = createMemo<EntryRecord[]>(() => {
    const seen = new Set<string>();
    const combined: EntryRecord[] = [];
    for (const entry of [...older(), ...(props.view?.entries ?? [])]) {
      const key = String(entry.id);
      if (seen.has(key)) continue;
      seen.add(key);
      combined.push(entry);
    }
    return combined;
  });
  const committedRows = createMemo<DisplayRow[]>(() => projectTranscript(combinedEntries()));
  const liveMessage = createMemo(() => livePartialMessage(props.view));
  const rows = createMemo<DisplayRow[]>(() => {
    const message = liveMessage();
    const base = committedRows();
    return message ? [...base, ...projectLiveRows(message)] : base;
  });
  createEffect(
    () => ({
      conversationId: props.conversationId,
      entries: combinedEntries(),
      rows: committedRows(),
      liveMessage: liveMessage(),
    }),
    (observation) => disclosure.observe(observation),
  );

  const hasOlder = () => !exhausted() && (historyBefore() ?? props.view?.entries[0]?.id) !== undefined;

  const loadOlder = async () => {
    if (activeLoad !== undefined) return;
    // The first page anchors on the oldest active entry; later pages reuse the
    // same raw query and round-trip the upstream cursor unchanged.
    const anchor = historyBefore() ?? (props.view?.entries[0]?.id as EntryId | undefined);
    if (anchor === undefined) return;
    if (historyBefore() === undefined) setHistoryBefore(anchor);
    const generation = selectionGeneration();
    const token = ++loadCounter;
    activeLoad = token;
    try {
      const page = await props.onHistory(anchor, cursor(), 50);
      // Discard a late page that belongs to a replaced selection or load.
      if (token !== activeLoad || generation !== selectionGeneration()) return;
      // `maxEntryId` is inclusive, so deduplicate against loaded history and
      // the active view.
      const known = new Set<string>();
      for (const entry of older()) known.add(String(entry.id));
      for (const entry of props.view?.entries ?? []) known.add(String(entry.id));
      const pageEntries = [...page.entries].reverse().filter((entry) => !known.has(String(entry.id)));
      setOlder((previous) => [...pageEntries, ...previous]);
      setCursor(page.next);
      if (!page.next) setExhausted(true);
    } catch {
      // A failed page leaves the transcript as it is.
    } finally {
      if (activeLoad === token) activeLoad = undefined;
    }
  };

  return (
    <section class="conversation-screen">
      <Show
        when={props.view}
        fallback={<div class="empty">Select or create a conversation.</div>}
      >
        {(view) => (
          <>
            <header class="conversation-header">
              <h2>{props.title ?? view().conversation.id}</h2>
            </header>
            <RunStatusBar
              live={liveSummary(view())}
              status={props.status}
              onCancel={() => void props.actions.cancel()}
            />
            <Transcript
              rows={rows()}
              disclosure={disclosure}
              hasOlder={hasOlder()}
              onLoadOlder={() => void loadOlder()}
            />
            <QueuePanel
              queued={queuedInputs(view())}
              onWithdraw={(submissionId) => void props.actions.withdraw(submissionId)}
            />
            <Composer
              draft={props.draft}
              busy={liveSummary(view()).active}
              onDraft={props.onDraft}
              onSubmit={(text, whenBusy) => void props.actions.submit(text, whenBusy)}
            />
          </>
        )}
      </Show>
    </section>
  );
}
