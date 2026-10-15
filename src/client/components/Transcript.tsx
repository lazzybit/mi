import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisplayEntry } from "../view";
import { AssistantMessage } from "./AssistantMessage";
import { ToolCallCard } from "./ToolCallCard";

export function Transcript(props: {
  entries: DisplayEntry[];
  onLoadOlder: () => void;
  hasOlder: boolean;
}): JSX.Element {
  let container: HTMLDivElement | undefined;
  const [following, setFollowing] = createSignal(true);

  createEffect(
    () => props.entries.length,
    () => {
      // Auto-follow only when already near the end so reading history is not
      // interrupted.
      if (!container || !following()) return;
      container.scrollTop = container.scrollHeight;
    },
  );

  const onScroll = () => {
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    setFollowing(distance < 120);
    if (container.scrollTop < 40 && props.hasOlder) props.onLoadOlder();
  };

  return (
    <div class="transcript" ref={container} onScroll={onScroll}>
      <Show when={props.hasOlder}>
        <button class="load-older touch" onClick={() => props.onLoadOlder()}>
          Load older messages
        </button>
      </Show>
      <For each={props.entries}>
        {(entry) => (
          <article class={`entry entry-${entry.kind}`}>
            <Show when={entry.kind === "user"}>
              <div class="user-message">{entry.text}</div>
            </Show>
            <Show when={entry.kind === "assistant" || entry.kind === "summary"}>
              <AssistantMessage entry={entry} />
            </Show>
            <Show when={entry.kind === "tool_result"}>
              <ToolCallCard entry={entry} />
            </Show>
          </article>
        )}
      </For>
    </div>
  );
}
