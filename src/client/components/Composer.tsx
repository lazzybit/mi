import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { RunView } from "../../shared/domain";

export function Composer(props: {
  draft: string;
  activeRun?: RunView;
  onDraft: (value: string) => void;
  onSubmit: (text: string, mode: "queue" | "steer") => void;
}): JSX.Element {
  const [busy, setBusy] = createSignal(false);

  const submit = async () => {
    const text = props.draft.trim();
    if (!text) return;
    setBusy(true);
    try {
      props.onSubmit(text, "queue");
      props.onDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="composer">
      <textarea
        class="composer-input"
        rows={2}
        value={props.draft}
        placeholder="Message"
        onInput={(event) => props.onDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div class="composer-actions">
        <button class="primary touch" disabled={busy()} onClick={() => void submit()}>
          Queue
        </button>
        <Show when={props.activeRun}>
          <button
            class="secondary touch"
            disabled={busy() || props.draft.trim().length === 0}
            onClick={() => {
              props.onSubmit(props.draft.trim(), "steer");
              props.onDraft("");
            }}
          >
            Steer
          </button>
        </Show>
      </div>
    </div>
  );
}
