import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SubmissionView } from "../../shared/domain";

export function QueuePanel(props: {
  queued: SubmissionView[];
  onWithdraw: (submissionId: string) => void;
}): JSX.Element {
  return (
    <Show when={props.queued.length > 0}>
      <div class="queue-panel">
        <For each={props.queued}>
          {(submission) => (
            <div class="queue-item">
              <span class={`queue-mode ${submission.mode}`}>{submission.mode}</span>
              <span class="queue-text">{submission.content}</span>
              <button class="link touch" onClick={() => props.onWithdraw(submission.id)}>
                Withdraw
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
