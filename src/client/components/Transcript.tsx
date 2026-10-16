import { For, Show, createEffect, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisclosureController } from "../DisclosureState";
import type { AssistantTextRow, DisplayRow, SummaryRow, ThinkingRow, ToolRow, UserRow } from "../view";
import { AssistantMessage } from "./AssistantMessage";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

export function Transcript(props: {
  rows: DisplayRow[];
  disclosure: DisclosureController;
  onLoadOlder: () => void;
  hasOlder: boolean;
}): JSX.Element {
  let container: HTMLDivElement | undefined;
  const [following, setFollowing] = createSignal(true);

  createEffect(
    () => props.rows.length,
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
      <For each={props.rows} keyed={(row) => row.key}>
        {(row) => (
          <article class={`entry entry-${row().kind}`}>
            <Show when={row().kind === "user"}>
              <div class="user-message">{(row() as UserRow).text}</div>
            </Show>
            <Show when={row().kind === "assistant" || row().kind === "summary"}>
              <AssistantMessage row={row() as AssistantTextRow | SummaryRow} />
            </Show>
            <Show when={row().kind === "thinking"}>
              <ThinkingBlock row={row() as ThinkingRow} disclosure={props.disclosure} />
            </Show>
            <Show when={row().kind === "tool"}>
              <ToolCallCard row={row() as ToolRow} disclosure={props.disclosure} />
            </Show>
          </article>
        )}
      </For>
    </div>
  );
}
