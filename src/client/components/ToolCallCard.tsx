import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { TranscriptEntryView } from "../../shared/domain";

export function ToolCallCard(props: {
  entry: TranscriptEntryView;
  generation: number;
  onReadArtifact: (artifactId: string) => Promise<string>;
}): JSX.Element {
  const [expanded, setExpanded] = createSignal(false);
  const [full, setFull] = createSignal<string>();

  const toggle = async () => {
    const next = !expanded();
    setExpanded(next);
    if (next && props.entry.artifactId && full() === undefined) {
      const generation = props.generation;
      try {
        const text = await props.onReadArtifact(props.entry.artifactId);
        // ADR-0001: discard an artifact response for a replaced selection.
        if (generation !== props.generation) return;
        setFull(text);
      } catch {
        if (generation !== props.generation) return;
        setFull("Unable to load the full result.");
      }
    }
  };

  const preview = () => {
    const text = props.entry.text ?? "";
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  };

  return (
    <div class={`tool-card ${props.entry.isError ? "error" : ""}`}>
      <button class="tool-summary touch" onClick={() => void toggle()}>
        <span class="tool-name">{props.entry.toolName ?? "tool"}</span>
        <span class="tool-state">{props.entry.isError ? "error" : "result"}</span>
      </button>
      <Show when={!expanded()}>
        <pre class="tool-preview">{preview()}</pre>
      </Show>
      <Show when={expanded()}>
        <pre class="tool-full">{full() ?? props.entry.text ?? ""}</pre>
      </Show>
    </div>
  );
}
