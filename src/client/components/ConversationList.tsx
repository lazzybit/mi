import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ConversationSummaryView } from "../../shared/domain";

export function ConversationList(props: {
  conversations: ConversationSummaryView[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}): JSX.Element {
  return (
    <aside class="conversation-list">
      <button class="primary touch" onClick={() => props.onCreate()}>
        New conversation
      </button>
      <ul>
        <For each={props.conversations}>
          {(conversation) => (
            <li>
              <button
                class={`conversation-item touch ${conversation.id === props.selectedId ? "selected" : ""}`}
                onClick={() => props.onSelect(conversation.id)}
              >
                <span class="conversation-title">{conversation.title}</span>
                <Show when={conversation.activeRunState}>
                  {(state) => <span class={`run-dot ${state()}`}>{state()}</span>}
                </Show>
                <Show when={conversation.queuedCount > 0}>
                  <span class="queued-badge">{conversation.queuedCount} queued</span>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ul>
    </aside>
  );
}
