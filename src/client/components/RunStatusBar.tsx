import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { LiveSummary } from "../view";
import type { ConnectionStatus } from "../session/SessionFeed";

export function RunStatusBar(props: {
  live: LiveSummary;
  status: ConnectionStatus;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div class="run-status">
      <span class={`connection ${props.status}`}>{props.status}</span>
      <Show when={props.live.active}>
        <span class="run-state">
          running
          <Show when={props.live.attempt}>{(attempt) => ` · attempt ${attempt()}`}</Show>
        </span>
        <button class="link touch" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </Show>
      <Show when={props.live.retryError}>
        {(error) => <span class="run-retry">retrying: {error()}</span>}
      </Show>
    </div>
  );
}
