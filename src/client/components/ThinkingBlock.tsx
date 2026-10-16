// Thinking disclosure (ADR-0005).
//
// The label is exactly `Thinking ...`; the disclosure opens onto the available
// thinking text and updates during streaming without changing expansion. No
// duration, token count, or provider continuation data is shown.

import type { JSX } from "@solidjs/web";
import type { DisclosureController } from "../DisclosureState";
import type { ThinkingRow } from "../view";
import { TranscriptDisclosure } from "./TranscriptDisclosure";

export function ThinkingBlock(props: { row: ThinkingRow; disclosure: DisclosureController }): JSX.Element {
  return (
    <TranscriptDisclosure
      label="Thinking ..."
      expanded={props.disclosure.expanded(props.row.key)}
      onToggle={(open) => props.disclosure.set(props.row.key, open)}
      class="thinking-block"
    >
      <div class="thinking-text">{props.row.text}</div>
    </TranscriptDisclosure>
  );
}
