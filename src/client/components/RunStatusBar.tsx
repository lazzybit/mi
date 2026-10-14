import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { AttemptView, RunView } from "../../shared/domain";
import type { ConnectionStatus } from "../sync/ConversationFeed";

export function RunStatusBar(props: {
  run?: RunView;
  attempt?: AttemptView;
  status: ConnectionStatus;
  onCancel: () => void;
}): JSX.Element {
  return (
    <div class="run-status">
      <span class={`connection ${props.status}`}>{props.status}</span>
      <Show when={props.run}>
        {(run) => (
          <span class="run-state">
            {run().state} · turn {run().turnNumber} · {run().phase}
          </span>
        )}
      </Show>
      <Show when={props.attempt?.toolName}>
        <span class="run-tool">tool: {props.attempt?.toolName}</span>
      </Show>
      <Show when={props.run && !["completed", "cancelled", "failed"].includes(props.run.state)}>
        <button class="link touch" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </Show>
    </div>
  );
}
