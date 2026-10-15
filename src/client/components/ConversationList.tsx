import { For, Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConversationSummary } from "../../shared/domain";
import type { DispatchResult } from "./types";

export function ConversationList(props: {
  conversations: ConversationSummary[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, title: string) => Promise<DispatchResult>;
  onDelete: (id: string) => Promise<DispatchResult>;
}): JSX.Element {
  const [editingId, setEditingId] = createSignal<string>();
  const [draft, setDraft] = createSignal("");
  const [renamePending, setRenamePending] = createSignal(false);
  const [renameError, setRenameError] = createSignal<string>();
  const [confirmingId, setConfirmingId] = createSignal<string>();
  const [deletePending, setDeletePending] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string>();

  const startEditing = (conversation: ConversationSummary) => {
    setEditingId(conversation.id);
    setDraft(conversation.title);
    setRenameError(undefined);
  };

  const cancelEditing = () => {
    setEditingId(undefined);
    setRenameError(undefined);
  };

  const save = async () => {
    const id = editingId();
    if (!id || renamePending()) return;
    setRenamePending(true);
    setRenameError(undefined);
    try {
      const result = await props.onRename(id, draft());
      if (result.status === "accepted") {
        setEditingId(undefined);
      } else if (result.status === "rejected") {
        // Keep the entered value so the owner can correct and retry.
        setRenameError(result.error?.message ?? "Rename was refused");
      } else {
        setRenameError("Rename could not be confirmed. Try again.");
      }
    } finally {
      setRenamePending(false);
    }
  };

  const confirmDelete = async () => {
    const id = confirmingId();
    if (!id || deletePending()) return;
    setDeletePending(true);
    setDeleteError(undefined);
    try {
      const result = await props.onDelete(id);
      if (result.status === "accepted") {
        setConfirmingId(undefined);
      } else if (result.status === "rejected") {
        setDeleteError(result.error?.message ?? "Deletion was refused");
      } else {
        setDeleteError("Deletion outcome is unknown. Try again.");
      }
    } finally {
      setDeletePending(false);
    }
  };

  return (
    <aside class="conversation-list">
      <button class="primary touch" onClick={() => props.onCreate()}>
        New conversation
      </button>
      <ul>
        <For each={props.conversations}>
          {(conversation) => (
            <li class="conversation-row">
              <Show
                when={editingId() === conversation.id}
                fallback={
                  <>
                    <button
                      class={`conversation-item touch ${conversation.id === props.selectedId ? "selected" : ""}`}
                      data-conversation-id={conversation.id}
                      onClick={() => props.onSelect(conversation.id)}
                    >
                      <span class="conversation-title">{conversation.title}</span>
                    </button>
                    <div class="conversation-controls">
                      <button
                        class="icon touch"
                        aria-label={`Rename ${conversation.title}`}
                        onClick={() => startEditing(conversation)}
                      >
                        Rename
                      </button>
                      <button
                        class="icon touch"
                        aria-label={`Delete ${conversation.title}`}
                        onClick={() => {
                          setConfirmingId(conversation.id);
                          setDeleteError(undefined);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                }
              >
                <div class="rename-editor">
                  <input
                    class="rename-input"
                    aria-label="Conversation title"
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.isComposing) {
                        event.preventDefault();
                        void save();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        cancelEditing();
                      }
                    }}
                  />
                  <div class="rename-actions">
                    <button class="primary touch" disabled={renamePending()} onClick={() => void save()}>
                      Save
                    </button>
                    <button class="secondary touch" disabled={renamePending()} onClick={cancelEditing}>
                      Cancel
                    </button>
                  </div>
                  <Show when={renameError()}>
                    <p class="inline-error">{renameError()}</p>
                  </Show>
                </div>
              </Show>
              <Show when={confirmingId() === conversation.id}>
                <div
                  class="delete-confirm"
                  role="alertdialog"
                  aria-label={`Confirm delete ${conversation.title}`}
                >
                  <p>
                    Permanently delete “{conversation.title}” and its history? This cannot be undone.
                  </p>
                  <p class="hint">
                    Any queued or active work is stopped, and the conversation's
                    history is permanently erased.
                  </p>
                  <div class="delete-actions">
                    <button
                      class="danger touch"
                      disabled={deletePending()}
                      onClick={() => void confirmDelete()}
                    >
                      Delete permanently
                    </button>
                    <button
                      class="secondary touch"
                      disabled={deletePending()}
                      onClick={() => setConfirmingId(undefined)}
                    >
                      Cancel
                    </button>
                  </div>
                  <Show when={deleteError()}>
                    <p class="inline-error">{deleteError()}</p>
                  </Show>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
