import { Show, createSignal, onSettled } from "solid-js";
import type { OwnerSnapshot, TranscriptEntryView } from "./shared/domain";
import { AppShell } from "./client/components/AppShell";
import { ConversationList } from "./client/components/ConversationList";
import { ConversationScreen } from "./client/components/ConversationScreen";
import { SettingsScreen } from "./client/components/SettingsScreen";
import type { AppActions, AppView } from "./client/components/types";
import { CommandDispatcher } from "./client/commands/CommandDispatcher";
import { CommandOutbox } from "./client/commands/CommandOutbox";
import { createCommandHandlers } from "./client/commands/registry";
import { DraftStore } from "./client/storage/DraftStore";
import { ConversationFeed, type ConnectionStatus } from "./client/sync/ConversationFeed";
import { getHistory } from "./rpc/conversations";
import { readArtifact } from "./rpc/artifacts";
import "./styles.css";

export default function App() {
  const feed = new ConversationFeed("/ws");
  const outbox = new CommandOutbox();
  const dispatcher = new CommandDispatcher(outbox, createCommandHandlers());
  const drafts = new DraftStore();

  const [snapshot, setSnapshot] = createSignal<OwnerSnapshot>();
  const [status, setStatus] = createSignal<ConnectionStatus>("connecting");
  const [selectedId, setSelectedId] = createSignal<string>();
  const [view, setView] = createSignal<AppView>("chat");
  const [draft, setDraft] = createSignal("");

  const actions: AppActions = {
    async dispatch(kind, payload) {
      const command = dispatcher.newCommand(kind, payload);
      await dispatcher.dispatch(command);
    },
    selectConversation(id) {
      setSelectedId(id);
      feed.select(id);
      setDraft(id ? drafts.get(id) : "");
    },
    setView,
    reconnect: () => feed.reconnect(),
  };

  onSettled(() => {
    void outbox.open().then(() => dispatcher.flush());
    feed.subscribe((value) => {
      setSnapshot(value);
      const selected = value.selectedConversation?.conversation.id;
      if (selected && selected !== selectedId()) setSelectedId(selected);
    });
    feed.onStatus(setStatus);
    feed.connect();
    return () => feed.dispose();
  });

  const conversations = () => snapshot()?.conversations ?? [];

  return (
    <AppShell>
      <header class="app-header">
        <h1>mi</h1>
        <nav>
          <button
            class={`tab touch ${view() === "chat" ? "active" : ""}`}
            onClick={() => setView("chat")}
          >
            Chat
          </button>
          <button
            class={`tab touch ${view() === "settings" ? "active" : ""}`}
            onClick={() => setView("settings")}
          >
            Settings
          </button>
        </nav>
      </header>
      <Show when={snapshot()} fallback={<div class="loading">Connecting…</div>}>
        {(value) => (
          <div class="app-body">
            <Show when={view() === "chat"}>
              <ConversationList
                conversations={conversations()}
                selectedId={selectedId()}
                onSelect={(id) => actions.selectConversation(id)}
                onCreate={() => void actions.dispatch("conversation.create", {})}
              />
              <ConversationScreen
                snapshot={value()}
                status={status()}
                actions={actions}
                draft={draft()}
                onDraft={(next) => {
                  setDraft(next);
                  const id = selectedId();
                  if (id) drafts.set(id, next);
                }}
                onHistory={async (beforeSequence) => {
                  const id = selectedId();
                  if (!id) return [];
                  const page = await getHistory({ conversationId: id, beforeSequence, limit: 50 });
                  return page.entries;
                }}
                onReadArtifact={async (artifactId) => {
                  const page = await readArtifact({ artifactId, offset: 0, limit: 65_536 });
                  return page.text;
                }}
              />
            </Show>
            <Show when={view() === "settings"}>
              <SettingsScreen configuration={value().configuration} dispatch={actions.dispatch} />
            </Show>
          </div>
        )}
      </Show>
    </AppShell>
  );
}

export type { TranscriptEntryView };
