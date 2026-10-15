import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisplayEntry } from "../view";

export function AssistantMessage(props: { entry: DisplayEntry }): JSX.Element {
  return (
    <div class={`assistant-message ${props.entry.streaming ? "streaming" : ""} ${props.entry.isError ? "error" : ""}`}>
      <Show when={props.entry.kind === "summary"}>
        <div class="notice">Conversation summary</div>
      </Show>
      <Show when={props.entry.isError}>
        <div class="notice">The model request failed.</div>
      </Show>
      <div class="assistant-text">{props.entry.text}</div>
    </div>
  );
}
