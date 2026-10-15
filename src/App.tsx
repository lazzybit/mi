// Application shell (ADR-0003). The catalog is fetched over HTTP; the
// selected conversation is observed over its session socket.
import { Show, createSignal, onSettled } from "solid-js";
import { AppError, type CatalogView, type ConversationId, type ModelSettingsView, type RouteSettingsInput } from "./shared/domain";
import type { ConversationView, SubmissionId } from "@earendil-works/pi-durable";
import { AppShell } from "./client/components/AppShell";
import { ConversationList } from "./client/components/ConversationList";
import { ConversationScreen } from "./client/components/ConversationScreen";
import { SettingsScreen } from "./client/components/SettingsScreen";
import type { AppActions, AppView, DispatchResult } from "./client/components/types";
import { SessionFeed, type ConnectionStatus } from "./client/session/SessionFeed";
import { PendingSubmissionStore } from "./client/pending/PendingSubmissions";
import { DraftStore } from "./client/storage/DraftStore";
import {
  createConversation,
  deleteConversation,
  getCatalog,
  renameConversation,
} from "./rpc/conversations";
import { saveModelProfile } from "./rpc/settings";
import "./styles.css";

export default function App() {
  const feed = new SessionFeed();
  const pending = new PendingSubmissionStore();
  const drafts = new DraftStore();

  const [catalog, setCatalog] = createSignal<CatalogView>();
  const [selectedId, setSelectedId] = createSignal<string>();
  const [view, setView] = createSignal<ConversationView>();
  const [status, setStatus] = createSignal<ConnectionStatus>("connecting");
  const [screen, setScreen] = createSignal<AppView>("chat");
  const [draft, setDraft] = createSignal("");
  const [notice, setNotice] = createSignal<string>();

  // The create command id is retained across a failed attempt so a retry
  // returns the same conversation instead of allocating another.
  let createCommandId = crypto.randomUUID();
  let catalogGeneration = 0;
  let flushing = false;

  const selectConversation = (id?: string) => {
    if (id === selectedId()) {
      // Re-selecting the current conversation must not clear its transcript;
      // only make sure the socket is observing it.
      feed.select(id);
      return;
    }
    setSelectedId(id);
    setView(undefined);
    feed.select(id);
    setDraft(id ? drafts.get(id) : "");
  };

  /**
   * Fetch the authoritative catalog and reconcile local state against it. The
   * catalog has no live broadcast, so deletion on another device is observed
   * here on focus, reconnect, or after a mutation.
   */
  const refreshCatalog = async (): Promise<CatalogView | undefined> => {
    const generation = ++catalogGeneration;
    try {
      const next = await getCatalog();
      // Discard a stale asynchronous catalog response.
      if (generation !== catalogGeneration) return undefined;
      setCatalog(next);
      const known = new Set(next.conversations.map((conversation) => conversation.id));
      for (const entry of drafts.list()) {
        if (!known.has(entry.conversationId)) drafts.clear(entry.conversationId);
      }
      for (const entry of pending.list()) {
        if (!known.has(entry.conversationId)) pending.clearConversation(entry.conversationId);
      }
      const selected = selectedId();
      if (selected && !known.has(selected)) selectConversation(undefined);
      return next;
    } catch {
      return undefined;
    }
  };

  const flushPending = async () => {
    if (flushing) return;
    const id = selectedId();
    if (!id) return;
    const generation = feed.generation;
    flushing = true;
    try {
      for (const entry of pending.list(id)) {
        // Pin each attempt to the conversation and socket generation that was
        // selected when the flush started.
        if (selectedId() !== id || feed.generation !== generation) return;
        try {
          await feed.submit(entry.requestId, entry.text, entry.whenBusy, {
            conversationId: id,
            generation,
          });
          pending.remove(entry.requestId);
        } catch {
          // Still unacknowledged; it stays pending for the next reconnect.
          return;
        }
      }
    } finally {
      flushing = false;
    }
  };

  const actions: AppActions = {
    async createConversation(): Promise<DispatchResult> {
      try {
        const receipt = await createConversation({ commandId: createCommandId, payload: {} });
        createCommandId = crypto.randomUUID();
        await refreshCatalog();
        selectConversation(receipt.result.conversationId);
        return { status: "accepted" };
      } catch (error) {
        const appError = toAppError(error);
        setNotice(appError?.message ?? "The conversation could not be created; retry when the connection returns.");
        return { status: "retry", error: appError };
      }
    },
    async renameConversation(id: ConversationId, title: string): Promise<DispatchResult> {
      try {
        const outcome = await renameConversation({ conversationId: id, title });
        if (!outcome.ok) {
          return { status: "rejected", error: new AppError(outcome.error.code, outcome.error.message, outcome.error.retryable) };
        }
        await refreshCatalog();
        return { status: "accepted" };
      } catch (error) {
        return { status: "retry", error: toAppError(error) };
      }
    },
    async deleteConversation(id: ConversationId): Promise<DispatchResult> {
      try {
        const outcome = await deleteConversation({ conversationId: id });
        if (!outcome.ok) {
          return { status: "rejected", error: new AppError(outcome.error.code, outcome.error.message, outcome.error.retryable) };
        }
        drafts.clear(id);
        pending.clearConversation(id);
        if (selectedId() === id) selectConversation(undefined);
        await refreshCatalog();
        return { status: "accepted" };
      } catch (error) {
        return { status: "retry", error: toAppError(error) };
      }
    },
    async submit(text: string, whenBusy: "followUp" | "steer"): Promise<void> {
      const id = selectedId();
      if (!id) return;
      const requestId = crypto.randomUUID();
      pending.add({ requestId, conversationId: id, text, whenBusy, createdAt: Date.now() });
      try {
        await feed.submit(requestId, text, whenBusy);
        pending.remove(requestId);
      } catch {
        setNotice("Your message is queued and will be sent when the connection returns.");
      }
    },
    async withdraw(submissionId: SubmissionId): Promise<void> {
      try {
        await feed.withdraw(crypto.randomUUID(), submissionId);
      } catch {
        setNotice("Withdrawal could not be confirmed. Try again.");
      }
    },
    async cancel(): Promise<void> {
      try {
        await feed.abort(crypto.randomUUID());
      } catch {
        setNotice("Cancellation could not be confirmed. Try again.");
      }
    },
    async saveModelProfile(settings: RouteSettingsInput): Promise<ModelSettingsView | undefined> {
      const saved = await saveModelProfile({ settings });
      await refreshCatalog();
      return saved;
    },
    selectConversation,
    setView: setScreen,
    reconnect: () => feed.reconnect(),
  };

  onSettled(() => {
    const onFocus = () => void refreshCatalog();
    const onOnline = () => void refreshCatalog();
    globalThis.addEventListener("focus", onFocus);
    globalThis.addEventListener("online", onOnline);

    const unsubscribeView = feed.subscribe((value) => setView(value));
    const unsubscribeNotice = feed.onNotice((value) => setNotice(value.message));
    const unsubscribeStatus = feed.onStatus((next) => {
      setStatus(next);
      if (next === "live") {
        void refreshCatalog();
        void flushPending();
      }
    });

    void refreshCatalog();

    // Solid 2.0: return cleanup from onSettled instead of registering onCleanup.
    return () => {
      globalThis.removeEventListener("focus", onFocus);
      globalThis.removeEventListener("online", onOnline);
      unsubscribeView();
      unsubscribeNotice();
      unsubscribeStatus();
      feed.dispose();
    };
  });

  const conversations = () => catalog()?.conversations ?? [];
  const selectedTitle = () =>
    conversations().find((conversation) => conversation.id === selectedId())?.title;

  return (
    <AppShell>
      <header class="app-header">
        <h1>mi</h1>
        <nav>
          <button
            class={`tab touch ${screen() === "chat" ? "active" : ""}`}
            onClick={() => setScreen("chat")}
          >
            Chat
          </button>
          <button
            class={`tab touch ${screen() === "settings" ? "active" : ""}`}
            onClick={() => setScreen("settings")}
          >
            Settings
          </button>
        </nav>
      </header>
      <Show when={catalog()} fallback={<div class="loading">Connecting…</div>}>
        {(value) => (
          <div class="app-body">
            <Show when={notice()}>
              <div class="notice app-notice">{notice()}</div>
            </Show>
            <Show when={screen() === "chat"}>
              <ConversationList
                conversations={conversations()}
                selectedId={selectedId()}
                onSelect={(id) => selectConversation(id)}
                onCreate={() => void actions.createConversation()}
                onRename={(id, title) => actions.renameConversation(id, title)}
                onDelete={(id) => actions.deleteConversation(id)}
              />
              <ConversationScreen
                conversationId={selectedId()}
                view={view()}
                title={selectedTitle()}
                status={status()}
                actions={actions}
                draft={draft()}
                onDraft={(next) => {
                  setDraft(next);
                  const id = selectedId();
                  if (id) drafts.set(id, next);
                }}
                onHistory={async (before, cursor, limit) => {
                  return feed.history(crypto.randomUUID(), before, cursor, limit);
                }}
              />
            </Show>
            <Show when={screen() === "settings"}>
              <SettingsScreen catalog={value()} actions={actions} />
            </Show>
          </div>
        )}
      </Show>
    </AppShell>
  );
}

function toAppError(error: unknown): AppError | undefined {
  return error instanceof AppError ? error : undefined;
}
