import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { QueuedInput } from "../view";

export function QueuePanel(props: {
  queued: QueuedInput[];
  onWithdraw: (submissionId: SubmissionId) => void;
}): JSX.Element {
  return (
    <Show when={props.queued.length > 0}>
      <div class="queue-panel">
        <For each={props.queued}>
          {(submission) => (
            <div class="queue-item">
              <span class={`queue-mode ${submission.mode}`}>
                {submission.mode === "steer" ? "steer" : "queue"}
              </span>
              <span class="queue-text">{submission.text}</span>
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
