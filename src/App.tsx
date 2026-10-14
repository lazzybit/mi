import { Show, createSignal, onSettled } from "solid-js";
import type { OwnerSnapshot, TranscriptEntryView } from "./shared/domain";
import { AppShell } from "./client/components/AppShell";
import { ConversationList } from "./client/components/ConversationList";
import { ConversationScreen } from "./client/components/ConversationScreen";
import { SettingsScreen } from "./client/components/SettingsScreen";
import type { AppActions, AppView } from "./client/components/types";
import { CommandDispatcher, type DispatchResult } from "./client/commands/CommandDispatcher";
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

  // ADR-0001: a fresh snapshot establishes the reconnect boundary. Commands
  // wait for local reconciliation and ordered outbox replay before they are
  // sent, so no mutation bypasses the authoritative state.
  let releaseBoundary: () => void = () => {};
  let boundary = new Promise<void>((resolve) => {
    releaseBoundary = resolve;
  });

  const actions: AppActions = {
    async dispatch(kind, payload): Promise<DispatchResult> {
      const command = dispatcher.newCommand(kind, payload);
      await boundary;
      return dispatcher.dispatch(command);
    },
    selectConversation(id) {
      setSelectedId(id);
      feed.select(id);
      setDraft(id ? drafts.get(id) : "");
    },
    setView,
    reconnect: () => feed.reconnect(),
  };

  const reconcile = async (value: OwnerSnapshot): Promise<void> => {
    const known = new Set(value.conversations.map((conversation) => conversation.id));
    for (const entry of drafts.list()) {
      if (!known.has(entry.conversationId)) drafts.clear(entry.conversationId);
    }
    // Drop obsolete scoped mutations only when their target deletion is
    // established. Pending creates, unacknowledged deletes, and legacy
    // commands without a target are preserved for the server to settle.
    for (const command of await outbox.pending()) {
      if (command.kind === "conversation.create" || command.kind === "conversation.delete") continue;
      const target = command.target?.conversationId;
      if (!target) continue;
      if (!known.has(target)) await outbox.acknowledge(command.commandId);
    }
    const selected = selectedId();
    if (selected && !known.has(selected)) {
      setSelectedId(undefined);
      feed.select(undefined);
      setDraft("");
    }
  };

  onSettled(() => {
    const opened = outbox.open();
    feed.subscribe((value) => {
      setSnapshot(value);
      const selected = value.selectedConversation?.conversation.id;
      if (selected && selected !== selectedId()) setSelectedId(selected);
    });
    feed.onSnapshot((value) => {
      boundary = boundary.then(async () => {
        await reconcile(value);
        await dispatcher.flush();
      });
      releaseBoundary();
    });
    feed.onStatus(setStatus);
    void opened.then(() => feed.connect());
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
                onRename={(id, title) => actions.dispatch("conversation.rename", { conversationId: id, title })}
                onDelete={(id) => actions.dispatch("conversation.delete", { conversationId: id })}
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
