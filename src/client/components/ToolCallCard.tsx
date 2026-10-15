import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DisplayEntry } from "../view";

export function ToolCallCard(props: { entry: DisplayEntry }): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const preview = () => {
    const text = props.entry.text;
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  };

  return (
    <div class={`tool-card ${props.entry.isError ? "error" : ""}`}>
      <button class="tool-summary touch" onClick={() => setExpanded((value) => !value)}>
        <span class="tool-name">{props.entry.toolName ?? "tool"}</span>
        <span class="tool-state">{props.entry.isError ? "error" : "result"}</span>
      </button>
      <Show when={!expanded()} fallback={<pre class="tool-full">{props.entry.text}</pre>}>
        <pre class="tool-preview">{preview()}</pre>
      </Show>
    </div>
  );
}
