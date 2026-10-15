import { Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConversationView, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import type { ConnectionStatus } from "../session/SessionFeed";
import { liveSummary, queuedInputs, toDisplayEntries, transcriptEntries, type DisplayEntry } from "../view";
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
  const [older, setOlder] = createSignal<DisplayEntry[]>([]);
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

  const entries = () => [...older(), ...transcriptEntries(props.view)];
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
      const known = new Set<DisplayEntry["id"]>(older().map((entry) => entry.id));
      for (const entry of props.view?.entries ?? []) known.add(entry.id);
      const display = toDisplayEntries([...page.entries].reverse()).filter(
        (entry) => !known.has(entry.id),
      );
      setOlder((previous) => [...display, ...previous]);
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
              entries={entries()}
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
