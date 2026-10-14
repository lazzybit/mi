import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { AttemptView } from "../../shared/domain";

// Appears only for a real unresolved remote outcome, never as a generic
// approval screen (PLAN.md -> Client).
export function RecoveryPanel(props: {
  attempt?: AttemptView;
  onResolve: (action: "accept_observed_state" | "abandon" | "retry") => void;
}): JSX.Element {
  return (
    <Show when={props.attempt?.state === "unknown"}>
      <div class="recovery-panel">
        <h3>Unresolved remote operation</h3>
        <p>
          The outcome of <strong>{props.attempt?.toolName ?? "a tool call"}</strong> could not be
          determined. It has not been replayed.
        </p>
        <div class="recovery-actions">
          <button class="secondary touch" onClick={() => props.onResolve("accept_observed_state")}>
            Accept observed state
          </button>
          <button class="secondary touch" onClick={() => props.onResolve("retry")}>
            Retry as a new attempt
          </button>
          <button class="danger touch" onClick={() => props.onResolve("abandon")}>
            Abandon run
          </button>
        </div>
      </div>
    </Show>
  );
}
