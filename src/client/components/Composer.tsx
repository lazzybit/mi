import { Show, createSignal } from "solid-js";
import type { JSX } from "@solidjs/web";

export function Composer(props: {
  draft: string;
  busy: boolean;
  onDraft: (value: string) => void;
  onSubmit: (text: string, whenBusy: "followUp" | "steer") => void;
}): JSX.Element {
  const [sending, setSending] = createSignal(false);

  const submit = () => {
    const text = props.draft.trim();
    if (!text) return;
    setSending(true);
    try {
      props.onSubmit(text, "followUp");
      props.onDraft("");
    } finally {
      setSending(false);
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
            submit();
          }
        }}
      />
      <div class="composer-actions">
        <button class="primary touch" disabled={sending()} onClick={() => submit()}>
          Queue
        </button>
        <Show when={props.busy}>
          <button
            class="secondary touch"
            disabled={sending() || props.draft.trim().length === 0}
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
