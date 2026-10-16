// Tool invocation disclosure (ADR-0005).
//
// One row per invocation, in call order. Closed rows show the tool name and an
// available recorded duration only; expanded rows reveal the available call
// arguments and result content. Errors carry no collapsed badge or styling.

import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisclosureController } from "../DisclosureState";
import { formatToolLabel, type ToolRow } from "../view";
import { TranscriptDisclosure } from "./TranscriptDisclosure";

export function ToolCallCard(props: { row: ToolRow; disclosure: DisclosureController }): JSX.Element {
  const label = () => formatToolLabel(props.row);
  return (
    <TranscriptDisclosure
      label={label()}
      expanded={props.disclosure.expanded(props.row.key)}
      onToggle={(open) => props.disclosure.set(props.row.key, open)}
      class="tool-card"
    >
      <Show when={props.row.arguments !== undefined}>
        <pre class="tool-arguments">{JSON.stringify(props.row.arguments, null, 2)}</pre>
      </Show>
      <Show when={props.row.result !== undefined}>
        <pre class={`tool-result ${props.row.result?.isError ? "error" : ""}`}>{props.row.result?.text}</pre>
      </Show>
      <Show when={props.row.arguments === undefined && props.row.result === undefined}>
        <p class="notice">No details available.</p>
      </Show>
    </TranscriptDisclosure>
  );
}
