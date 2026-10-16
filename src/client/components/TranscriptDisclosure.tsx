// Shared disclosure control (ADR-0005).
//
// Thinking and tool rows use one accessible disclosure. Expansion is
// controlled by the parent so streaming updates, remounts, and new projected
// objects never reset the user's choice.

import { createEffect } from "solid-js";
import type { JSX } from "@solidjs/web";

export function TranscriptDisclosure(props: {
  label: string;
  expanded: boolean;
  onToggle: (expanded: boolean) => void;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  let element: HTMLDetailsElement | undefined;
  createEffect(
    () => props.expanded,
    (expanded) => {
      if (element && element.open !== expanded) element.open = expanded;
    },
  );
  return (
    <details
      ref={element}
      class={`disclosure ${props.class ?? ""}`}
      onToggle={(event) => {
        const open = (event.currentTarget as HTMLDetailsElement).open;
        if (open !== props.expanded) props.onToggle(open);
      }}
    >
      <summary class="disclosure-summary touch">{props.label}</summary>
      <div class="disclosure-details">{props.children}</div>
    </details>
  );
}
