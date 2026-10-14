import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TranscriptEntryView } from "../../shared/domain";

export function AssistantMessage(props: { entry: TranscriptEntryView }): JSX.Element {
  return (
    <div class={`assistant-message ${props.entry.streaming ? "streaming" : ""}`}>
      <Show when={props.entry.metadata?.interrupted === true}>
        <div class="notice">Interrupted — the answer above is partial.</div>
      </Show>
      <div class="assistant-text">{props.entry.text}</div>
    </div>
  );
}
