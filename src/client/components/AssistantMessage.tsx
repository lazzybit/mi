import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { AssistantTextRow, SummaryRow } from "../view";

export function AssistantMessage(props: { row: AssistantTextRow | SummaryRow }): JSX.Element {
  const streaming = () => props.row.kind === "assistant" && props.row.streaming === true;
  const isError = () => props.row.kind === "assistant" && props.row.isError === true;
  return (
    <div class={`assistant-message ${streaming() ? "streaming" : ""} ${isError() ? "error" : ""}`}>
      <Show when={props.row.kind === "summary"}>
        <div class="notice">Conversation summary</div>
      </Show>
      <Show when={isError()}>
        <div class="notice">The model request failed.</div>
      </Show>
      <div class="assistant-text">{props.row.text}</div>
    </div>
  );
}
